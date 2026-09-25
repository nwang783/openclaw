import { describe, expect, it } from "vitest";
import { extractText } from "../../lib/chat/message-extract.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { rolloverChatStream } from "./stream-causal-boundary.ts";

function createChatState(): ReturnType<typeof makeChatHost> {
  return makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
}

function renderedTexts(host: ChatState, toolMessages: unknown[] = []) {
  return buildChatItems({
    paneId: "commentary-boundaries",
    sessionKey: host.sessionKey,
    runId: host.chatRunId,
    messages: host.chatMessages ?? [],
    toolMessages,
    streamSegments: host.chatStreamSegments ?? [],
    stream: host.chatStream,
    streamItemId: host.chatStreamItemId,
    streamItemPrefix: host.chatStreamItemPrefix,
    streamStartedAt: host.chatStreamStartedAt,
    showToolCalls: true,
  }).flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message }) => extractText(message))
      : item.kind === "stream"
        ? [item.text.trim()]
        : [],
  );
}

function persistCommentary(
  host: ChatState,
  text: string,
  itemId = "commentary-1",
  messageId = "saved-commentary",
) {
  applySessionMessagePayload(
    host,
    {
      runId: "run-1",
      messageId,
      messageSeq: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        __openclaw: { id: messageId, seq: 1, runId: "run-1" },
        openclawStreamFallback: { source: "segment", itemId },
      },
    },
    true,
    { kind: "live", activeRunId: "run-1" },
  );
}

