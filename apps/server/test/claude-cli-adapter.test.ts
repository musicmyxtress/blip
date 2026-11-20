import { describe, expect, it } from "vitest";
import { claudeCliArgs, classifyClaudeEvent } from "../src/brain/claude/cli-adapter";

describe("Claude CLI adapter isolation", () => {
  it("launches every role with no tools, no MCP servers, no user settings and no slash commands", () => {
    for (const role of ["intent", "repair", "content"] as const) {
      const args = claudeCliArgs(role, "haiku");
      const after = (flag: string) => args[args.indexOf(flag) + 1];
      expect(after("--tools")).toBe("");
      expect(after("--setting-sources")).toBe("");
      expect(args).toContain("--strict-mcp-config");
      expect(args).toContain("--disable-slash-commands");
      expect(args).toContain("--no-session-persistence");
      expect(args).not.toContain("--dangerously-skip-permissions");
      // --bare would drop the subscription login and force pay-per-use API-key auth.
      expect(args).not.toContain("--bare");
    }
  });

  it("classifies a tool_use block as a tool step so the manager stops the role", () => {
    const toolTurn = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } };
    const serverToolTurn = { type: "assistant", message: { content: [{ type: "server_tool_use", name: "web_search" }] } };
    expect(classifyClaudeEvent(toolTurn)).toBe("tool");
    expect(classifyClaudeEvent(serverToolTurn)).toBe("tool");
  });

  it("classifies ordinary stream events", () => {
    expect(classifyClaudeEvent({ type: "system", subtype: "init", tools: [] })).toBe("init");
    expect(classifyClaudeEvent({ type: "assistant", message: { content: [{ type: "text", text: "{}" }] } })).toBe("assistant");
    expect(classifyClaudeEvent({ type: "result", result: "{}" })).toBe("result");
    expect(classifyClaudeEvent("not an object")).toBe("other");
  });
});
