import { describe, expect, it } from "vitest";

import type { ChatStreamEvent } from "./types.js";
import { createStreamJsonParser } from "./worker.js";

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
