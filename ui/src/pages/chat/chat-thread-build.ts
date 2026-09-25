import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { composeTranscriptDisplay } from "../../../../src/chat/transcript-display-position.js";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import {
  type ChatGuardianNotice,
  type ChatItem,
  type MessageGroup,
  accumulatedStreamTextForCurrent,
  accumulatedStreamTextForItem,
  advanceAccumulatedStreamText,
  resolveCurrentStreamPrefix,
  streamSegmentHasItemId,
  streamSegmentIsSyntheticItemPrefix,
  streamSegmentResetsAccumulatedText,
  streamSegmentUsesAccumulatedText,
  streamVisiblePrefix as visiblePrefix,
  trimAccumulatedStreamPrefix,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../../lib/chat/heartbeat-display.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  canvasPreviewsMatch,
  normalizeRoleForGrouping,
} from "../../lib/chat/message-normalizer.ts";
import type { CanvasToolPreview } from "../../lib/chat/tool-cards.ts";
import {
  buildCompactionDividerItem,
  buildGuardianNoticeItem,
  buildResetDividerItem,
  clearWorkingProgress,
  isContextCompactionMessage,
  matchesCompactionOperation,
  resolveWorkingProgress,
  shouldRenderQueuedSendInThread,
} from "./chat-progress.ts";
import { projectChatSystemNotice } from "./chat-system-notice.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import {
  placeChatInputs,
  type ChatInputOrderState,
  type ChatInputPlacementProps,
} from "./chat-thread-inputs.ts";
import {
  appendCanvasBlockToAssistantMessage,
  buildMessageItems,
  canvasPreviewBaseIdentity,
  createCanvasAssistantMessage,
  extractChatMessagePreview,
  findCanvasInsertionIndex,
  findNearestAssistantMessage,
  hasRenderableNormalizedMessage,
  insertionIndexesForBounds,
  type ChatProjection,
  messageMatchesSearchQuery,
  rawMessageTimestamp,
  insertChatItemsByTimestamp,
  sanitizeStreamText,
  timestampAfterVisibleItems,
  userTurnRunId,
  transcriptPositionTimestamp,
  type TurnInsertionBounds,
} from "./chat-thread-items.ts";
import {
  applyPersistedToolInvocationBounds,
  findCurrentTurnBounds,
  createRunTurnLookup,
  createToolCallLookup,
  isKeyedAssistantStreamFallbackMessage,
  optionalBoundaryIdentity,
  optionalRunIdentity,
  resolveRunInsertionBounds,
  transcriptRunId,
} from "./chat-thread-run-identity.ts";
import {
  collectExplicitlyOwnedTools,
  createChatThreadToolPlacement,
} from "./chat-thread-tool-placement.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { latestPersistedSteerBoundary } from "./stream-causal-boundary.ts";
import { previousStreamOwnersBySegment } from "./stream-commentary-matching.ts";
import type { CompactionStatus } from "./tool-stream-contract.ts";

