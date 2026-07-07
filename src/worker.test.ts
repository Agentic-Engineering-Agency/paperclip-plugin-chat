import { describe, expect, it } from "vitest";

import type { ChatStreamEvent } from "./types.js";
import { adapterTypeLabel, createStreamJsonParser, normalizePluginSettings } from "./worker.js";

function parseLines(...lines: string[]): ChatStreamEvent[] {
  const events: ChatStreamEvent[] = [];
  const parser = createStreamJsonParser((event) => events.push(event));
  parser.push(`${lines.join("\n")}\n`);
  return events;
}

describe("createStreamJsonParser", () => {
  it("emits text for a Claude assistant text delta", () => {
    const events = parseLines(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello from Claude" }] },
      }),
    );

    expect(events).toEqual([{ type: "text", text: "Hello from Claude" }]);
  });

  it("emits text for a non-JSON plain line", () => {
    const events = parseLines("plain adapter output");

    expect(events).toEqual([{ type: "text", text: "plain adapter output" }]);
  });

  it("emits text for an unknown JSON shape", () => {
    const line = JSON.stringify({ adapter: "codex_local", message: "ready" });
    const events = parseLines(line);

    expect(events).toEqual([{ type: "text", text: line }]);
  });

  it("emits result and done terminal events", () => {
    const resultEvents = parseLines(
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 12, output_tokens: 34 },
        total_cost_usd: 0.056,
      }),
    );
    const doneEvents = parseLines(JSON.stringify({ type: "done" }));

    expect(resultEvents).toEqual([
      {
        type: "result",
        usage: { input_tokens: 12, output_tokens: 34 },
        costUsd: 0.056,
      },
    ]);
    expect(doneEvents).toEqual([{ type: "done" }]);
  });
});

describe("adapterTypeLabel", () => {
  it("maps local adapter types to product labels", () => {
    expect(adapterTypeLabel("codex_local")).toBe("Codex");
    expect(adapterTypeLabel("opencode_local")).toBe("OpenCode");
    expect(adapterTypeLabel("omp_local")).toBe("Oh My Pi");
  });

  it("falls back to a readable title for unknown adapter types", () => {
    expect(adapterTypeLabel("custom_adapter")).toBe("Custom Adapter");
  });
});

describe("normalizePluginSettings", () => {
  it("defaults missing or invalid settings while preserving valid false booleans", () => {
    expect(normalizePluginSettings({
      defaultAdapterType: "",
      defaultAgentId: 42,
      defaultModel: "gpt-4.1",
      systemPromptOverride: null,
      streamingEnabled: false,
      showToolCalls: false,
      enrichContext: "yes",
    })).toEqual({
      defaultAdapterType: "claude_local",
      defaultAgentId: "",
      defaultModel: "gpt-4.1",
      systemPromptOverride: "",
      streamingEnabled: false,
      showToolCalls: false,
      enrichContext: true,
    });
  });

  it("normalizes non-object settings to plugin defaults", () => {
    expect(normalizePluginSettings(null)).toEqual({
      defaultAdapterType: "claude_local",
      defaultAgentId: "",
      defaultModel: "",
      systemPromptOverride: "",
      streamingEnabled: true,
      showToolCalls: true,
      enrichContext: true,
    });
  });
});
