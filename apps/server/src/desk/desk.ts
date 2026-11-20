// Desk API: the local HTTP surface for the native (WinForms) front end.
//
// Security model:
// - Bound to 127.0.0.1 by the server, and the server's Host check still runs first.
// - Every request must carry `Authorization: Bearer <token>`. The token is random per server run
//   and written to a file under the user's profile, which only that Windows user can read.
// - Any request with an Origin header is refused: browsers always send Origin on cross-origin
//   requests, so a web page can never drive the desk even if it guessed the port.
// - Read-only for now: outline and region reads go through the same BrowserExecutor (and the
//   extension's identity/staleness checks) as every other browser operation.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserOutlineResult, BrowserPageIdentity } from "@blip/protocol";
import type { BrowserExecutor } from "../browser/executor";
import { log } from "../log";

export type DeskOptions = {
  executor: () => BrowserExecutor;
  /** Where the bearer token is written; defaults to %LOCALAPPDATA%\BlipDesk\desk-token (or ~/.blip-desk). */
  tokenPath?: string;
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

export async function createDeskApi(options: DeskOptions): Promise<DeskApi> {
  const token = randomBytes(32).toString("base64url");
  const tokenPath = options.tokenPath ?? defaultDeskTokenPath();
  await mkdir(dirname(tokenPath), { recursive: true });
  // mode 0o600 matters on macOS/Linux; on Windows the file inherits the user-only profile ACL.
  await writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 });

  /** Identity of the latest outline: region ids are only valid against the outline that issued them. */
  let outlineIdentity: BrowserPageIdentity | null = null;

  async function outline(res: ServerResponse): Promise<void> {
    const result = await options.executor().execute({ op: "outline" });
    if (!result.ok) return send(res, 503, { ok: false, error: result.reason });
    const payload = result.payload;
    if (!payload.ok) return send(res, 502, { ok: false, error: payload.error.code, message: payload.error.message });
    if (payload.operation !== "outline") return send(res, 502, { ok: false, error: "invalid-result" });
    const outlineResult: BrowserOutlineResult = payload.result;
    const { captureId, captureRevision, tabId, pageUrl } = outlineResult;
    outlineIdentity = { captureId, captureRevision, tabId, pageUrl };
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
        else send(res, 404, { ok: false, error: "not-found" });
      } catch (error) {
        log("warn", { msg: "desk request failed", code: error instanceof Error ? error.name : "unknown" });
        if (!res.headersSent) send(res, 500, { ok: false, error: "exception" });
      }
      return true;
    },
  };
}
