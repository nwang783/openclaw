import { expect, it, vi } from "vitest";
import { updateChatRunProgressSnapshot } from "./server-chat-progress-snapshot.js";
import { boundInFlightRunSnapshotForChatHistory } from "./server-methods/chat-history-budget.js";

it.each([2, 50])("keeps the newest %i progress events with bounded serialization", (retained) => {
  let progress: ReturnType<typeof updateChatRunProgressSnapshot>;
  for (let index = 0; index < 50; index++) {
    progress = updateChatRunProgressSnapshot(progress, {
      runId: "run-budget",
      seq: index + 1,
      stream: "tool",
      ts: 1_000 + index,
      data: {
        phase: "result",
        name: "read",
        toolCallId: `tool-${index}`,
        result: '漢字\n"\\'.repeat(200),
      },
    });
  }
  const events = progress?.events ?? [];
  expect(events).toHaveLength(50);
  const snapshot = { runId: "run-budget", text: "x".repeat(200_000), startedAt: 1_000, events };
  const original = JSON.stringify(snapshot);
  const expected = { ...snapshot, text: "", events: events.slice(-retained) };
  const maxBytes = 2 + Buffer.byteLength(JSON.stringify(expected));
  const inputBytes = 2 + Buffer.byteLength(original);
  const stringify = JSON.stringify;
  let serializedBytes = 0;
  const serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
    const result = stringify(...args);
    serializedBytes += typeof result === "string" ? Buffer.byteLength(result) : 0;
    return result;
  });
  let result;
  try {
    result = boundInFlightRunSnapshotForChatHistory({ snapshot, messages: [], maxBytes });
  } finally {
    serialization.mockRestore();
  }
  expect(result).toEqual(expected);
  expect(2 + Buffer.byteLength(JSON.stringify(result))).toBe(maxBytes);
  expect(JSON.stringify(snapshot)).toBe(original);
  expect(serializedBytes).toBeLessThan(inputBytes * 3);
});

it("keeps fitting in-flight text when its optional item boundary exceeds the budget", () => {
  const text = "recoverable assistant text";
  const textOnly = { runId: "run-budget", text };
  const snapshot = {
    ...textOnly,
    itemId: "commentary-boundary-that-does-not-fit",
    itemStartOffset: 0,
  };
  const maxBytes = Buffer.byteLength(JSON.stringify([textOnly]));

  expect(boundInFlightRunSnapshotForChatHistory({ snapshot, messages: [], maxBytes })).toEqual(
    textOnly,
  );
});
