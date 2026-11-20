// Desk API: the local HTTP surface for the native (WinForms) front end.
//
// Security model:
// - Bound to 127.0.0.1 by the server, and the server's Host check still runs first.
// - Every request must carry `Authorization: Bearer <token>`. The token is random per server run
//   and written to a file under the user's profile, which only that Windows user can read.
// - Any request with an Origin header is refused: browsers always send Origin on cross-origin
//   requests, so a web page can never drive the desk even if it guessed the port.
// - Every read and action goes through the same BrowserExecutor (and the extension's identity and
//   staleness checks) as every other browser operation. Field writes never submit, and password or
//   card fields are refused in the extension, which is the one place that can see them.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { newId, type BrowserOutlineResult, type BrowserPageIdentity } from "@blip/protocol";
import type { BrowserExecutor } from "../browser/executor";
import { log } from "../log";
import { startClaudeJsonSession } from "../brain/claude/cli-adapter";
import { ASK_INSTRUCTIONS, askAboutPage, type AskModel } from "./ask";

export type DeskOptions = {
  executor: () => BrowserExecutor;
  /** Where the bearer token is written; defaults to %LOCALAPPDATA%\BlipDesk\desk-token (or ~/.blip-desk). */
  tokenPath?: string;
  /** Enables POST /desk/ask using a tool-less Claude CLI session (started on first use). */
  claude?: boolean;
  /** Test seam: supply the Ask model directly. */
  askModel?: AskModel;
};

