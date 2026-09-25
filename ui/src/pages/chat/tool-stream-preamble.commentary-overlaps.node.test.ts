import { describe, expect, it } from "vitest";
import { extractText } from "../../lib/chat/message-extract.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { rolloverChatStream } from "./stream-causal-boundary.ts";

function renderedTexts(host: ReturnType<typeof makeChatHost>) {
  return buildChatItems({
    paneId: "commentary-overlaps",
    sessionKey: host.sessionKey,
    runId: host.chatRunId,
    messages: host.chatMessages ?? [],
    toolMessages: [],
    streamSegments: host.chatStreamSegments ?? [],
    stream: host.chatStream,
    streamItemId: host.chatStreamItemId,
    streamItemStartOffset: host.chatStreamItemStartOffset,
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

describe("commentary paragraph boundary overlap", () => {
  it("completes a rolled item when its separator crosses snapshots", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: "A\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nHello\n" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    const next = "A\n\nHello\n\nmiddle\n\nNext";
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      itemStartOffset: "A\n\nHello\n\nmiddle\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: next }] },
    });

    expect(renderedTexts(host)).toEqual(["A", "Hello", "middle\n\nNext"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    expect(renderedTexts(host)).toEqual(["A", "Hello", "middle", "Next"]);
  });

  it("deduplicates a skipped cumulative item across CRLF separators", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: "A\r\n\r\n".length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "A\r\n\r\nHello\r\n" }],
      },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    const next = "A\r\n\r\nHello\r\n\r\nmiddle\r\n\r\nNext";
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      itemStartOffset: "A\r\n\r\nHello\r\n\r\nmiddle\r\n\r\n".length,
      message: { role: "assistant", content: [{ type: "text", text: next }] },
    });

    expect(renderedTexts(host)).toEqual(["A", "Hello", "middle\r\n\r\nNext"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    expect(renderedTexts(host)).toEqual(["A", "Hello", "middle", "Next"]);
  });

  it("clears item ownership across a divergent unkeyed segment", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string, itemId?: string) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        ...(itemId ? { itemId, itemStartOffset: 0 } : {}),
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "yes", "commentary-a");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "Between");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    delta(3, "yes again", "commentary-a");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-3" });

    expect(renderedTexts(host)).toEqual(["yes", "Between", "yes again"]);

    applySessionMessagePayload(
      host,
      {
        runId: "run-1",
        messageId: "saved-later-a",
        messageSeq: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "yes again" }],
          __openclaw: { id: "saved-later-a", seq: 1, runId: "run-1" },
          openclawStreamFallback: { source: "segment", itemId: "commentary-a" },
        },
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );

    expect(renderedTexts(host)).toEqual(["yes", "Between", "yes again"]);
  });

  it("keeps a divergent unkeyed prefix between reused item occurrences", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string, itemId?: string) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        ...(itemId ? { itemId, itemStartOffset: 0 } : {}),
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "hello", "commentary-a");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "he");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    delta(3, "hello world", "commentary-a");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-3" });

    applySessionMessagePayload(
      host,
      {
        runId: "run-1",
        messageId: "saved-later-a",
        messageSeq: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello world" }],
          __openclaw: { id: "saved-later-a", seq: 1, runId: "run-1" },
          openclawStreamFallback: { source: "segment", itemId: "commentary-a" },
        },
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );

    expect(renderedTexts(host)).toEqual(["hello", "he", "hello world"]);
  });

  it("tracks unkeyed divergence from the latest keyed reset", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string, itemId?: string) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        ...(itemId ? { itemId, itemStartOffset: 0 } : {}),
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "old", "commentary-a");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "new", "commentary-b");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    delta(3, "old plus");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-3" });
    delta(4, "new again", "commentary-b");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-4" });

    expect(renderedTexts(host)).toEqual(["old", "new", "old plus", "new again"]);
  });

  it("separates reused item IDs at producer-reported start offsets", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "First" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: "First\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "First\n\nSecond" }] },
    });

    applySessionMessagePayload(
      host,
      {
        runId: "run-1",
        messageId: "saved-first",
        messageSeq: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "First" }],
          __openclaw: { id: "saved-first", seq: 1, runId: "run-1" },
          openclawStreamFallback: { source: "segment", itemId: "commentary-a" },
        },
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );

    expect(renderedTexts(host)).toEqual(["First", "Second"]);
  });

  it("retires only the later producer-distinguished reused item", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string, itemStartOffset: number) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId: "commentary-a",
        itemStartOffset,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "yes", 0);
    delta(2, "yes\n\nyes again", "yes\n\n".length);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });

    applySessionMessagePayload(
      host,
      {
        runId: "run-1",
        messageId: "saved-later-a",
        messageSeq: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "yes again" }],
          __openclaw: { id: "saved-later-a", seq: 1, runId: "run-1" },
          openclawStreamFallback: { source: "segment", itemId: "commentary-a" },
        },
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );

    expect(renderedTexts(host)).toEqual(["yes", "yes again"]);
  });

  it("keeps a reset reused item visible from offset zero", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string, itemStartOffset: number) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId: "commentary-a",
        itemStartOffset,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "A\n\nB", "A\n\n".length);
    delta(2, "A\n\nB later", 0);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });

    expect(renderedTexts(host)).toEqual(["A", "B", "A\n\nB later"]);
  });

  it("does not manufacture an item boundary for offsetless continuation", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
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
      itemId: "commentary-a",
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nB" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });

    applySessionMessagePayload(
      host,
      {
        runId: "run-1",
        messageId: "saved-a",
        messageSeq: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "A\n\nB" }],
          __openclaw: { id: "saved-a", seq: 1, runId: "run-1" },
          openclawStreamFallback: { source: "segment", itemId: "commentary-a" },
        },
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );

    expect(renderedTexts(host)).toEqual(["A\n\nB"]);
  });

  it("retains the producer offset across offsetless continuation", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string, itemStartOffset?: number) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId: "commentary-a",
        ...(itemStartOffset === undefined ? {} : { itemStartOffset }),
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "P:first", 2);
    delta(2, "P:first more");
    delta(3, "P:first more reset", 0);

    expect(renderedTexts(host)).toEqual(["P:", "first more", "P:first more reset"]);
  });

  it("completes a rolled item whose producer offset is zero", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
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

  it("settles one identical pending receipt per metadata-free occurrence", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    for (const [messageId, itemId, messageSeq] of [
      ["saved-a", "commentary-a", 1],
      ["saved-b", "commentary-b", 2],
    ] as const) {
      applySessionMessagePayload(
        host,
        {
          runId: "run-1",
          messageId,
          messageSeq,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Same" }],
            __openclaw: { id: messageId, seq: messageSeq, runId: "run-1" },
            openclawStreamFallback: { source: "segment", itemId },
          },
        },
        true,
        { kind: "live", activeRunId: "run-1" },
      );
    }
    for (const seq of [1, 2]) {
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "Same" }] },
      });
      rolloverChatStream(host, { runId: "run-1", toolCallId: `call-${seq}` });
    }

    expect(renderedTexts(host).filter((text) => text === "Same")).toHaveLength(2);
  });

  it("persists the active reused-ID occurrence without hiding the earlier one", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string, itemStartOffset: number) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId: "commentary-a",
        itemStartOffset,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "Same", 0);
    delta(2, "Same\n\nSame", "Same\n\n".length);

    applySessionMessagePayload(
      host,
      {
        runId: "run-1",
        messageId: "saved-active-a",
        messageSeq: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Same" }],
          __openclaw: { id: "saved-active-a", seq: 1, runId: "run-1" },
          openclawStreamFallback: { source: "segment", itemId: "commentary-a" },
        },
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );

    expect(renderedTexts(host).filter((text) => text === "Same")).toHaveLength(2);
  });

  it("replaces a keyed projection with an ID-free shorter snapshot", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      replace: true,
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });

    expect(renderedTexts(host)).toEqual(["Hello"]);
  });

  it("prefers the active identical reused ID after an intervening owner", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, itemId: string, text: string, itemStartOffset?: number) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId,
        ...(itemStartOffset === undefined ? {} : { itemStartOffset }),
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "commentary-a", "Same", 0);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "commentary-b", "Between", 0);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    delta(3, "commentary-a", "Same");

    applySessionMessagePayload(
      host,
      {
        runId: "run-1",
        messageId: "saved-active-a",
        messageSeq: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Same" }],
          __openclaw: { id: "saved-active-a", seq: 1, runId: "run-1" },
          openclawStreamFallback: { source: "segment", itemId: "commentary-a" },
        },
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );

    expect(renderedTexts(host)).toEqual(["Same", "Between", "Same"]);
  });

  it("keeps a durable keyed preamble as an occurrence boundary", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    host.chatStreamSegments = [
      {
        text: "Same",
        ts: 1,
        runId: "run-1",
        itemId: "commentary-a",
        cumulative: true,
        itemStartOffset: 0,
        producerItemStartOffset: 0,
      },
      { text: "Between", ts: 2, runId: "run-1", itemId: "commentary-b" },
    ];
    host.chatStream = "Same";
    host.chatStreamItemId = "commentary-a";
    host.chatStreamItemStartOffset = 0;
    host.chatStreamItemPrefix = "";
    const persist = (messageId: string, itemId: string, text: string, messageSeq: number) =>
      applySessionMessagePayload(
        host,
        {
          runId: "run-1",
          messageId,
          messageSeq,
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            __openclaw: { id: messageId, seq: messageSeq, runId: "run-1" },
            openclawStreamFallback: { source: "segment", itemId },
          },
        },
        true,
        { kind: "live", activeRunId: "run-1" },
      );

    persist("saved-b", "commentary-b", "Between", 1);
    persist("saved-active-a", "commentary-a", "Same", 2);

    expect(renderedTexts(host)).toEqual(["Same", "Between", "Same"]);
  });

  it("treats a newly reported positive offset as a reused-ID boundary", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      message: { role: "assistant", content: [{ type: "text", text: "First" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: "First\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "First\n\nSecond" }] },
    });

    expect(renderedTexts(host)).toEqual(["First", "Second"]);
  });

  it("does not restore a prior offset after offsetless keyed ownership", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    host.chatStreamSegments = [
      {
        text: "A",
        ts: 1,
        runId: "run-1",
        itemId: "commentary-a",
        cumulative: true,
        itemStartOffset: 0,
        producerItemStartOffset: 0,
      },
      { text: "Boundary", ts: 2, runId: "run-1", itemId: "commentary-b" },
      {
        text: "A\n\nB",
        ts: 3,
        runId: "run-1",
        itemId: "commentary-b",
        cumulative: true,
        itemStartOffset: "A\n\n".length,
        producerItemStartOffset: "A\n\n".length,
      },
    ];

    expect(renderedTexts(host)).toEqual(["A", "Boundary", "B"]);
  });

  it("uses a divergent ID-free occurrence as its own growth baseline", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    host.chatStreamSegments = [
      {
        text: "yes",
        ts: 1,
        runId: "run-1",
        itemId: "commentary-a",
        cumulative: true,
        itemStartOffset: 0,
      },
      { text: "Between", ts: 2, runId: "run-1" },
      { text: "Between more", ts: 3, runId: "run-1" },
    ];
    host.chatStream = "Between more!";

    expect(renderedTexts(host)).toEqual(["yes", "Between", "more", "!"]);
  });

  it("keeps history recovery ownership through ID-free growth", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    host.chatStream = "Restored";
    host.chatStreamRecoveredWithoutItemId = true;
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Restored more" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Restored more" }] },
    });

    expect(renderedTexts(host)).toEqual(["Restored more"]);
  });

  it("uses the active prefix for an offsetless reused item", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, itemId: string, text: string, itemStartOffset?: number) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId,
        ...(itemStartOffset === undefined ? {} : { itemStartOffset }),
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "commentary-a", "Same", 0);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "commentary-b", "P", 0);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    delta(3, "commentary-a", "P\n\nSame");

    applySessionMessagePayload(
      host,
      {
        runId: "run-1",
        messageId: "saved-active-a",
        messageSeq: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Same" }],
          __openclaw: { id: "saved-active-a", seq: 1, runId: "run-1" },
          openclawStreamFallback: { source: "segment", itemId: "commentary-a" },
        },
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );

    expect(renderedTexts(host)).toEqual(["Same", "P", "Same"]);
  });

  it("honors a zero offset reported after an inferred reused-item prefix", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string, itemStartOffset?: number) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId: "commentary-a",
        ...(itemStartOffset === undefined ? {} : { itemStartOffset }),
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "P\n\nold", "P\n\n".length);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "P\n\nnew");
    delta(3, "P\n\nnew more", 0);

    expect(renderedTexts(host)).toEqual(["P", "old", "P\n\nnew more"]);
  });

  it("keeps keyed ownership through an ID-free replacement", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string, itemId?: string, replace?: boolean) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        ...(itemId ? { itemId, itemStartOffset: 0 } : {}),
        ...(replace ? { replace: true } : {}),
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "draft", "commentary-a");
    delta(2, "revised", undefined, true);
    delta(3, "final", "commentary-a");

    expect(renderedTexts(host)).toEqual(["final"]);
  });
});
