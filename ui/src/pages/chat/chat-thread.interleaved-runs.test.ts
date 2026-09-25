// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { insertChatItemsByTimestamp } from "./chat-thread-items.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

type ChatItemsProps = Parameters<typeof buildCachedChatItems>[0];
const paneIds: string[] = [];

function createProps(overrides: Partial<ChatItemsProps> = {}): ChatItemsProps {
  const paneId = `interleaved-runs-${paneIds.length}`;
  paneIds.push(paneId);
  return {
    paneId,
    sessionKey: "main",
    runId: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}

afterEach(() => {
  for (const paneId of paneIds.splice(0)) {
    resetChatThreadState(paneId);
  }
});

describe("interleaved assistant runs", () => {
  it("ignores a sibling-run keyed segment when trimming the active item", () => {
    const items = buildCachedChatItems(
      createProps({
        runId: "run-active",
        streamSegments: [
          {
            text: "First thought.",
            ts: 1,
            runId: "run-active",
            itemId: "active-item",
            itemStartOffset: 0,
            cumulative: true,
          },
          { text: "Sibling thought.", ts: 2, runId: "run-sibling", itemId: "sibling-item" },
        ],
        stream: "First thought.\n\nContinued.",
        streamItemId: "active-item",
        streamStartedAt: 3,
      }),
    );

    expect(items.flatMap((item) => (item.kind === "stream" ? [item.text] : []))).toEqual([
      "First thought.",
      "Sibling thought.",
      "Continued.",
    ]);
  });

  it("keeps sibling-run item ownership out of active cumulative resets", () => {
    const items = buildCachedChatItems(
      createProps({
        runId: "run-active",
        streamSegments: [
          {
            text: "Hello",
            ts: 1,
            runId: "run-active",
            itemId: "active-item",
            itemStartOffset: 0,
            cumulative: true,
          },
          { text: "Sibling", ts: 2, runId: "run-sibling", itemId: "sibling-item" },
          {
            text: "Hello world",
            ts: 3,
            runId: "run-active",
            itemId: "active-item",
            itemStartOffset: 0,
            cumulative: true,
          },
        ],
      }),
    );

    expect(items.flatMap((item) => (item.kind === "stream" ? [item.text] : []))).toEqual([
      "Hello",
      "Sibling",
      "world",
    ]);
  });

  it("resumes each run from its own cumulative baseline", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "Hello", ts: 1, runId: "run-a", cumulative: true },
          { text: "Sibling", ts: 2, runId: "run-b", cumulative: true },
          { text: "Hello world", ts: 3, runId: "run-a", cumulative: true },
        ],
      }),
    );

    expect(items.flatMap((item) => (item.kind === "stream" ? [item.text] : []))).toEqual([
      "Hello",
      "Sibling",
      "world",
    ]);
  });

  it("keeps each positional tool after its legacy segment without cross-run ordering", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "Before one", ts: 100, runId: "run-one" },
          { text: "Before two", ts: 200, runId: "run-two" },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-1",
            content: "Tool one",
            timestamp: 300,
            runId: "run-one",
          },
          {
            role: "toolResult",
            toolCallId: "call-2",
            content: "Tool two",
            timestamp: 50,
            runId: "run-two",
          },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "Before one" },
      { kind: "stream", text: "Before two" },
      { kind: "group", role: "tool" },
      { kind: "group", role: "tool" },
    ]);
  });

  it("does not carry a positional tool predecessor into a sibling run", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "S", ts: 100, runId: "run-a" },
          { text: "B", ts: 50, runId: "run-b" },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-a",
            content: "T",
            timestamp: 200,
            runId: "run-a",
          },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "B" },
      { kind: "stream", text: "S" },
      { kind: "group", role: "tool" },
    ]);
  });

  it("does not let a sibling keyed item claim another run's positional tool", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          {
            text: "B",
            ts: 50,
            runId: "run-b",
            itemId: "commentary-b",
            itemStartOffset: 0,
            cumulative: true,
          },
          { text: "A", ts: 100, runId: "run-a" },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-a",
            content: "T",
            timestamp: 75,
            runId: "run-a",
          },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "B" },
      { kind: "stream", text: "A" },
      { kind: "group", role: "tool" },
    ]);
  });

  it("reserves a keyed segment's explicit tool from an earlier item rollover", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          {
            text: "Rollover",
            ts: 50,
            runId: "run-a",
            itemId: "item-a",
            itemStartOffset: 0,
            cumulative: true,
          },
          { text: "Owner", ts: 100, runId: "run-a", itemId: "item-b", toolCallId: "call-a" },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-a",
            content: "T",
            timestamp: 75,
            runId: "run-a",
          },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "Rollover" },
      { kind: "stream", text: "Owner" },
      { kind: "group", role: "tool" },
    ]);
  });

  it("anchors an explicit tool from a repeated snapshot to prior visible text", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "A", ts: 100, runId: "run-a", cumulative: true },
          { text: "A", ts: 110, runId: "run-a", cumulative: true, toolCallId: "call-a" },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-a",
            content: "T",
            timestamp: 50,
            runId: "run-a",
          },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "A" },
      { kind: "group", role: "tool" },
    ]);
  });

  it("advances from a divergent metadata-free cumulative baseline", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          {
            text: "A",
            ts: 100,
            runId: "run-a",
            itemId: "item-a",
            itemStartOffset: 0,
            cumulative: true,
          },
          { text: "B", ts: 110, runId: "run-a" },
          {
            text: "B more",
            ts: 120,
            runId: "run-a",
            itemId: "item-b",
            cumulative: true,
          },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "A" },
      { kind: "stream", text: "B" },
      { kind: "stream", text: "more" },
    ]);
  });

  it("orders a timestamp-free tool with its predecessor timestamp", () => {
    const items: ChatItem[] = [
      { kind: "message", key: "H", message: { role: "assistant", content: "H", timestamp: 200 } },
    ];
    insertChatItemsByTimestamp(items, [
      { item: { kind: "stream", key: "S", text: "S", startedAt: 100, isStreaming: false } },
      {
        item: { kind: "message", key: "T", message: { role: "toolResult", content: "T" } },
        predecessorKey: "S",
      },
      { item: { kind: "stream", key: "C", text: "C", startedAt: 50, isStreaming: false } },
    ]);

    expect(items.map((item) => item.key)).toEqual(["C", "S", "T", "H"]);
  });

  it("does not count a persisted cumulative baseline as a positional tool", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "Before first", ts: 100, runId: "run", cumulative: true, persisted: true },
          { text: "Before first\nBefore second", ts: 200, runId: "run", cumulative: true },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-2",
            content: "Tool two",
            timestamp: 50,
            runId: "run",
          },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "Before second" },
      { kind: "group", role: "tool" },
    ]);
  });
});