describe("assistant item boundaries in cumulative chat deltas", () => {
  it("retires one item's revisions across an interleaved sibling run", () => {
    const host = createChatState();
    host.chatStreamSegments = [
      {
        text: "Hel",
        ts: 1,
        runId: "run-1",
        itemId: "commentary-1",
        itemStartOffset: 0,
        cumulative: true,
      },
      { text: "Sibling", ts: 2, runId: "run-sibling", itemId: "sibling-item" },
      {
        text: "Hello",
        ts: 3,
        runId: "run-1",
        itemId: "commentary-1",
        itemStartOffset: 0,
        cumulative: true,
      },
    ];

    persistCommentary(host, "Hello");

    expect(renderedTexts(host)).toEqual(["Sibling", "Hello"]);
  });

  it("does not let a pending receipt consume another item's identical delta", () => {
    const text = "Two items can say the same thing.";
    const host = createChatState();

    persistCommentary(host, text);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(2);
  });

  it.each([0, undefined])(
    "keeps identical text from consecutive keyed items (offset=%s)",
    (itemStartOffset) => {
      const text = "Two live items can say the same thing.";
      const host = createChatState();

      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq: 1,
        state: "delta",
        itemId: "commentary-1",
        itemStartOffset: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq: 2,
        state: "delta",
        itemId: "commentary-2",
        itemStartOffset,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });

      expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(2);
      rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
      expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(2);
    },
  );

  it("completes the prior item from the next cumulative prefix", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: "Hello\n\n".length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello\n\nNext" }],
      },
    });

    expect(renderedTexts(host)).toEqual(["Hello", "Next"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    expect(renderedTexts(host)).toEqual(["Hello", "Next"]);
  });

  it("uses an exact active baseline for an offset-less cumulative extension", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "A" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nB" }] },
    });
    expect(renderedTexts(host)).toEqual(["A", "B"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    expect(renderedTexts(host)).toEqual(["A", "B"]);
  });

  it("uses a rolled baseline for an offset-less cumulative extension", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "A" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nB" }] },
    });

    expect(renderedTexts(host)).toEqual(["A", "B"]);
  });

  it("does not guess an item boundary inside an offset-less partial extension", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      message: { role: "assistant", content: [{ type: "text", text: "Hello\n\nNext" }] },
    });

    expect(renderedTexts(host)).toEqual(["Hello\n\nNext"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    expect(renderedTexts(host)).toEqual(["Hello\n\nNext"]);
  });

  it("keeps an offset-less single-paragraph extension in one item", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });

    expect(renderedTexts(host)).toEqual(["Hello"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    expect(renderedTexts(host)).toEqual(["Hello"]);
  });

  it("completes an unkeyed partial from an explicit producer offset", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      itemStartOffset: "Hello\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "Hello\n\nNext" }] },
    });

    expect(renderedTexts(host)).toEqual(["Hello", "Next"]);
  });

  it("completes a partial item when the next received offset skips an item", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-c",
      itemStartOffset: "Hello\n\nmiddle\n\n".length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello\n\nmiddle\n\nNext" }],
      },
    });

    expect(renderedTexts(host)).toEqual(["Hello", "middle\n\nNext"]);
  });

  it("keeps ambiguous paragraph growth visible without assigning its owner", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: "Hello\n\nworld\n\n".length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello\n\nworld\n\nNext" }],
      },
    });

    expect(renderedTexts(host)).toEqual(["Hello", "world\n\nNext"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    expect(renderedTexts(host)).toEqual(["Hello", "world", "Next"]);
  });

  it("continues text restored without its budgeted item boundary", () => {
    const host = createChatState();
    host.chatStream = "Hello";
    host.chatStreamRecoveredWithoutItemId = true;
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    });

    expect(renderedTexts(host)).toEqual(["Hello world"]);
  });

  it("replaces text restored without its budgeted item boundary", () => {
    const host = createChatState();
    host.chatStream = "Hello";
    host.chatStreamRecoveredWithoutItemId = true;
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      replace: true,
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    });

    expect(renderedTexts(host)).toEqual(["Hi"]);
  });

  it("resets a replaced projection owned by the same keyed item", () => {
    const host = createChatState();
    const delta = (seq: number, text: string) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId: "commentary-1",
        itemStartOffset: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });

    delta(1, "foo");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "bar");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    delta(3, "bar baz");

    expect(renderedTexts(host)).toEqual(["foo", "bar", "baz"]);
  });

  it("hides a stale live tail when its rolled item becomes durable", () => {
    const host = createChatState();
    const delta = (seq: number, text: string) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId: "commentary-1",
        itemStartOffset: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });

    delta(1, "Hello");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "Hello wo");
    persistCommentary(host, "Hello world");

    expect(renderedTexts(host)).toEqual(["Hello world"]);
  });

  it("retires a persistence-first item when its distinct delta arrives later", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "A" }] },
    });
    persistCommentary(host, "B", "commentary-2", "saved-second");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: "A\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nB" }] },
    });
    expect(renderedTexts(host)).toEqual(["A", "B"]);
  });

  it("keeps a sibling run out of a persistence-first receipt baseline", () => {
    const host = createChatState();
    host.chatStreamSegments = [{ text: "Sibling", ts: 1, runId: "run-sibling" }];

    persistCommentary(host, "Saved", "commentary-1");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Saved" }] },
    });

    const texts = renderedTexts(host);
    expect(texts).toHaveLength(2);
    expect(new Set(texts)).toEqual(new Set(["Saved", "Sibling"]));
  });

  it("settles a rolled partial item when its completed delta arrives later", () => {
    const earlier = "Earlier";
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: `${earlier}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${earlier}\n\nHel` }],
      },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, "Hello", "commentary-1");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${earlier}\n\nHello\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${earlier}\n\nHello\n\nNext` }],
      },
    });

    expect(renderedTexts(host)).toEqual([earlier, "Hello", "Next"]);
  });

  it("keeps a reset keyed item whose text starts with the previous item after rollover", () => {
    const first = "yes";
    const second = "yes again";
    const host = createChatState();

    for (const [seq, itemId, text] of [
      [1, "commentary-1", first],
      [2, "commentary-2", second],
    ] as const) {
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId,
        itemStartOffset: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    }
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("keeps a tool after the keyed item that introduced it", () => {
    const host = createChatState();
    for (const [seq, itemId, text] of [
      [1, "commentary-1", "first"],
      [2, "commentary-2", "second"],
    ] as const) {
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId,
        itemStartOffset: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    }
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });

    const toolMessages = [
      {
        role: "toolResult",
        content: "tool result",
        timestamp: Date.now(),
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "read",
      },
    ];
    expect(renderedTexts(host, toolMessages)).toEqual(["first", "second", "tool result"]);
    host.chatStreamSegments = [
      ...(host.chatStreamSegments ?? []),
      { text: "second update", ts: Date.now(), runId: "run-1", toolCallId: "call-1" },
    ];
    expect(renderedTexts(host, toolMessages).filter((text) => text === "tool result")).toHaveLength(
      1,
    );
  });

  it("keeps a recurring keyed item whole after an intervening reset owner", () => {
    const host = createChatState();
    for (const [seq, itemId, text] of [
      [1, "commentary-a", "yes"],
      [2, "commentary-b", "between"],
      [3, "commentary-a", "yes again"],
    ] as const) {
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId,
        itemStartOffset: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    }

    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, "yes", "commentary-a");

    const texts = renderedTexts(host);
    expect(texts).toHaveLength(3);
    expect(texts).toEqual(expect.arrayContaining(["yes", "between", "yes again"]));
  });

  it("keeps a recurring keyed reset whole after an intervening cumulative owner", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "yes" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      itemStartOffset: "yes\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "yes\n\nbetween" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "yes again" }] },
    });

    expect(renderedTexts(host)).toEqual(["yes", "between", "yes again"]);
  });

  it("preserves an unrelated later rollover that reuses the persisted item ID", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "foo" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "bar" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    persistCommentary(host, "foo", "commentary-a");

    expect(renderedTexts(host)).toEqual(expect.arrayContaining(["foo", "bar"]));
  });

  it("preserves a prefix-compatible later rollover that reuses the persisted item ID", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "yes" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "yes again" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });

    persistCommentary(host, "yes", "commentary-a");

    expect(renderedTexts(host)).toEqual(expect.arrayContaining(["yes", "again"]));
  });

  it("retires a later reused item ID after its earlier occurrence already persisted", () => {
    const host = createChatState();
    const delta = (seq: number, itemId: string, text: string) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId,
        itemStartOffset: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });

    delta(1, "commentary-a", "Same");
    persistCommentary(host, "Same", "commentary-a", "saved-first");
    delta(2, "commentary-b", "Between");
    delta(3, "commentary-a", "Same");
    persistCommentary(host, "Same", "commentary-a", "saved-second");

    expect(renderedTexts(host)).toEqual(expect.arrayContaining(["Same", "Between", "Same"]));
    expect(renderedTexts(host).filter((text) => text === "Same")).toHaveLength(2);
  });

  it("preserves a reset projection prefix when its current item persists", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "foo" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: "bar\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "bar\n\nbaz" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    persistCommentary(host, "baz", "commentary-2");

    expect(renderedTexts(host)).toEqual(["foo", "bar", "baz"]);
  });

  it("replaces a positive-offset projection that no longer extends its predecessor", () => {
    const host = createChatState();
    const delta = (seq: number, itemId: string, itemStartOffset: number, text: string) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId,
        itemStartOffset,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });

    delta(2, "commentary-1", 0, "foo");
    delta(3, "commentary-2", 5, "bar\n\nbaz");
    delta(4, "commentary-3", 10, "bar\n\nbaz\n\nqux");

    expect(renderedTexts(host)).toEqual(["foo", "bar\n\nbaz", "qux"]);
  });

  it("retires an earlier visible item after a later prefix item persists first", () => {
    const host = createChatState();
    const [first, second, third] = ["A", "B", "C"];
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: `${first}\n\n${second}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${first}\n\n${second}\n\n${third}` }],
      },
    });

    persistCommentary(host, second, "commentary-2", "saved-second");
    persistCommentary(host, first, "commentary-1", "saved-first");

    expect(renderedTexts(host)).toEqual([second, first, third]);
  });

  it("settles an earlier pending item after a later receipt settles first", () => {
    const host = createChatState();
    const [first, second, third] = ["A", "B", "C"];
    persistCommentary(host, second, "commentary-2", "saved-second");
    persistCommentary(host, first, "commentary-1", "saved-first");

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: `${first}\n\n${second}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${first}\n\n${second}\n\n${third}` }],
      },
    });
    expect(renderedTexts(host)).toEqual([second, first, third]);
  });

  it("preserves an extending producer prefix across rollover", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "yes" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: "yes again\n\n".length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "yes again\n\nnext" }],
      },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });

    expect(renderedTexts(host)).toEqual(["yes", "again", "next"]);
  });

  it("does not match flattened commentary across producer item seams", () => {
    const host = createChatState();
    const prefix = "alpha\n\nbeta\n\n";
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${prefix}gamma` }],
      },
    });

    persistCommentary(host, "alpha beta", "commentary-4", "saved-fourth");

    expect(renderedTexts(host)).toEqual([`${prefix}gamma`, "alpha beta"]);
  });

  it("prefers the durable item's exact paragraph seams", () => {
    const host = createChatState();
    const flat = "foo bar baz";
    const paragraphs = "foo\n\nbar\n\nbaz";
    const prefix = `${flat}\n\n${paragraphs}\n\n`;
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${prefix}current` }],
      },
    });

    persistCommentary(host, paragraphs, "commentary-2", "saved-second");

    expect(renderedTexts(host)).toEqual([flat, paragraphs, "current"]);
  });

  it("matches the durable item's paragraph seam positions", () => {
    const host = createChatState();
    const first = "A B\n\nC";
    const second = "A\n\nB C";
    const prefix = `${first}\n\n${second}\n\n`;
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${prefix}current` }],
      },
    });

    persistCommentary(host, second, "commentary-2", "saved-second");

    expect(renderedTexts(host)).toEqual([first, second, "current"]);
  });

  it("keeps a reused item ID visible in a new run", () => {
    const host = createChatState();
    host.chatStreamSegments = [
      {
        text: "Hello",
        ts: 1,
        runId: "run-old",
        itemId: "answer",
        itemStartOffset: 0,
        cumulative: true,
      },
    ];

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "answer",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });

    expect(renderedTexts(host)).toEqual(["Hello", "Hello"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    expect(renderedTexts(host)).toEqual(["Hello", "Hello"]);
  });

  it("does not trim a positive-offset prefix owned by an earlier run", () => {
    const host = createChatState();
    host.chatStreamSegments = [{ text: "A", ts: 1, runId: "run-old" }];

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: "A\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nB" }] },
    });

    expect(renderedTexts(host)).toEqual(["A", "A\n\nB"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    expect(renderedTexts(host)).toEqual(["A", "A", "B"]);
  });

  it("preserves an unkeyed item before a distinct keyed reset with the same prefix", () => {
    const host = createChatState();
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "yes" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "yes again" }] },
    });

    expect(renderedTexts(host)).toEqual(["yes", "yes again"]);
  });

  it("keeps a distinct later item whose text starts with persisted commentary", () => {
    const first = "The persisted commentary remains its own item.";
    const second = `${first} The later item continues.`;
    const host = createChatState();

    persistCommentary(host, first);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: second }] },
    });

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("keeps a legacy later item whose text starts with persisted commentary", () => {
    const first = "The persisted commentary remains its own item.";
    const second = `${first} The legacy later item continues.`;
    const host = createChatState();

    persistCommentary(host, first);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      message: { role: "assistant", content: [{ type: "text", text: second }] },
    });

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("keeps a legacy later item whose first paragraph matches persisted commentary", () => {
    const first = "The persisted commentary remains its own item.";
    const second = `${first}\n\nThe legacy later item has another paragraph.`;
    const host = createChatState();

    persistCommentary(host, first);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      message: { role: "assistant", content: [{ type: "text", text: second }] },
    });

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("preserves an earlier producer prefix when the current rolled item persists", () => {
    const first = "An unseen earlier item remains visible.";
    const second = "The current item becomes durable.";
    const host = createChatState();
    const cumulative = `${first}\n\n${second}`;

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${first}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: cumulative }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, second, "commentary-2");

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("retires an offset-less keyed segment containing only its persisted item", () => {
    const text = "Legacy keyed commentary becomes durable.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, text);

    expect(renderedTexts(host)).toEqual([text]);
  });

  it("retires a partial offset-less keyed segment when its complete item persists", () => {
    const partial = "Legacy keyed commentary";
    const complete = `${partial} becomes durable.`;
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      message: { role: "assistant", content: [{ type: "text", text: partial }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, complete, "commentary-1");

    expect(renderedTexts(host)).toEqual([complete]);
  });

  it("preserves an earlier prefix when a partial offset-less item persists", () => {
    const earlier = "Earlier";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${earlier}\n\nHel` }],
      },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, "Hello", "commentary-1");

    expect(renderedTexts(host)).toEqual([earlier, "Hello"]);
  });

  it("retires a trailing item from an offset-less keyed cumulative segment", () => {
    const first = "An earlier cumulative item remains visible.";
    const second = "The trailing keyed item becomes durable.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${first}\n\n${second}` }],
      },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, second, "commentary-2");

    expect(renderedTexts(host)).toEqual([first, second]);
  });
});
