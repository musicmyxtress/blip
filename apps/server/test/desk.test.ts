import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeskApi } from "../src/desk/desk";
import type { BrowserExecutor } from "../src/browser/executor";

type Captured = { status: number; body: unknown };

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    headersSent: false,
    writeHead(status: number) { captured.status = status; return res; },
    end(text: string) { captured.body = JSON.parse(text); },
  } as unknown as ServerResponse;
  return { res, captured };
}

function fakeReq(headers: Record<string, string>, method = "GET"): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

const neverCalled: BrowserExecutor = { execute: async () => { throw new Error("executor must not run"); } };

describe("desk API access control", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  async function desk() {
    dir = await mkdtemp(join(tmpdir(), "blip-desk-test-"));
    return createDeskApi({ executor: () => neverCalled, tokenPath: join(dir, "desk-token") });
  }

  it("writes a random token file", async () => {
    const api = await desk();
    expect(await readFile(api.tokenPath, "utf8")).toBe(api.token);
    expect(api.token.length).toBeGreaterThanOrEqual(40);
  });

  it("refuses requests without the token, with a wrong token, or from a browser origin", async () => {
    const api = await desk();
    const params = new URLSearchParams();
    for (const [headers, expected] of [
      [{}, 401],
      [{ authorization: "Bearer wrong" }, 401],
      [{ authorization: `Bearer ${api.token}`, origin: "https://evil.example" }, 403],
    ] as const) {
      const { res, captured } = fakeRes();
      expect(await api.handle(fakeReq(headers), res, "/desk/outline", params)).toBe(true);
      expect(captured.status).toBe(expected);
    }
  });

  it("rejects malformed region ids before touching the browser", async () => {
    const api = await desk();
    const { res, captured } = fakeRes();
    await api.handle(fakeReq({ authorization: `Bearer ${api.token}` }), res, "/desk/region", new URLSearchParams({ id: "../etc" }));
    expect(captured.status).toBe(400);
  });

  it("ignores non-desk paths", async () => {
    const api = await desk();
    const { res } = fakeRes();
    expect(await api.handle(fakeReq({}), res, "/healthz", new URLSearchParams())).toBe(false);
  });
});
