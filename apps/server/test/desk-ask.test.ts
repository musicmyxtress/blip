import { describe, expect, it } from "vitest";
import type { BrowserControl, BrowserOutlineResult } from "@blip/protocol";
import { askAboutPage, type AskModel } from "../src/desk/ask";

const identity = { captureId: "cap-1", captureRevision: 1, tabId: 7, pageUrl: "https://shop.example/" };

const region = (id: string, label: string, extra: Partial<BrowserOutlineResult["regions"][number]> = {}) => ({
  id, kind: "section" as const, label, level: 2, parentId: null, rect: { x: 0, y: 0, w: 100, h: 100 },
  viewportShare: 0.1, headingPx: 20, textChars: 50, links: 1, buttons: 0, fields: 0, images: 0,
  noise: [] as BrowserOutlineResult["regions"][number]["noise"], preview: label, ...extra,
});

const outline: BrowserOutlineResult = {
  ...identity, status: "supported", title: "Shop", viewport: { w: 1000, h: 800, scrollY: 0 }, pageHeight: 2000, truncated: false,
  regions: [region("r1", "Free plugins"), region("r2", "Advertisement", { noise: ["ad-marker"] })],
};

const vital: BrowserControl = { id: "c1", kind: "link", label: "Vital", host: "shop.example", access: "direct", note: "" };

function scripted(replies: string[]): AskModel & { prompts: string[] } {
  const prompts: string[] = [];
  return { prompts, async call(prompt) { prompts.push(prompt); return replies.shift() ?? "{}"; } };
}

describe("desk ask", () => {
  it("drops unknown region ids and fabricated actions, keeping only listed controls", async () => {
    const model = scripted([
      JSON.stringify({ regions: ["r1", "r999", "javascript:alert(1)"] }),
      JSON.stringify({ answer: "Vital is free.", actions: [{ id: "c1", why: "open it" }, { id: "c42", why: "made up" }, { id: "c1", why: "duplicate" }] }),
    ]);
    const read: string[] = [];
    const result = await askAboutPage(model, {
      async readRegion(id) { read.push(id); return { label: "Free plugins", text: "Vital - free wavetable synth" }; },
      async regionControls() { return [vital]; },
    }, outline, "find a free synth", "which are free?");
    expect(read).toEqual(["r1"]);
    expect(result.regionIds).toEqual(["r1"]);
    expect(result.answer).toBe("Vital is free.");
    expect(result.actions.map((a) => a.control.id)).toEqual(["c1"]);
  });

  it("keeps ads out of the outline it shows the model and marks page text as untrusted", async () => {
    const model = scripted([JSON.stringify({ regions: [] }), JSON.stringify({ answer: "Nothing here." })]);
    await askAboutPage(model, { async readRegion() { return null; }, async regionControls() { return null; } }, outline, "", "anything?");
    expect(model.prompts[0]).toContain("r1 section");
    expect(model.prompts[0]).not.toContain("Advertisement");
    expect(model.prompts[0]).toContain("untrusted data");
  });

  it("removes lines that look like secrets before sending page text", async () => {
    const model = scripted([JSON.stringify({ regions: ["r1"] }), JSON.stringify({ answer: "ok" })]);
    await askAboutPage(model, {
      async readRegion() { return { label: "Account", text: "Welcome back\npassword: hunter2\nYour plan: Pro" }; },
      async regionControls() { return []; },
    }, outline, "", "what plan am I on?");
    expect(model.prompts[1]).toContain("Your plan: Pro");
    expect(model.prompts[1]).not.toContain("hunter2");
  });
});
