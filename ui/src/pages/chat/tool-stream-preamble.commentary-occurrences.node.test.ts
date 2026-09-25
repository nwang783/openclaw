import { describe, expect, it } from "vitest";
import { extractText } from "../../lib/chat/message-extract.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { rolloverChatStream } from "./stream-causal-boundary.ts";

function renderedTexts(host: ChatState) {
  return buildChatItems({
    paneId: "commentary-occurrences",
    sessionKey: host.sessionKey,
    runId: host.chatRunId,
    messages: host.chatMessages ?? [],
    toolMessages: [],
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
  itemId: string,
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

describe("commentary occurrence ownership", () => {
  function rolledPartialOccurrences() {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
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

    delta(1, "commentary-a", "Fir");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "commentary-b", "Between");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    delta(3, "commentary-a", "Sec");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-3" });
    return host;
  }

  it("retires the later partial occurrence when an item ID is reused", () => {
    const host = rolledPartialOccurrences();

    persistCommentary(host, "Second", "commentary-a", "saved-second");

    expect(renderedTexts(host)).toEqual(["Fir", "Between", "Second"]);
  });

  it("retires the active partial when its item ID reuses an earlier exact occurrence", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
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
    const first = "Same";
    const between = `${first}\n\nBetween`;
    const activePrefix = `${between}\n\n`;
    delta(1, "commentary-a", 0, first);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "commentary-b", `${first}\n\n`.length, between);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    delta(3, "commentary-a", activePrefix.length, `${activePrefix}Sam`);

    persistCommentary(host, first, "commentary-a", "saved-later-same");

    expect(renderedTexts(host)).toEqual([first, "Between", first]);
  });

  it("retires an earlier compatible partial before a reused item ID", () => {
    const host = rolledPartialOccurrences();

    persistCommentary(host, "First", "commentary-a", "saved-first");

    const texts = renderedTexts(host);
    expect(texts).toHaveLength(3);
    expect(new Set(texts)).toEqual(new Set(["First", "Between", "Sec"]));
  });

  it("keeps an unrelated live occurrence when persistence reuses its item ID", () => {
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
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Between" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });

    persistCommentary(host, "Second", "commentary-a", "saved-second");
    const texts = renderedTexts(host);
    expect(texts).toHaveLength(3);
    expect(new Set(texts)).toEqual(new Set(["First", "Between", "Second"]));
  });

  it("keeps an earlier item when a different keyed item is still active", () => {
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
      itemId: "commentary-b",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Between" }] },
    });

    persistCommentary(host, "Second", "commentary-a", "saved-second");

    const texts = renderedTexts(host);
    expect(texts).toHaveLength(3);
    expect(new Set(texts)).toEqual(new Set(["First", "Between", "Second"]));
  });

  it("retires an unambiguous live item when its durable text is rewritten", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "draft" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });

    persistCommentary(host, "final", "commentary-a", "saved-final");

    expect(renderedTexts(host)).toEqual(["final"]);
  });

  it("retires the current live item when its durable text is rewritten", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "draft" }] },
    });

    persistCommentary(host, "final", "commentary-a", "saved-final");

    expect(renderedTexts(host)).toEqual(["final"]);
  });

  it("preserves the prefix of a shortened offset-less item", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Earlier\n\nHello world" }],
      },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });

    persistCommentary(host, "Hello", "commentary-a", "saved-rewrite");

    expect(renderedTexts(host)).toEqual(["Earlier", "Hello"]);
  });

  it("retires an unambiguous rolled revision chain when durable text is rewritten", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId: "commentary-a",
        itemStartOffset: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "draft");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "draft continued");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });

    persistCommentary(host, "final", "commentary-a", "saved-final");

    expect(renderedTexts(host)).toEqual(["final"]);
  });

  it("retires a live tail when its rolled item is durably rewritten", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, text: string) =>
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        itemId: "commentary-a",
        itemStartOffset: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    delta(1, "draft");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "draft continued");

    persistCommentary(host, "final", "commentary-a", "saved-final");

    expect(renderedTexts(host)).toEqual(["final"]);
  });

  it("uses the resumed rolled baseline for an offset-less cumulative extension", () => {
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
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hell" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-b",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });

    expect(renderedTexts(host)).toEqual(["Hel", "lo"]);
  });

  it("uses a completed rolled prefix when an offset-less item skips a sibling", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "first" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first\n\nsecond" }],
      },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-b",
      message: { role: "assistant", content: [{ type: "text", text: "first\n\nthird" }] },
    });

    expect(renderedTexts(host)).toEqual(["first", "second", "third"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    expect(renderedTexts(host)).toEqual(["first", "second", "third"]);
  });

  it("does not infer a boundary before an offset-less partial extension", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nHel" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "A\n\nHello\n\nNext" }],
      },
    });

    expect(renderedTexts(host)).toEqual(["A\n\nHello\n\nNext"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    expect(renderedTexts(host)).toEqual(["A\n\nHello\n\nNext"]);
  });

  it("retires a rolled partial inside an offset-less cumulative extension", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: "A\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nHel" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "A\n\nHello\n\nNext" }],
      },
    });

    persistCommentary(host, "Hello", "commentary-a", "saved-hello");

    expect(renderedTexts(host)).toEqual(["A", "Hello", "Next"]);
  });

  it("completes a rolled partial before an explicit next-item offset", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: "A\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nHel" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      itemStartOffset: "A\n\nHello\n\n".length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "A\n\nHello\n\nNext" }],
      },
    });

    expect(renderedTexts(host)).toEqual(["A", "Hello", "Next"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    expect(renderedTexts(host)).toEqual(["A", "Hello", "Next"]);
  });

  it("scopes a divergent rollover baseline to the active run", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    host.chatStreamSegments = [
      {
        text: "Shared sibling",
        ts: 1,
        runId: "run-sibling",
        itemId: "sibling-item",
        cumulative: true,
      },
    ];
    host.chatStream = "Shared current";
    host.chatStreamItemId = "current-item";
    host.chatStreamItemPrefix = "Shared";
    host.chatStreamStartedAt = 2;

    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });

    expect(renderedTexts(host)).toEqual(["Shared sibling", "Shared", "current"]);
  });

  it("keeps ambiguous reused items for a compatible shorter revision", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
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
    delta(1, "commentary-a", "Hello first");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    delta(2, "commentary-b", "Between");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    delta(3, "commentary-a", "Hello second");
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-3" });

    persistCommentary(host, "Hello", "commentary-a", "saved-shorter");

    expect(renderedTexts(host)).toEqual(["Hello first", "Between", "Hello second", "Hello"]);
  });

  it("settles persistence-first commentary from a reset replay", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Old" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, "New", "commentary-b", "saved-new");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "New" }] },
    });
    expect(renderedTexts(host)).toEqual(["Old", "New"]);
  });

  it("keeps the prior live item when a later receipt replays cumulatively", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Old" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, "New", "commentary-b", "saved-new");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      itemStartOffset: "Old\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "Old\n\nNew" }] },
    });

    expect(renderedTexts(host)).toEqual(["Old", "New"]);
  });

  it("retires a longer live item when its durable revision is shorter", () => {
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
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });

    persistCommentary(host, "Hello", "commentary-a", "saved-shorter");

    expect(renderedTexts(host)).toEqual(["Hello"]);
  });

  it("retires an unseen item from a reset cumulative projection", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-foo",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "foo" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-baz",
      itemStartOffset: "bar\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "bar\n\nbaz" }] },
    });

    persistCommentary(host, "bar", "commentary-bar", "saved-bar");
    expect(renderedTexts(host)).toEqual(["foo", "bar", "baz"]);
  });

  it("continues an offset-less partial after a tool rollover", () => {
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
      message: { role: "assistant", content: [{ type: "text", text: "Hello\n\nNext" }] },
    });

    expect(renderedTexts(host)).toEqual(["Hel", "lo\n\nNext"]);
  });

  it("continues when a paragraph separator crosses offset-less snapshots", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hello\n" }] },
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

  it("preserves an explicit boundary when its separator crosses snapshots", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "A\n" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-b",
      itemStartOffset: "A\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nB" }] },
    });

    expect(renderedTexts(host)).toEqual(["A", "B"]);
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    expect(renderedTexts(host)).toEqual(["A", "B"]);
  });

  it("retires the rolled partial when its offset-less extension becomes durable", () => {
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
      message: { role: "assistant", content: [{ type: "text", text: "Hello\n\nNext" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });

    persistCommentary(host, "Hello\n\nNext", "commentary-b", "saved-extension");

    expect(renderedTexts(host)).toEqual(["Hello\n\nNext"]);
  });

  it("keeps a new receipt when an item ID is reused after another owner", () => {
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
      itemId: "commentary-b",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Between" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, "Second", "commentary-a", "saved-second");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Second" }] },
    });
    const texts = renderedTexts(host);
    expect(texts).toHaveLength(3);
    expect(new Set(texts)).toEqual(new Set(["First", "Between", "Second"]));
  });

  it("keeps separate persistence-first receipts for a reused item ID", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    persistCommentary(host, "First", "commentary-a", "saved-first");
    persistCommentary(host, "Second", "commentary-a", "saved-second");
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
    expect(renderedTexts(host)).toEqual(["First", "Second"]);
  });

  it("keeps separate identical persistence-first receipts for a reused item ID", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    persistCommentary(host, "Same", "commentary-a", "saved-first");
    persistCommentary(host, "Same", "commentary-a", "saved-second");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Same" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: "Same\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "Same\n\nSame" }] },
    });

    expect(renderedTexts(host)).toEqual(["Same", "Same"]);
  });

  it("settles identical same-item receipts before a later occurrence", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    persistCommentary(host, "Same", "commentary-a", "saved-first");
    persistCommentary(host, "Same", "commentary-a", "saved-second");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: "Same\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "Same\n\nSame" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: "Same\n\nSame\n\n".length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Same\n\nSame\n\nSame" }],
      },
    });

    expect(renderedTexts(host)).toEqual(["Same", "Same", "Same"]);
  });

  it("advances persistence-first receipts when cumulative deltas omit item IDs", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    persistCommentary(host, "First", "commentary-a", "saved-first");
    persistCommentary(host, "Second", "commentary-a", "saved-second");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "First" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "First\n\nSecond" }] },
    });

    expect(renderedTexts(host)).toEqual(["First", "Second"]);
  });

  it("preserves keyed ownership through a metadata-free cumulative extension", () => {
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
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    });

    expect(renderedTexts(host)).toEqual(["Hello world"]);
  });

  it("preserves keyed ownership through metadata-free paragraph growth", () => {
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
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nB" }] },
    });
    persistCommentary(host, "A\n\nB", "commentary-a", "saved-a");

    expect(renderedTexts(host)).toEqual(["A\n\nB"]);
  });

  it("transfers metadata-free ownership when a different pending item settles", () => {
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
    persistCommentary(host, "B", "commentary-b", "saved-b");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "A\n\nB" }] },
    });

    expect(renderedTexts(host)).toEqual(["A", "B"]);
  });

  it("lets a persisted intervening item break prior item ownership", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
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
      itemId: "commentary-b",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "yes" }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-2" });
    persistCommentary(host, "yes", "commentary-b", "saved-b");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-a",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "yes again" }] },
    });

    expect(renderedTexts(host)).toContain("yes again");
    expect(renderedTexts(host)).not.toContain("again");
  });

  it.each([
    { case: "incompatible", first: "first", live: "draft", durable: "final", between: "b" },
    { case: "identical", first: "same", live: "same", durable: "same", between: "b" },
    { case: "divergent unkeyed", first: "same", live: "same", durable: "same" },
  ])("keeps $case ambiguous reused item occurrences", ({ first, live, durable, between }) => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    const delta = (seq: number, itemId: string | undefined, text: string) => {
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq,
        state: "delta",
        ...(itemId ? { itemId, itemStartOffset: 0 } : {}),
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      rolloverChatStream(host, { runId: "run-1", toolCallId: `call-${seq}` });
    };
    delta(1, "commentary-a", first);
    delta(2, between ? "commentary-b" : undefined, "Between");
    delta(3, "commentary-a", live);

    persistCommentary(host, durable, "commentary-a", "saved-final");

    expect(renderedTexts(host)).toEqual([first, "Between", live, durable]);
  });

  it("keeps a sibling prefix when another item replays persistence-first commentary", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    host.chatStreamSegments = [
      {
        text: "Saved",
        ts: 1,
        runId: "run-sibling",
        pendingCommentaryPrefixFor: "sibling-item",
      },
    ];

    persistCommentary(host, "Saved", "commentary-1");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: "Saved\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "Saved\n\nNext" }] },
    });

    expect(renderedTexts(host)).toEqual(["Saved", "Saved", "Next"]);
  });

  it("does not let a sibling baseline consume an active cumulative prefix", () => {
    const host = makeChatHost({ chatRunId: "run-1", sessionKey: "main" });
    host.chatStreamSegments = [{ text: "A", ts: 1, runId: "run-sibling", cumulative: true }];
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-current",
      itemStartOffset: "A\n\nB\n\n".length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "A\n\nB\n\nCurrent" }],
      },
    });

    persistCommentary(host, "B", "commentary-b", "saved-b");

    expect(renderedTexts(host)).toEqual(["A", "A", "B", "Current"]);
  });
});
