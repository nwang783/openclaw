import { onTestFinished, vi } from "vitest";
import { extractText } from "../../lib/chat/message-extract.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatHistoryHost } from "./chat-state-contract.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import type { ToolStreamEntry } from "./tool-stream-contract.ts";
import type { handleAgentEvent } from "./tool-stream.ts";

export type TestState = ChatHistoryHost &
  Parameters<typeof handleAgentEvent>[0] & { requestUpdate: () => void };

export function createState(result: ChatHistoryResult): TestState {
  const host = makeChatHost({
    requestHandlers: { "chat.history": result },
    sessionKey: "main",
  });
  vi.spyOn(host.sessions, "reconcileMutation").mockResolvedValue({ status: "refreshed" });
  vi.spyOn(host.sessions, "reconcileRunTerminal").mockReturnValue(false);
  vi.spyOn(host.sessions, "listBranches").mockResolvedValue([]);
  onTestFinished(() => host.sessions.dispose());
  return {
    ...host,
    chatToolMessages: host.chatToolMessages ?? [],
    chatStreamSegments: host.chatStreamSegments ?? [],
    connectionEpoch: 1,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatStreamStartedAt: null,
    toolStreamById: host.toolStreamById ?? new Map<string, ToolStreamEntry>(),
    toolStreamOrder: host.toolStreamOrder ?? [],
    toolStreamSyncTimer: host.toolStreamSyncTimer ?? null,
    requestUpdate: vi.fn(),
  };
}

export function activeHistory(runId: string): ChatHistoryResult {
  return {
    messages: [],
    sessionInfo: {
      key: "main",
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: [runId],
      status: "running",
    },
    inFlightRun: { runId, text: "" },
  };
}

export function failedHistory(): ChatHistoryResult {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Inspect the unavailable project" }],
        timestamp: 1,
        __openclaw: { id: "first-user", idempotencyKey: "run-first:user", seq: 1 },
      },
    ],
    sessionInfo: {
      key: "main",
      kind: "direct",
      updatedAt: 2,
      status: "failed",
      hasActiveRun: false,
      lastRunId: "run-first",
      lastRunError:
        "ProjectCloneError: Git clone could not reach GitHub. Check the Gateway network connection and retry.",
    },
  };
}

export function renderedText(state: TestState) {
  return buildChatItems({
    paneId: "steer-regression",
    sessionKey: state.sessionKey,
    runId: state.chatRunId,
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    streamSegments: state.chatStreamSegments,
    stream: state.chatStream,
    streamItemId: state.chatStreamItemId,
    streamItemStartOffset: state.chatStreamItemStartOffset,
    streamItemPrefix: state.chatStreamItemPrefix,
    streamStartedAt: state.chatStreamStartedAt,
    showToolCalls: true,
  }).flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message }) => extractText(message)?.trim())
      : item.kind === "stream"
        ? [item.text.trim()]
        : [],
  );
}