export type DeskApi = {
  token: string;
  tokenPath: string;
  /** Returns true when the request was a desk route (handled, successfully or not). */
  handle(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<boolean>;
};

export function defaultDeskTokenPath(): string {
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "BlipDesk") : join(homedir(), ".blip-desk");
  return join(base, "desk-token");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const REGION_ID = /^r[0-9]{1,9}(\.[0-9]{1,4})?$/;
const CONTROL_ID = /^c[0-9]{1,9}$/;
const FIELD_ID = /^f[0-9]{1,9}$/;
/** Room for a long description typed into one field (10,000 characters, JSON-escaped). */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 10_000;
const MAX_ASK_CHARS = 500;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body-too-large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function createDeskApi(options: DeskOptions): Promise<DeskApi> {
  const token = randomBytes(32).toString("base64url");
  const tokenPath = options.tokenPath ?? defaultDeskTokenPath();
  await mkdir(dirname(tokenPath), { recursive: true });
  // mode 0o600 matters on macOS/Linux; on Windows the file inherits the user-only profile ACL.
  await writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 });

  /** Identity of the latest outline: region ids are only valid against the outline that issued them. */
  let outlineIdentity: BrowserPageIdentity | null = null;
  let outlineTitle = "";
  let lastOutline: BrowserOutlineResult | null = null;
  let askModel: Promise<AskModel> | null = options.askModel ? Promise.resolve(options.askModel) : null;
  let asking = false;
  /**
   * Pages the user left by following a link from the desk, newest last. Back only ever navigates to
   * an address recorded here (where the user actually was), never to one taken from a page or model.
   */
  const history: Array<{ tabId: number; url: string; title: string }> = [];
  const MAX_HISTORY = 50;

  async function outline(res: ServerResponse): Promise<void> {
    const result = await options.executor().execute({ op: "outline" });
    if (!result.ok) return send(res, 503, { ok: false, error: result.reason });
    const payload = result.payload;
    if (!payload.ok) return send(res, 502, { ok: false, error: payload.error.code, message: payload.error.message });
    if (payload.operation !== "outline") return send(res, 502, { ok: false, error: "invalid-result" });
    const outlineResult: BrowserOutlineResult = payload.result;
    const { captureId, captureRevision, tabId, pageUrl } = outlineResult;
    outlineIdentity = { captureId, captureRevision, tabId, pageUrl };
    outlineTitle = outlineResult.title;
    lastOutline = outlineResult;
    send(res, 200, { ok: true, outline: outlineResult });
  }

  async function region(res: ServerResponse, id: string | null): Promise<void> {
    if (id === null || !REGION_ID.test(id)) return send(res, 400, { ok: false, error: "invalid-region-id" });
    if (outlineIdentity === null) return send(res, 409, { ok: false, error: "no-outline", message: "Build an outline first." });
    const result = await options.executor().execute({ op: "read-region", regionId: id, identity: outlineIdentity });
    if (!result.ok) return send(res, 503, { ok: false, error: result.reason });
    const payload = result.payload;
    if (!payload.ok) return send(res, payload.error.code === "stale-page" ? 409 : 502, { ok: false, error: payload.error.code, message: payload.error.message });
    if (payload.operation !== "read-region") return send(res, 502, { ok: false, error: "invalid-result" });
    send(res, 200, { ok: true, region: payload.result });
  }

  async function controls(res: ServerResponse, id: string | null): Promise<void> {
    if (id === null || !REGION_ID.test(id)) return send(res, 400, { ok: false, error: "invalid-region-id" });
    if (outlineIdentity === null) return send(res, 409, { ok: false, error: "no-outline", message: "Build an outline first." });
    const result = await options.executor().execute({ op: "region-controls", regionId: id, identity: outlineIdentity });
    if (!result.ok) return send(res, 503, { ok: false, error: result.reason });
    const payload = result.payload;
    if (!payload.ok) return send(res, payload.error.code === "stale-page" ? 409 : 502, { ok: false, error: payload.error.code, message: payload.error.message });
    if (payload.operation !== "region-controls") return send(res, 502, { ok: false, error: "invalid-result" });
    send(res, 200, { ok: true, controls: payload.result });
  }

  async function activate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { ok: false, error: "invalid-body" }); }
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const id = typeof record.id === "string" ? record.id : "";
    const confirmed = record.confirm === true;
    if (!CONTROL_ID.test(id)) return send(res, 400, { ok: false, error: "invalid-control-id" });
    if (outlineIdentity === null) return send(res, 409, { ok: false, error: "no-outline", message: "Build an outline first." });
    const leaving = { tabId: outlineIdentity.tabId, url: outlineIdentity.pageUrl, title: outlineTitle };
    const result = await options.executor().execute({ op: "activate-control", controlId: id, identity: outlineIdentity, confirmed });
    if (!result.ok) return send(res, 503, { ok: false, error: result.reason });
    const payload = result.payload;
    if (!payload.ok) return send(res, payload.error.code === "unauthorized" ? 403 : payload.error.code === "stale-page" ? 409 : 502, { ok: false, error: payload.error.code, message: payload.error.message });
    if (payload.operation !== "activate-control") return send(res, 502, { ok: false, error: "invalid-result" });
    // The page may now be different: region and control ids from the old outline are void.
    if (payload.result.kind === "link") {
      outlineIdentity = null;
      history.push(leaving);
      if (history.length > MAX_HISTORY) history.shift();
    }
    send(res, 200, { ok: true, activated: payload.result });
  }

  /** Sends the result of a field operation, mapping extension errors to HTTP statuses. */
  function sendFieldResult(res: ServerResponse, result: Awaited<ReturnType<BrowserExecutor["execute"]>>, op: string, key: string): void {
    if (!result.ok) return send(res, 503, { ok: false, error: result.reason });
    const payload = result.payload;
    if (!payload.ok) {
      const status = payload.error.code === "stale-page" || payload.error.code === "stale-capture" ? 409 : payload.error.code === "invalid-target" ? 422 : 502;
      return send(res, status, { ok: false, error: payload.error.code, message: payload.error.message });
    }
    if (payload.operation !== op) return send(res, 502, { ok: false, error: "invalid-result" });
    send(res, 200, { ok: true, [key]: payload.result });
  }

  async function fields(res: ServerResponse, id: string | null): Promise<void> {
    const regionId = id === null || id === "page" ? null : id;
    if (regionId !== null && !REGION_ID.test(regionId)) return send(res, 400, { ok: false, error: "invalid-region-id" });
    if (outlineIdentity === null) return send(res, 409, { ok: false, error: "no-outline", message: "Build an outline first." });
    const result = await options.executor().execute({ op: "region-fields", regionId, identity: outlineIdentity });
    sendFieldResult(res, result, "region-fields", "fields");
  }

  async function fieldOptions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { ok: false, error: "invalid-body" }); }
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const id = typeof record.id === "string" ? record.id : "";
    const filter = typeof record.filter === "string" ? record.filter.slice(0, 200) : "";
    if (!FIELD_ID.test(id)) return send(res, 400, { ok: false, error: "invalid-field-id" });
    if (outlineIdentity === null) return send(res, 409, { ok: false, error: "no-outline", message: "Build an outline first." });
    const result = await options.executor().execute({ op: "field-options", fieldId: id, filter, identity: outlineIdentity });
    sendFieldResult(res, result, "field-options", "options");
  }

  async function setField(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { ok: false, error: "invalid-body" }); }
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const id = typeof record.id === "string" ? record.id : "";
    if (!FIELD_ID.test(id)) return send(res, 400, { ok: false, error: "invalid-field-id" });
    const change =
      typeof record.value === "string" ? { value: record.value.slice(0, MAX_FIELD_CHARS) }
      : typeof record.checked === "boolean" ? { checked: record.checked }
      : typeof record.option === "number" && Number.isInteger(record.option) && record.option >= 0 && record.option <= 999 ? { option: record.option }
      : null;
    if (change === null) return send(res, 400, { ok: false, error: "invalid-change", message: "Send a value, checked, or option." });
    if (outlineIdentity === null) return send(res, 409, { ok: false, error: "no-outline", message: "Build an outline first." });
    const result = await options.executor().execute({ op: "set-field", fieldId: id, identity: outlineIdentity, ...change });
    sendFieldResult(res, result, "set-field", "set");
  }

  function model(): Promise<AskModel> {
    if (askModel === null) {
      askModel = startClaudeJsonSession({ name: "blip-desk-ask", instructions: ASK_INSTRUCTIONS, model: "sonnet" });
      askModel.catch(() => { askModel = null; });
    }
    return askModel;
  }

  async function ask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!options.claude && !options.askModel) return send(res, 501, { ok: false, error: "no-ai", message: "Ask needs Blip started with the Claude brain." });
    let body: unknown;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { ok: false, error: "invalid-body" }); }
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const goal = typeof record.goal === "string" ? record.goal.trim().slice(0, MAX_ASK_CHARS) : "";
    let question = typeof record.question === "string" ? record.question.trim().slice(0, MAX_ASK_CHARS) : "";
    if (question === "" && goal === "") return send(res, 400, { ok: false, error: "empty-question", message: "Type a question or a goal first." });
    if (question === "") question = "What on this page helps with my goal, and what should I do next?";
    if (outlineIdentity === null || lastOutline === null) return send(res, 409, { ok: false, error: "no-outline", message: "Press F5 for the page outline first." });
    if (asking) return send(res, 409, { ok: false, error: "busy", message: "Still working on the last question." });
    asking = true;
    const identity = outlineIdentity;
    try {
      const executor = options.executor();
      const result = await askAboutPage(await model(), {
        async readRegion(id) {
          const read = await executor.execute({ op: "read-region", regionId: id, identity });
          return read.ok && read.payload.ok && read.payload.operation === "read-region" ? read.payload.result : null;
        },
        async regionControls(id) {
          const read = await executor.execute({ op: "region-controls", regionId: id, identity });
          return read.ok && read.payload.ok && read.payload.operation === "region-controls" ? read.payload.result.controls : null;
        },
      }, lastOutline, goal, question);
      send(res, 200, { ok: true, ask: result });
    } catch (error) {
      log("warn", { msg: "desk ask failed", code: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
      send(res, 502, { ok: false, error: "ai-failed", message: "Claude couldn't answer just now. Try again in a moment." });
    } finally { asking = false; }
  }

  async function back(res: ServerResponse): Promise<void> {
    const previous = history.at(-1);
    if (previous === undefined) return send(res, 409, { ok: false, error: "no-history", message: "There's no earlier page to go back to." });
    const result = await options.executor().execute({ op: "navigate", url: previous.url, authorizationId: newId() });
    if (!result.ok) return send(res, 503, { ok: false, error: result.reason });
    const payload = result.payload;
    if (!payload.ok) return send(res, 502, { ok: false, error: payload.error.code, message: payload.error.message });
    history.pop();
    outlineIdentity = null;
    send(res, 200, { ok: true, back: { url: previous.url, title: previous.title } });
  }

  return {
    token,
    tokenPath,
    async handle(req, res, pathname, search) {
      if (!pathname.startsWith("/desk/")) return false;
      if (req.headers.origin !== undefined) {
        log("warn", { msg: "desk request with an Origin header refused" });
        send(res, 403, { ok: false, error: "browser-origin" });
        return true;
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        send(res, 401, { ok: false, error: "unauthorized" });
        return true;
      }
      try {
        if (req.method === "GET" && pathname === "/desk/outline") await outline(res);
        else if (req.method === "GET" && pathname === "/desk/region") await region(res, search.get("id"));
        else if (req.method === "GET" && pathname === "/desk/controls") await controls(res, search.get("id"));
        else if (req.method === "POST" && pathname === "/desk/activate") await activate(req, res);
        else if (req.method === "GET" && pathname === "/desk/fields") await fields(res, search.get("id"));
        else if (req.method === "POST" && pathname === "/desk/field-options") await fieldOptions(req, res);
        else if (req.method === "POST" && pathname === "/desk/set-field") await setField(req, res);
        else if (req.method === "POST" && pathname === "/desk/back") await back(res);
        else if (req.method === "POST" && pathname === "/desk/ask") await ask(req, res);
        else send(res, 404, { ok: false, error: "not-found" });
      } catch (error) {
        log("warn", { msg: "desk request failed", code: error instanceof Error ? error.name : "unknown" });
        if (!res.headersSent) send(res, 500, { ok: false, error: "exception" });
      }
      return true;
    },
  };
}