export type BuildChatItemsProps = ChatInputPlacementProps & {
  paneId: string;
  sessionKey: string;
  archiveNotice?: Extract<ChatItem, { kind: "notice" }>;
  runId?: string | null;
  compactionStatus?: CompactionStatus | null;
  /** Invalidates cached display copy when the active UI language changes. */
  locale?: string;
  messages: unknown[];
  toolMessages: unknown[];
  guardianNotices?: ChatGuardianNotice[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamItemId?: string;
  streamItemStartOffset?: number;
  streamItemPrefix?: string;
  streamStartedAt: number | null;
  showToolCalls: boolean;
  persistCommentary?: boolean;
  /** True while the agent is visibly working (isChatRunWorking). */
  runWorking?: boolean;
  /** True while the current session has an abortable live run. */
  runActive?: boolean;
  questionPrompts?: readonly QuestionPrompt[];
  /** True while chat history is loading (initial load or background reload). */
  loading?: boolean;
};

function canvasAssistantItemKey(
  message: unknown,
  source: Parameters<typeof canvasPreviewBaseIdentity>[1],
  fallback: string,
): string {
  const identity = canvasPreviewBaseIdentity(message, source);
  return identity ? `canvas:${identity}` : `${fallback}:canvas`;
}

export function buildChatItems(
  props: BuildChatItemsProps,
  inputOrder: ChatInputOrderState = { keys: [] },
): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const tools = props.toolMessages.filter(
    (message): message is Record<string, unknown> => asRecord(message) !== null,
  );
  const toolItems = buildMessageItems(tools).map((item) => {
    const projection: ChatProjection<typeof item> = { item };
    return {
      projection,
      runId: normalizeOptionalString(item.message.runId),
      callId: normalizeOptionalString(item.message.toolCallId),
      preview: extractChatMessagePreview(item.message),
    };
  });
  const queuedSends = props.queue ?? [];
  const segments = props.streamSegments;
  let progress: ReturnType<typeof resolveWorkingProgress> | null = null;
  const resolveProgress = () =>
    (progress ??= resolveWorkingProgress(
      props.sessionKey,
      props.runId ?? null,
      props.streamStartedAt,
      queuedSends,
      segments,
      tools,
    ));
  // Retention and live status share the same explicit or inferred run ownership.
  const activeCommentaryRunId =
    props.persistCommentary === false && (props.runWorking || props.runActive)
      ? normalizeOptionalString(resolveProgress().runId)
      : undefined;
  const history = composeTranscriptDisplay(
    props.messages.filter(
      (message) =>
        !isAssistantHeartbeatAckForDisplay(message) &&
        (props.persistCommentary !== false ||
          !isKeyedAssistantStreamFallbackMessage(message) ||
          (activeCommentaryRunId !== undefined &&
            transcriptRunId(message) === activeCommentaryRunId)),
    ),
  );
  const searchFiltering = props.searchOpen === true && Boolean(props.searchQuery?.trim());
  const hiddenHistoryKeys = new Set<string>();
  const persistedCanvasIdentities = new Set<string>();
  const normalizedHistory = history.map(safeNormalizeMessage);
  const historyItems = buildMessageItems(history);
  let canvasTurn: {
    previews: { preview: CanvasToolPreview; item: (typeof historyItems)[number] }[];
    lastMatchingAssistantIndex: number;
  } = {
    previews: [],
    lastMatchingAssistantIndex: -1,
  };
  // Rows in one turn share these facts so a tool result can see the assistant
  // projection that follows it, without consuming a view from another turn.
  const canvasTurns = historyItems.map((item, index) => {
    const message = normalizedHistory[index];
    const role = message && normalizeRoleForGrouping(message.role);
    if (role === "user" || role === "system") {
      canvasTurn = { previews: [], lastMatchingAssistantIndex: -1 };
    }
    if (
      role === "assistant" &&
      message &&
      (!searchFiltering ||
        messageMatchesSearchQuery(history[index], props.searchQuery ?? "", props.messageRecovery))
    ) {
      canvasTurn.lastMatchingAssistantIndex = index;
      canvasTurn.previews.push(
        ...message.content.flatMap((block) =>
          block.type === "canvas" ? [{ preview: block.preview, item }] : [],
        ),
      );
    }
    return canvasTurn;
  });
  const compaction = props.compactionStatus;
  const compactionKey = compaction
    ? `divider:compaction:live:${compaction.runId}:${compaction.itemId ?? "manual"}`
    : undefined;
  let hasPersistedCompaction = false;
  for (const [i, item] of historyItems.entries()) {
    const msg = item.message;
    const itemKey = item.key;
    const raw = asRecord(msg) ?? {};
    const marker = asRecord(raw["__openclaw"]);
    if (marker?.kind === "compaction" || isContextCompactionMessage(msg)) {
      const matchesLive = compaction != null && matchesCompactionOperation(msg, compaction);
      const divider = buildCompactionDividerItem(
        marker ?? {},
        rawMessageTimestamp(msg) ?? Date.now(),
        i,
      );
      items.push({
        ...divider,
        compactionId: divider.key,
        ...(matchesLive && compactionKey ? { key: compactionKey } : {}),
      });
      hasPersistedCompaction ||= matchesLive;
      continue;
    }
    const normalized = normalizedHistory[i];
    if (!normalized) {
      continue;
    }
    if (marker && marker.kind === "reset") {
      items.push(buildResetDividerItem(marker, normalized.timestamp ?? Date.now(), i));
      continue;
    }

    const role = normalizeRoleForGrouping(normalized.role);
    if (role === "system") {
      const text = extractTextCached(msg);
      if (text?.trim()) {
        items.push({ kind: "notice", key: itemKey, text, timestamp: normalized.timestamp });
      }
      continue;
    }

    const isToolResult = normalized.role.toLowerCase() === "toolresult";
    const persistedCanvasSource = isToolResult ? extractChatMessagePreview(msg) : null;
    if (persistedCanvasSource) {
      const identity = canvasPreviewBaseIdentity(msg, persistedCanvasSource);
      if (identity) {
        persistedCanvasIdentities.add(identity);
      }
    }
    const matchingCanvas =
      persistedCanvasSource &&
      canvasTurns[i]!.previews.find(({ preview }) =>
        canvasPreviewsMatch(preview, persistedCanvasSource.preview),
      );
    if (persistedCanvasSource && matchingCanvas) {
      // Enrich the owned display row, including a later assistant shortcode,
      // without changing transcript input or introducing a second widget card.
      matchingCanvas.item.message = appendCanvasBlockToAssistantMessage(
        matchingCanvas.item.message,
        persistedCanvasSource.preview,
        persistedCanvasSource.text,
      );
    }
    const renderPersistedPreview =
      persistedCanvasSource != null &&
      !matchingCanvas &&
      (!searchFiltering || canvasTurns[i]!.lastMatchingAssistantIndex > i);
    if (persistedCanvasSource && renderPersistedPreview) {
      items.push({
        kind: "message",
        key: canvasAssistantItemKey(msg, persistedCanvasSource, itemKey),
        message: createCanvasAssistantMessage(
          persistedCanvasSource,
          persistedCanvasSource.timestamp ?? transcriptPositionTimestamp(history, i),
        ),
      });
    }

    if (!props.showToolCalls && isToolResult) {
      continue;
    }

    const searchQuery = props.searchQuery ?? "";
    if (
      props.searchOpen &&
      searchQuery.trim() &&
      !messageMatchesSearchQuery(msg, searchQuery, props.messageRecovery)
    ) {
      hiddenHistoryKeys.add(itemKey);
    }
    if (
      !hasRenderableNormalizedMessage(msg, normalized) &&
      normalized.role.toLowerCase() !== "assistant"
    ) {
      continue;
    }

    items.push(...projectChatSystemNotice(item, normalized));
  }
  const currentRunId =
    props.runId ??
    (props.stream !== null || queuedSends.some(shouldRenderQueuedSendInThread)
      ? resolveProgress().runId
      : null);
  const historyTurnBounds = findCurrentTurnBounds(
    items.filter((item) => !hiddenHistoryKeys.has(item.key)),
  );
  const { pendingKeys, historicalKeys, hiddenKeys, activeInputKey } = placeChatInputs(
    items,
    history,
    props,
    inputOrder,
    currentRunId,
  );
  items = items.filter((item) => !hiddenHistoryKeys.has(item.key) && !hiddenKeys.has(item.key));
  const executionItems = () => items.filter((item) => !historicalKeys.has(item.key));
  const canvasRunBounds = createRunTurnLookup(executionItems());
  const currentTurnBounds =
    (currentRunId ? canvasRunBounds(currentRunId) : null) ??
    (activeInputKey ? { afterKey: activeInputKey } : historyTurnBounds);
  const boundToPendingInputs = (
    bounds: TurnInsertionBounds | null | undefined,
  ): TurnInsertionBounds | undefined => {
    const { minimum, maximum } = insertionIndexesForBounds(items, bounds ?? undefined);
    const pending = items.find(
      (item, index) => index >= minimum && index < maximum && pendingKeys.has(item.key),
    );
    return pending ? { ...bounds, beforeKey: pending.key } : (bounds ?? undefined);
  };
  for (const { projection, preview } of toolItems) {
    if (!preview) {
      continue;
    }
    const baseIdentity = canvasPreviewBaseIdentity(projection.item.message, preview);
    if (baseIdentity && persistedCanvasIdentities.has(baseIdentity)) {
      continue;
    }
    const canvasBounds = boundToPendingInputs(
      resolveRunInsertionBounds(
        canvasRunBounds,
        projection.item.message.runId,
        currentRunId,
        currentTurnBounds,
      ) ?? (!projection.item.message.runId && activeInputKey ? currentTurnBounds : undefined),
    );
    const { minimum: canvasMinimumIndex, maximum: canvasMaximumIndex } = insertionIndexesForBounds(
      items,
      canvasBounds ?? undefined,
    );
    const assistant = findNearestAssistantMessage(
      items,
      preview.timestamp,
      canvasMinimumIndex,
      canvasMaximumIndex,
    );
    if (assistant) {
      items[assistant.index] = {
        ...assistant.item,
        message: appendCanvasBlockToAssistantMessage(
          assistant.item.message,
          preview.preview,
          preview.text,
        ),
      };
      continue;
    }
    if (searchFiltering) {
      continue;
    }
    const insertionIndex = findCanvasInsertionIndex(
      items,
      preview.timestamp,
      canvasMinimumIndex,
      canvasMaximumIndex,
    );
    const nextItem = items[insertionIndex];
    const nextTimestamp =
      nextItem?.kind === "message" ? rawMessageTimestamp(nextItem.message) : null;
    const timestamp =
      preview.timestamp != null && nextTimestamp != null
        ? Math.min(preview.timestamp, nextTimestamp)
        : preview.timestamp;
    items.splice(insertionIndex, 0, {
      kind: "message",
      key: canvasAssistantItemKey(projection.item.message, preview, projection.item.key),
      message: createCanvasAssistantMessage(preview, timestamp),
    });
  }
  items = items.filter(
    (item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
  const projections: ChatProjection[] = [];
  if (compaction && compactionKey && !hasPersistedCompaction) {
    const timestamp = compaction.startedAt ?? compaction.completedAt ?? Date.now();
    projections.push({
      item: {
        ...buildCompactionDividerItem(
          {},
          timestamp,
          0,
          compaction.phase === "complete" ? "complete" : "active",
        ),
        key: compactionKey,
      },
    });
  }
  const afterBoundaryBySegment = new Map<ChatStreamSegment, string>();
  let latestBoundaryRunId: string | undefined;
  for (const segment of segments) {
    const afterBoundaryRunId =
      normalizeOptionalString(segment.afterBoundaryRunId) ?? latestBoundaryRunId;
    if (afterBoundaryRunId) {
      afterBoundaryBySegment.set(segment, afterBoundaryRunId);
    }
    latestBoundaryRunId = normalizeOptionalString(segment.boundaryRunId) ?? latestBoundaryRunId;
  }
  const keyedSegments = segments.filter(
    (segment) => streamSegmentHasItemId(segment) && !streamSegmentUsesAccumulatedText(segment),
  );
  const indexedSegments = segments.filter(streamSegmentUsesAccumulatedText);
  const syntheticItemPrefixes = new Set(
    segments.filter((segment, index) =>
      streamSegmentIsSyntheticItemPrefix(segment, segments[index + 1]),
    ),
  );
  const toolLookup = createToolCallLookup<ChatProjection>();
  for (const tool of toolItems) {
    toolLookup.add(tool.runId, tool.callId, tool.projection);
  }
  const explicitlyOwnedTools = collectExplicitlyOwnedTools(segments, (runId, toolCallId) =>
    toolLookup.get(runId, toolCallId),
  );
  // Empty user rows may have disappeared since canvas placement. Preserve the
  // earlier current-turn fallback, but resolve exact bounds over rendered rows.
  const projectionRunBounds = createRunTurnLookup(executionItems());
  const resolveProjectionBounds = (
    runId: unknown,
    boundaryRunId?: string,
    afterBoundaryRunId?: string,
  ): TurnInsertionBounds | undefined => {
    const bounds =
      resolveRunInsertionBounds(projectionRunBounds, runId, currentRunId, currentTurnBounds) ??
      (!runId && activeInputKey ? currentTurnBounds : undefined);
    const boundaryKey = boundaryRunId ? projectionRunBounds(boundaryRunId)?.afterKey : undefined;
    const afterBounds = afterBoundaryRunId ? projectionRunBounds(afterBoundaryRunId) : undefined;
    return boundToPendingInputs(
      bounds || boundaryKey || afterBounds
        ? {
            ...bounds,
            ...(afterBounds?.afterKey ? { afterKey: afterBounds.afterKey } : {}),
            ...(afterBounds?.beforeKey ? { beforeKey: afterBounds.beforeKey } : {}),
            ...(boundaryKey ? { beforeKey: boundaryKey } : {}),
          }
        : undefined,
    );
  };
  if (!searchFiltering) {
    if (props.archiveNotice) {
      projections.push({ item: props.archiveNotice });
    }
    for (const notice of props.guardianNotices ?? []) {
      projections.push({
        item: buildGuardianNoticeItem(notice),
        bounds: resolveProjectionBounds(notice.runId),
      });
    }
  }
  const toolBeforeBoundaries = createToolCallLookup<string>();
  const toolAfterBoundaries = createToolCallLookup<string>();
  for (const segment of indexedSegments) {
    const callId = normalizeOptionalString(segment.toolCallId);
    const runId = normalizeOptionalString(segment.runId);
    const boundaryRunId = normalizeOptionalString(segment.boundaryRunId);
    const afterBoundaryRunId = afterBoundaryBySegment.get(segment);
    if (boundaryRunId) {
      toolBeforeBoundaries.add(runId, callId, boundaryRunId);
    }
    if (afterBoundaryRunId) {
      toolAfterBoundaries.add(runId, callId, afterBoundaryRunId);
    }
  }
  const appendStreamSegment = (
    segment: ChatStreamSegment,
    key: string,
    text: string,
    predecessorKey?: string,
  ) => {
    const afterBoundaryRunId = afterBoundaryBySegment.get(segment);
    projections.push({
      item: {
        kind: "stream",
        key,
        text,
        startedAt: segment.ts,
        isStreaming: false,
        ...optionalRunIdentity(segment.runId),
        ...optionalBoundaryIdentity(afterBoundaryRunId ?? segment.runId),
      },
      bounds: resolveProjectionBounds(segment.runId, segment.boundaryRunId, afterBoundaryRunId),
      ...(predecessorKey ? { predecessorKey } : {}),
    });
  };
  const previousAccumulatedStreamTextByRun = new Map<string | undefined, string | null>();
  const unkeyedByRun = new Map<string | undefined, string>();
  const previousAccumulatedItemIdByRun = new Map<string | undefined, string>();
  const previousAccumulatedItemStartByRun = new Map<string | undefined, number>();
  const previousOwnerBySegment = previousStreamOwnersBySegment(segments);
  const {
    emitAfterSegment: emitToolAfterSegment,
    emitRemaining: emitRemainingTools,
    previousToolKeyByRun: previousPositionalToolKeyByRun,
    resolveSegmentTool,
  } = createChatThreadToolPlacement({
    afterBoundaryBySegment,
    explicitlyOwnedTools,
    projections,
    resolveBounds: resolveProjectionBounds,
    showToolCalls: props.showToolCalls,
    syntheticItemPrefixes,
    toolItems,
    toolLookup,
    toolAfterBoundaries,
    toolBeforeBoundaries,
  });
  for (const [i, segment] of indexedSegments.entries()) {
    const text = sanitizeStreamText(segment.text);
    const usesAccumulatedText = streamSegmentUsesAccumulatedText(segment);
    const segmentItemId = normalizeOptionalString(segment.itemId);
    const runId = normalizeOptionalString(segment.runId);
    const toolCallId = normalizeOptionalString(segment.toolCallId);
    const previousText = previousAccumulatedStreamTextByRun.get(runId) ?? null;
    const previousVisibleText = visiblePrefix(segment, previousText, unkeyedByRun.get(runId));
    const inheritsUnkeyedText = previousVisibleText !== previousText;
    const previousOwner = previousOwnerBySegment.get(segment);
    const resetsAccumulatedText =
      !inheritsUnkeyedText &&
      streamSegmentResetsAccumulatedText(
        segment,
        previousOwner ? previousOwner.itemId : previousAccumulatedItemIdByRun.get(runId),
        previousVisibleText,
        runId,
        previousOwner
          ? previousOwner.itemStartOffset
          : previousAccumulatedItemStartByRun.get(runId),
      );
    const segmentPrefix =
      usesAccumulatedText && resetsAccumulatedText
        ? segment.displayStartOffset
          ? text.slice(0, segment.displayStartOffset)
          : null
        : previousVisibleText;
    const visibleText =
      usesAccumulatedText && (!resetsAccumulatedText || segmentPrefix)
        ? trimAccumulatedStreamPrefix(text, segmentPrefix)
        : text;
    if (usesAccumulatedText) {
      previousAccumulatedStreamTextByRun.set(
        runId,
        advanceAccumulatedStreamText(previousVisibleText, text, resetsAccumulatedText),
      );
      if (segmentItemId) {
        unkeyedByRun.delete(runId);
        previousAccumulatedItemIdByRun.set(runId, segmentItemId);
        if (segment.producerItemStartOffset !== undefined) {
          previousAccumulatedItemStartByRun.set(runId, segment.producerItemStartOffset);
        }
      } else if (previousText && !text.startsWith(previousText)) {
        unkeyedByRun.set(runId, text);
        previousAccumulatedItemIdByRun.delete(runId);
        previousAccumulatedItemStartByRun.delete(runId);
      }
    }
    if (visibleText.length > 0 && segment.persisted !== true) {
      const streamKey = `stream-seg:${props.sessionKey}:${i}`;
      appendStreamSegment(
        segment,
        streamKey,
        visibleText,
        previousPositionalToolKeyByRun.get(runId),
      );
      const tool = resolveSegmentTool(segment, runId, toolCallId);
      emitToolAfterSegment(segment, streamKey, tool, runId);
    } else if (toolCallId) {
      emitToolAfterSegment(segment, undefined, toolLookup.get(runId, toolCallId), runId);
    }
  }
  emitRemainingTools(toolItems, explicitlyOwnedTools);
  for (const segment of keyedSegments) {
    const text = sanitizeStreamText(segment.text);
    if (text.length > 0) {
      const streamKey = `stream-seg:${props.sessionKey}:${segment.itemId}`;
      appendStreamSegment(segment, streamKey, text);
      const runId = normalizeOptionalString(segment.runId);
      emitToolAfterSegment(
        segment,
        streamKey,
        toolLookup.get(runId, normalizeOptionalString(segment.toolCallId)),
        runId,
      );
    }
  }
  emitRemainingTools(toolItems);

  for (const prompt of props.questionPrompts ?? []) {
    // Pending questions live in the composer dock. Their terminal summaries are
    // timestamped transient projections, so keep their historical placement.
    if (prompt.status === "pending") {
      continue;
    }
    const questionItem: ChatItem = {
      kind: "question",
      key: `question:${prompt.id}`,
      questionId: prompt.id,
      startedAt: prompt.createdAtMs,
    };
    projections.push({
      item: questionItem,
      bounds: prompt.runId ? resolveProjectionBounds(prompt.runId) : undefined,
    });
  }

  // Unowned projections keep their user-turn floor despite clock skew;
  // identified live tools stay in the canonical invocation's interval.
  applyPersistedToolInvocationBounds(
    items,
    toolItems.map((tool) => tool.projection),
  );
  insertChatItemsByTimestamp(items, projections);

  // The active claw is telemetry, not a placeholder: it stays through visible
  // assistant text and tool cards until the run settles. The initial-load
  // skeleton still owns an otherwise empty thread, but not an active stream.
  const initialHistoryLoad = props.stream === null && props.loading === true && items.length === 0;
  // A non-null empty stream is the acknowledgement bridge before runWorking
  // catches up.
  const hasEmptyLiveStream = props.stream !== null && props.stream.trim().length === 0;
  const showWorkingIndicator =
    (!compaction || compaction.phase === "complete") &&
    ((props.runWorking === true && !initialHistoryLoad) ||
      hasEmptyLiveStream ||
      queuedSends.some(
        (item) =>
          (item.sendState === "submitting" || item.sendState === "sending") &&
          shouldRenderQueuedSendInThread(item),
      ));
  if (props.runWorking !== true && props.stream === null && !showWorkingIndicator) {
    clearWorkingProgress(props.sessionKey);
  }
  const persistedBoundary = currentRunId
    ? latestPersistedSteerBoundary(history, currentRunId)
    : null;
  const activeBoundaryRunId =
    persistedBoundary &&
    (!latestBoundaryRunId ||
      history.findIndex((message) => userTurnRunId(message) === latestBoundaryRunId) <=
        persistedBoundary.index)
      ? persistedBoundary.runId
      : latestBoundaryRunId;
  const activeTurnRunId = activeBoundaryRunId ?? currentRunId;
  const activeTurnBounds = boundToPendingInputs(
    (activeTurnRunId ? createRunTurnLookup(executionItems())(activeTurnRunId) : null) ??
      (activeInputKey ? { afterKey: activeInputKey } : null),
  );
  const appendActiveRunItem = (item: ChatItem) => {
    // Queued custody is a ceiling for the whole live response, not just its text.
    // Moving its working indicator past that ceiling splits and remeasures the run.
    if (activeTurnBounds) {
      const { maximum } = insertionIndexesForBounds(items, activeTurnBounds);
      items.splice(maximum, 0, item);
    } else {
      items.push(item);
    }
  };
  if (props.stream !== null) {
    const text = sanitizeStreamText(props.stream);
    const prefix = resolveCurrentStreamPrefix(
      accumulatedStreamTextForCurrent(
        segments,
        props.streamItemId,
        sanitizeStreamText,
        props.runId,
        text,
      ),
      props.streamItemId,
      props.streamItemPrefix,
      accumulatedStreamTextForItem(
        segments,
        props.streamItemId,
        sanitizeStreamText,
        props.runId,
        props.streamItemStartOffset,
      ),
      text,
    );
    const visibleText = trimAccumulatedStreamPrefix(text, prefix);
    if (visibleText.length > 0 && !stripHeartbeatTokenForDisplay(visibleText).shouldSkip) {
      const liveProgress = resolveProgress();
      const liveRunId = props.runId ?? liveProgress.runId;
      const liveStreamItem: ChatItem = {
        kind: "stream",
        key: activeBoundaryRunId
          ? `${liveProgress.key}:after:${activeBoundaryRunId}`
          : liveProgress.key,
        text: visibleText,
        startedAt: timestampAfterVisibleItems(items, props.streamStartedAt ?? Date.now()),
        isStreaming: true,
        ...optionalRunIdentity(liveRunId),
        ...optionalBoundaryIdentity(activeBoundaryRunId ?? liveRunId),
      };
      appendActiveRunItem(liveStreamItem);
    }
  }
  if (showWorkingIndicator) {
    const workingProgress = resolveProgress();
    const workingRunId = props.runId ?? workingProgress.runId;
    appendActiveRunItem({
      kind: "reading-indicator",
      key: workingProgress.key,
      startedAt: workingProgress.startedAt,
      ...optionalRunIdentity(workingRunId),
      ...optionalBoundaryIdentity(activeBoundaryRunId ?? workingRunId),
    });
  }
  return groupMessages(coalesceToolActivityMessages(items));
}
