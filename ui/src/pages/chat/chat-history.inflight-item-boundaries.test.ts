// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { activeHistory, createState } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { adoptStartedChatRun, reconcileChatRunLifecycle } from "./run-lifecycle.ts";

it("adopts item ownership from a newer retained history snapshot", async () => {
  const { promise: historyPromise, resolve: resolveHistory } = createDeferred<ChatHistoryResult>();
  const request = vi.fn().mockReturnValue(historyPromise);
  const history = activeHistory("run-reconnected");
  history.inFlightRun!.text = "A\n\nB";
  history.inFlightRun!.itemId = "commentary-b";
  history.inFlightRun!.itemStartOffset = "A\n\n".length;
  const state = createState(history);
  state.client = { request } as unknown as GatewayBrowserClient;

  const loadPromise = loadChatHistory(state);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  handleChatGatewayEvent(state, {
    runId: "run-reconnected",
    sessionKey: "main",
    state: "delta",
    itemId: "commentary-a",
    itemStartOffset: 0,
    message: { role: "assistant", content: "A" },
  });
  resolveHistory(history);
  await loadPromise;

  expect(state.chatStream).toBe("A\n\nB");
  expect(state.chatStreamItemId).toBe("commentary-b");
  expect(state.chatStreamItemPrefix).toBe("A\n\n");
});

it.each(["lifecycle cleanup", "run adoption"])(
  "clears metadata-free recovery provenance during %s",
  (reset) => {
    const state = createState(activeHistory("run-old"));
    state.chatStream = "Recovered";
    state.chatStreamRecoveredWithoutItemId = true;
    if (reset === "run adoption") {
      adoptStartedChatRun(state, "run-new", 1);
    } else {
      reconcileChatRunLifecycle(state, { clearChatStream: true, clearLocalRun: true });
    }

    handleChatGatewayEvent(state, {
      runId: "run-new",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: "yes" },
    });
    handleChatGatewayEvent(state, {
      runId: "run-new",
      sessionKey: "main",
      state: "delta",
      itemId: "commentary-new",
      itemStartOffset: 0,
      message: { role: "assistant", content: "yes again" },
    });

    expect(state.chatStreamSegments?.map((segment) => segment.text)).toEqual(["yes"]);
    expect(state.chatStream).toBe("yes again");
  },
);

it("adopts changed item ownership when the retained snapshot text is unchanged", async () => {
  const { promise: historyPromise, resolve: resolveHistory } = createDeferred<ChatHistoryResult>();
  const request = vi.fn().mockReturnValue(historyPromise);
  const history = activeHistory("run-reconnected");
  history.inFlightRun!.text = "Same text";
  history.inFlightRun!.itemId = "commentary-b";
  history.inFlightRun!.itemStartOffset = 0;
  const state = createState(history);
  state.client = { request } as unknown as GatewayBrowserClient;

  handleChatGatewayEvent(state, {
    runId: "run-reconnected",
    sessionKey: "main",
    state: "delta",
    itemId: "commentary-a",
    itemStartOffset: 0,
    message: { role: "assistant", content: "Same text" },
  });
  const loadPromise = loadChatHistory(state);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  resolveHistory(history);
  await loadPromise;

  expect(state.chatStream).toBe("Same text");
  expect(state.chatStreamItemId).toBe("commentary-b");
  expect(state.chatStreamItemPrefix).toBe("");
});

it("preserves live item ownership when equal-text history is stale", async () => {
  const { promise: historyPromise, resolve: resolveHistory } = createDeferred<ChatHistoryResult>();
  const request = vi.fn().mockReturnValue(historyPromise);
  const history = activeHistory("run-reconnected");
  history.inFlightRun!.text = "Same text";
  history.inFlightRun!.itemId = "commentary-a";
  history.inFlightRun!.itemStartOffset = 0;
  const state = createState(history);
  state.client = { request } as unknown as GatewayBrowserClient;
  handleChatGatewayEvent(state, {
    runId: "run-reconnected",
    sessionKey: "main",
    state: "delta",
    itemId: "commentary-a",
    itemStartOffset: 0,
    message: { role: "assistant", content: "Same text" },
  });

  const loadPromise = loadChatHistory(state);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  handleChatGatewayEvent(state, {
    runId: "run-reconnected",
    sessionKey: "main",
    state: "delta",
    itemId: "commentary-b",
    itemStartOffset: 0,
    message: { role: "assistant", content: "Same text" },
  });
  resolveHistory(history);
  await loadPromise;

  expect(state.chatStream).toBe("Same text");
  expect(state.chatStreamItemId).toBe("commentary-b");
  expect(state.chatStreamItemPrefix).toBe("");
});

it("preserves live ownership across an item ABA while history is pending", async () => {
  const { promise: historyPromise, resolve: resolveHistory } = createDeferred<ChatHistoryResult>();
  const request = vi.fn().mockReturnValue(historyPromise);
  const history = activeHistory("run-reconnected");
  history.inFlightRun!.text = "Same text";
  history.inFlightRun!.itemId = "commentary-b";
  history.inFlightRun!.itemStartOffset = 0;
  const state = createState(history);
  state.client = { request } as unknown as GatewayBrowserClient;
  handleChatGatewayEvent(state, {
    runId: "run-reconnected",
    sessionKey: "main",
    state: "delta",
    itemId: "commentary-a",
    itemStartOffset: 0,
    message: { role: "assistant", content: "Same text" },
  });

  const loadPromise = loadChatHistory(state);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  for (const itemId of ["commentary-b", "commentary-a"]) {
    handleChatGatewayEvent(state, {
      runId: "run-reconnected",
      sessionKey: "main",
      state: "delta",
      itemId,
      itemStartOffset: 0,
      message: { role: "assistant", content: "Same text" },
    });
  }
  resolveHistory(history);
  await loadPromise;

  expect(state.chatStreamItemId).toBe("commentary-a");
  expect(state.chatStreamItemPrefix).toBe("");
});
