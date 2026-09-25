import type { HumanMention } from "@openclaw/gateway-protocol";
import type { MediaKind } from "@openclaw/media-core/constants";
import type { ChatWorkContext } from "../../../../packages/gateway-protocol/src/chat-work-context.js";
/**
 * Chat message types for the UI layer.
 */
import type {
  AgentActivityItem,
  ChatSendIntent,
  QueueMode,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { extractCanvasFromText } from "../../../../src/chat/canvas-render.js";
import type { MessageClientSource } from "../../../../src/chat/message-client-source.js";
import type { ClawHubRecommendation } from "../../../../src/shared/clawhub-recommendations.js";
import type { BrowserTabTarget } from "../../components/browser/browser-target.ts";
import type { toolIcons } from "../../components/icons-tools.ts";
import type { SenderIdentity } from "./sender-label.ts";

export type { HumanMention };

export type BrowserAnnotationAttachment = {
  modelContext: string;
  title: string;
  displayUrl: string;
  markedRegionCount: number;
  inspectedElement: boolean;
};

export type ChatSelectionSource = {
  text: string;
  messageId?: string;
  entryId?: string;
  /** UTF-16 offsets in the source bubble’s concatenated DOM text nodes. */
  start: number;
  end: number;
};

export type ChatSelectionAnnotation = ChatSelectionSource & {
  comment: string;
  sessionKey: string;
};

export type ChatAttachment = {
  id: string;
  dataUrl?: string;
  previewUrl?: string;
  mimeType: string;
  origin?: "paste" | "file";
  fileName?: string;
  sizeBytes?: number;
  /** UI-local context that must remain coupled to its annotated screenshot. */
  browserAnnotation?: BrowserAnnotationAttachment;
  selectionAnnotation?: ChatSelectionAnnotation;
};

// Shared payload contract: draft and outbox storage must not import each other's runtime.
export type DurableComposerDraftAttachment = Omit<
  ChatAttachment,
  "id" | "dataUrl" | "previewUrl"
> & {
  blob: Blob;
};

export type ChatComposerDraftRetry = {
  expectedDraftRevision: number;
  draftRevision: number;
};

export type ChatReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
  sourceMessageId?: string | null;
};

export type ChatGoalDraftMode = { sessionId?: string } & (
  | { action: "start" }
  | { action: "edit"; goalId: string; previousDraft: string }
);

export type ChatGoalDraft = { sessionId?: string } & (
  | { action: "start"; objective: string }
  | { action: "edit"; goalId: string; objective: string }
);

export type ChatGoalAction = "pause" | "resume" | "clear";

export type ChatGoalRecovery = {
  pending: boolean;
  retired?: "expired" | "invalid";
  onCheck: () => Promise<boolean>;
};

export type ChatComposerMemoryFallback = {
  incognito?: boolean;
  awaitingDefaults?: true;
  goalMode?: ChatGoalDraftMode;
  replyTarget?: ChatReplyTarget;
  message: string;
  mentions?: readonly HumanMention[];
  attachments: ChatAttachment[];
  storageFailed: boolean;
  draftRetry?: ChatComposerDraftRetry;
  sequence: number;
};

export type ChatGuardianNotice = {
  key: string;
  runId: string;
  timestamp: number;
  kind: "approved" | "denied" | "reviewing" | "strict-review-required" | "warning";
  source?: "system";
  command?: string;
  riskLevel?: string;
  rationale?: string;
  message?: string;
};

export type { ToolApprovalReview } from "../../../../src/shared/tool-approval-reviews.js";

export type ChatQueueDisplayItem = ChatQueueItem & { serverQueued?: true };

export type ChatQueueItem = {
  id: string;
  /** UI question associated with this input; delivery and retry stay outbox-owned. */
  asyncQuestionItemId?: string;
  workContext?: ChatWorkContext;
  workContextUnavailable?: true;
  text: string;
  mentions?: readonly HumanMention[];
  createdAt: number;
  /** Stable arrival position; only an explicit reorder moves an existing input. */
  orderKey?: number;
  /** Immutable bytes belong to this queued input; routing belongs to the outbox metadata. */
  attachmentPayload?: { key: string; recoveryScope: string; tabId: string };
  attachmentStorageError?: "capacity" | "unavailable" | "missing";
  attachments?: ChatAttachment[];
  refreshSessions?: boolean;
  /** Transcript id of the replied-to message; Gateway hydrates reply context. */
  replyToId?: string;
  localCommandArgs?: string;
  localCommandName?: string;
  pendingRunId?: string;
  sendAttempts?: number;
  sendError?: string;
  sendRunId?: string;
  /** One-send override retained with the durable row for reconnect and retry. */
  queueMode?: QueueMode;
  /** Admission intent and its original issue time survive transport retries together. */
  intent?: ChatSendIntent;
  /** For structured admissions, preserve the originally selected session incarnation. */
  sessionId?: string;
  expectedLeafEntryId?: string | null;
  sendState?:
    // Process-local submission handoff; durable custody remains waiting-idle.
    | "submitting"
    | "waiting-model"
    | "waiting-idle"
    | "executing-command"
    | "sending"
    | "waiting-reconnect"
    | "unconfirmed"
    // Provider review requires a new operator decision even if delivery has prior attempts.
    | "held"
    | "failed";
  sendSubmittedAtMs?: number;
  sendRequestStartedAtMs?: number;
  sessionKey?: string;
  agentId?: string;
  sender?: SenderIdentity;
};

/** Union type for items in the chat thread */
export type ChatItem =
  | {
      kind: "message";
      key: string;
      message: unknown;
      duplicateCount?: number;
      /** A distinct input remains a presentation boundary before execution starts. */
      startsTurn?: true;
    }
  | {
      kind: "notice";
      key: string;
      text: string;
      timestamp: number;
      icon?: keyof typeof toolIcons;
      label?: string;
      startsTurn?: true;
      boundaryId?: string;
      tone?: "danger";
      /** Collapse the body behind a disclosure; the label line stays visible. */
      collapsedBody?: true;
    }
  | {
      kind: "divider";
      key: string;
      compaction?: "active" | "complete";
      compactionId?: string;
      label: string;
      icon?: keyof typeof toolIcons;
      metric?: string;
      description?: string;
      timestamp: number;
    }
  | {
      kind: "stream";
      key: string;
      text: string;
      startedAt: number;
      isStreaming: boolean;
      replyToSender?: SenderIdentity;
      runId?: string;
      boundaryId?: string;
    }
  | {
      kind: "reading-indicator";
      key: string;
      startedAt: number;
      runId?: string;
      boundaryId?: string;
    }
  | { kind: "question"; key: string; questionId: string; startedAt: number };

export type ChatStreamSegment = {
  text: string;
  ts: number;
  runId?: string;
  /** Persisted user send that causally precedes this transient output. */
  afterBoundaryRunId?: string;
  /** Persisted user send that causally follows this transient output. */
  boundaryRunId?: string;
  /** Ordering-only boundary with no renderable assistant text. */
  boundaryMarker?: true;
  /** Keyed item captured from the producer's cumulative chat projection. */
  cumulative?: true;
  /** UTF-16 offset where this keyed item starts in cumulative text. */
  itemStartOffset?: number;
  /** Producer-reported offset distinguishing reused item-ID occurrences. */
  producerItemStartOffset?: number;
  /** Derived prefix to hide when a cumulative projection skips an earlier sibling item. */
  displayStartOffset?: number;
  /** Client-derived cumulative prefix; does not own a positional tool. */
  syntheticItemPrefix?: true;
  /** Hidden durable replacement; cumulative text still owns the prefix baseline. */
  persisted?: true;
  /** Keyed item that consumed this cumulative occurrence; late updates cannot consume another. */
  retiredItemId?: string;
  /** In-flight handoff owned by the retired cumulative prefix, not its live display. */
  pendingCommentary?: {
    text: string;
    prefixLength: number;
    sourceMessageId?: string;
    replayItemId?: string;
    requiresReplayItemId?: boolean;
  };
  /** Earlier visible cumulative prefix preserved while a later commentary occurrence hands off. */
  pendingCommentaryPrefixFor?: string;
  toolCallId?: string;
  itemId?: string;
};

export function streamSegmentHasItemId(segment: { itemId?: unknown }): boolean {
  return typeof segment.itemId === "string" && segment.itemId.trim().length > 0;
}

export function streamSegmentIsSyntheticItemPrefix(
  segment: ChatStreamSegment,
  nextSegment: ChatStreamSegment | undefined,
): boolean {
  if (
    segment.syntheticItemPrefix !== true ||
    streamSegmentHasItemId(segment) ||
    (typeof segment.toolCallId === "string" && segment.toolCallId.trim().length > 0) ||
    nextSegment?.cumulative !== true ||
    !streamSegmentHasItemId(nextSegment) ||
    segment.runId !== nextSegment.runId ||
    !Number.isInteger(nextSegment.itemStartOffset)
  ) {
    return false;
  }
  const prefix = nextSegment.text.slice(0, nextSegment.itemStartOffset);
  return prefix === segment.text || prefix.replace(/(?:\r?\n){2}$/u, "") === segment.text;
}

export function streamSegmentUsesAccumulatedText(segment: {
  itemId?: unknown;
  boundaryMarker?: unknown;
  cumulative?: unknown;
}): boolean {
  return (
    segment.boundaryMarker !== true &&
    (segment.cumulative === true || !streamSegmentHasItemId(segment))
  );
}

export function streamSegmentResetsAccumulatedText(
  segment: {
    text: string;
    itemStartOffset?: unknown;
    producerItemStartOffset?: number;
    itemId?: unknown;
    runId?: unknown;
    boundaryMarker?: unknown;
    cumulative?: unknown;
  },
  previousItemId?: string,
  previousText?: string | null,
  previousRunId?: string,
  previousItemStartOffset?: number,
): boolean {
  if (!streamSegmentUsesAccumulatedText(segment)) {
    return false;
  }
  const runChanged =
    typeof segment.runId === "string" &&
    segment.runId.trim().length > 0 &&
    segment.runId.trim() !== previousRunId;
  if (runChanged) {
    return true;
  }
  if (segment.cumulative === true && previousText && !segment.text.startsWith(previousText)) {
    return true;
  }
  if (typeof segment.itemId !== "string") {
    return false;
  }
  if (
    segment.itemId.trim() === previousItemId &&
    segment.producerItemStartOffset !== undefined &&
    previousItemStartOffset !== undefined &&
    segment.producerItemStartOffset !== previousItemStartOffset
  ) {
    return true;
  }
  if (previousText && !segment.text.startsWith(previousText)) {
    return true;
  }
  return (
    segment.itemId.trim() !== previousItemId &&
    (segment.itemStartOffset === 0 || segment.itemStartOffset === undefined)
  );
}

/** Advance the accumulated-text tracker only when the segment genuinely
    extends it. A standalone (itemId-less) preamble whose text is not part of
    the cumulative run text must not become the prefix baseline: the next
    cumulative snapshot would fail the startsWith check and re-render every
    earlier segment's text. */
export function advanceAccumulatedStreamText(
  previousText: string | null,
  text: string,
  reset = false,
): string | null {
  if (!text.trim()) {
    return previousText;
  }
  return reset || previousText === null || text.startsWith(previousText) ? text : previousText;
}

export function trimAccumulatedStreamPrefix(text: string, previousText: string | null): string {
  if (!previousText || !text.startsWith(previousText)) {
    return text;
  }
  return text.slice(previousText.length).trimStart();
}

export function streamVisiblePrefix(
  segment: ChatStreamSegment,
  previousText: string | null,
  previousUnkeyedText?: string,
): string | null {
  return (!streamSegmentHasItemId(segment) || segment.producerItemStartOffset === undefined) &&
    previousUnkeyedText &&
    segment.text.startsWith(previousUnkeyedText)
    ? previousUnkeyedText
    : previousText;
}

export function accumulatedStreamState(
  segments: readonly ChatStreamSegment[],
  normalize: (text: string) => string = (text) => text,
  runId?: string | null,
): { text: string | null; itemId?: string } {
  let accumulated: string | null = null;
  let accumulatedItemId: string | undefined;
  let accumulatedItemStartOffset: number | undefined;
  let accumulatedRunId: string | undefined;
  let accumulatedUnkeyedText: string | undefined;
  for (const segment of segments) {
    if (runId && segment.runId && segment.runId !== runId) {
      continue;
    }
    if (streamSegmentUsesAccumulatedText(segment)) {
      const normalizedText = normalize(segment.text);
      const previousVisibleText =
        (!streamSegmentHasItemId(segment) || segment.producerItemStartOffset === undefined) &&
        accumulatedUnkeyedText &&
        normalizedText.startsWith(accumulatedUnkeyedText)
          ? accumulatedUnkeyedText
          : accumulated;
      const inheritsUnkeyedText = previousVisibleText !== accumulated;
      if (
        !streamSegmentHasItemId(segment) &&
        accumulated &&
        !normalizedText.startsWith(accumulated)
      ) {
        accumulatedUnkeyedText = normalizedText;
        accumulatedItemId = undefined;
        accumulatedItemStartOffset = undefined;
      }
      accumulated = advanceAccumulatedStreamText(
        previousVisibleText,
        normalizedText,
        !inheritsUnkeyedText &&
          streamSegmentResetsAccumulatedText(
            segment,
            accumulatedItemId,
            previousVisibleText,
            accumulatedRunId,
            accumulatedItemStartOffset,
          ),
      );
      if (streamSegmentHasItemId(segment)) {
        accumulatedUnkeyedText = undefined;
      }
      accumulatedItemId =
        typeof segment.itemId === "string" && segment.itemId.trim()
          ? segment.itemId.trim()
          : accumulatedItemId;
      accumulatedRunId =
        typeof segment.runId === "string" && segment.runId.trim()
          ? segment.runId.trim()
          : accumulatedRunId;
      accumulatedItemStartOffset = segment.producerItemStartOffset ?? accumulatedItemStartOffset;
    } else if (streamSegmentHasItemId(segment)) {
      accumulatedItemStartOffset = segment.producerItemStartOffset ?? accumulatedItemStartOffset;
      accumulatedItemId = segment.itemId!.trim();
      accumulatedRunId =
        typeof segment.runId === "string" && segment.runId.trim()
          ? segment.runId.trim()
          : accumulatedRunId;
    }
  }
  return {
    text: accumulated,
    ...(accumulatedItemId ? { itemId: accumulatedItemId } : {}),
  };
}

export function accumulatedStreamText(
  segments: readonly ChatStreamSegment[],
  normalize: (text: string) => string = (text) => text,
  runId?: string | null,
): string | null {
  return accumulatedStreamState(segments, normalize, runId).text;
}

export function accumulatedStreamTextForCurrent(
  segments: readonly ChatStreamSegment[],
  itemId: string | undefined,
  normalize: (text: string) => string = (text) => text,
  runId?: string | null,
  currentText?: string,
): string | null {
  const accumulated = accumulatedStreamText(segments, normalize, runId);
  if (itemId) {
    return accumulated;
  }
  let unkeyed: string | null = null;
  for (const segment of segments) {
    if (
      (runId && segment.runId && segment.runId !== runId) ||
      !streamSegmentUsesAccumulatedText(segment)
    ) {
      continue;
    }
    const text = normalize(segment.text);
    if (streamSegmentHasItemId(segment)) {
      unkeyed = null;
    } else if (
      (unkeyed && text.startsWith(unkeyed)) ||
      (accumulated && !text.startsWith(accumulated))
    ) {
      unkeyed = text;
    }
  }
  return unkeyed && currentText?.startsWith(unkeyed) ? unkeyed : accumulated;
}

export function accumulatedStreamTextForItem(
  segments: readonly ChatStreamSegment[],
  itemId: string | undefined,
  normalize: (text: string) => string = (text) => text,
  runId?: string | null,
  itemStartOffset?: number,
): string | null {
  if (!itemId) {
    return null;
  }
  let accumulated: string | null = null;
  let accumulatedItemId: string | undefined;
  let accumulatedItemStartOffset: number | undefined;
  let accumulatedRunId: string | undefined;
  for (const segment of segments) {
    if (runId && segment.runId && segment.runId !== runId) {
      continue;
    }
    if (!streamSegmentUsesAccumulatedText(segment)) {
      if (streamSegmentHasItemId(segment)) {
        accumulatedItemId = segment.itemId!.trim();
        accumulatedItemStartOffset = segment.producerItemStartOffset ?? accumulatedItemStartOffset;
        accumulatedRunId =
          typeof segment.runId === "string" && segment.runId.trim()
            ? segment.runId.trim()
            : accumulatedRunId;
      }
      continue;
    }
    const ownerItemId = segment.itemId ?? segment.retiredItemId;
    const normalizedText = normalize(segment.text);
    if (
      ownerItemId === itemId &&
      itemStartOffset !== undefined &&
      segment.producerItemStartOffset !== undefined &&
      segment.producerItemStartOffset !== itemStartOffset
    ) {
      accumulated = null;
      accumulatedItemId = undefined;
      accumulatedItemStartOffset = undefined;
      continue;
    }
    if (!ownerItemId && accumulated && !normalizedText.startsWith(accumulated)) {
      accumulated = null;
      accumulatedItemId = undefined;
      accumulatedItemStartOffset = undefined;
    }
    if (
      ownerItemId !== itemId &&
      segment.persisted === true &&
      accumulated?.startsWith(normalizedText)
    ) {
      accumulatedItemId = ownerItemId?.trim() || accumulatedItemId;
      accumulatedItemStartOffset = segment.producerItemStartOffset ?? accumulatedItemStartOffset;
      accumulatedRunId =
        typeof segment.runId === "string" && segment.runId.trim()
          ? segment.runId.trim()
          : accumulatedRunId;
      continue;
    }
    const resetsAccumulatedText = streamSegmentResetsAccumulatedText(
      { ...segment, itemId: ownerItemId },
      accumulatedItemId,
      accumulated,
      accumulatedRunId,
      accumulatedItemStartOffset,
    );
    if (resetsAccumulatedText && segment.itemId !== itemId) {
      accumulated = null;
    }
    if (ownerItemId === itemId) {
      accumulated = advanceAccumulatedStreamText(
        accumulated,
        normalizedText,
        resetsAccumulatedText,
      );
    }
    accumulatedItemId = ownerItemId?.trim() || accumulatedItemId;
    accumulatedItemStartOffset = segment.producerItemStartOffset ?? accumulatedItemStartOffset;
    accumulatedRunId =
      typeof segment.runId === "string" && segment.runId.trim()
        ? segment.runId.trim()
        : accumulatedRunId;
  }
  return accumulatedItemId === itemId ? accumulated : null;
}

export function resolveCurrentStreamPrefix(
  accumulated: string | null,
  itemId: string | undefined,
  itemPrefix: string | undefined,
  sameItemText: string | null = null,
  currentText?: string,
): string | null {
  if (!itemId) {
    return accumulated;
  }
  if (sameItemText) {
    return itemPrefix && itemPrefix.startsWith(sameItemText) ? itemPrefix : sameItemText;
  }
  if (!itemPrefix || !accumulated) {
    return null;
  }
  const completesParagraphSeparator =
    itemPrefix.startsWith(accumulated) &&
    /^(?:\r?\n)+$/u.test(itemPrefix.slice(accumulated.length)) &&
    /(?:\r?\n){2}$/u.test(itemPrefix);
  const startsAfterParagraphSeparator =
    itemPrefix.startsWith(accumulated) &&
    /^(?:\r?\n){2}/u.test(itemPrefix.slice(accumulated.length));
  if (itemPrefix === accumulated || startsAfterParagraphSeparator || completesParagraphSeparator) {
    if (completesParagraphSeparator) {
      return itemPrefix;
    }
    return accumulated;
  }
  if (accumulated.startsWith(itemPrefix)) {
    return currentText?.startsWith(itemPrefix) && !currentText.startsWith(accumulated)
      ? itemPrefix
      : accumulated;
  }
  return null;
}

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  senderLabel?: string | null;
  senderSession?: { sessionKey?: string; agentId?: string; label?: string } | null;
  sender?: SenderIdentity;
  sourceClients?: MessageClientSource[];
  replyToSender?: SenderIdentity;
  messages: Array<{
    message: unknown;
    key: string;
    duplicateCount?: number;
    /** Rendered reply content, excluding assistant thinking tags. */
    hasVisibleContent: boolean;
  }>;
  visibleContent: "none" | "text" | "non-text";
  timestamp: number;
  isStreaming: boolean;
  runId?: string;
};

export type MessageImageSource = {
  url?: string;
  dataUrl?: string;
  preferData?: true;
  mimeType?: string;
  artifactId?: string;
  fileName?: string;
  openUrl?: string;
  alt?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
};

/** Content item types in a normalized message */
export type MessageContentItem =
  | ClawHubRecommendation
  | {
      type: "image";
      sources: MessageImageSource[];
      /** Canonical image blocks consume a persisted inline-layout slot, even if empty. */
      inlineSlot?: true;
      expiresAtMs?: number;
    }
  | {
      type: "text" | "tool_call" | "tool_result";
      text?: string;
      name?: string;
      args?: unknown;
    }
  | {
      type: "thinking";
      thinking: string;
    }
  | {
      type: "omitted_media";
      media: {
        kind: "image";
        sizeBytes?: number;
      };
    }
  | {
      type: "attachment";
      attachment: {
        url: string;
        kind: Exclude<MediaKind, "sticker" | "unknown">;
        label: string;
        mimeType?: string;
        origin?: "paste" | "file";
        isVoiceNote?: boolean;
        artifactId?: string;
        playback?: "native" | "transcode";
        sizeBytes?: number;
        durationMs?: number;
        width?: number;
        height?: number;
      };
    }
  | {
      type: "attachment_error";
      attachment: {
        code: "file-not-found" | "unsupported-format" | "delivery-failed";
        kind: Exclude<MediaKind, "sticker" | "unknown">;
        label: string;
        mimeType?: string;
      };
    }
  | {
      type: "canvas";
      preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
      rawText?: string | null;
    };

/** Normalized message structure for rendering */
export type NormalizedMessage = {
  role: string;
  content: MessageContentItem[];
  timestamp: number;
  id?: string;
  senderLabel?: string | null;
  senderSession?: { sessionKey?: string; agentId?: string; label?: string } | null;
  sender?: SenderIdentity;
  sourceClients?: MessageClientSource[];
  audioAsVoice?: boolean;
  replyPreview?: { text: string; senderLabel?: string | null };
  replyTarget?:
    | {
        kind: "current";
      }
    | {
        kind: "id";
        id: string;
      }
    | null;
};

export type ToolOutputMetadata = {
  source: "provider-response" | "execution";
  modelInput: "unverified";
  outcome?: "unknown";
  captureTruncated?: true;
};

/** Tool card representation for inline tool call/result rendering */
export type ToolCard = {
  id: string;
  callId?: string;
  runId?: string;
  parentToolCallId?: string;
  name: string;
  args?: unknown;
  inputText?: string;
  outputText?: string;
  /** Result identity stays distinct from the assistant call after presentation grouping. */
  resultMessageId?: string;
  /** Gateway display projection omitted content; the durable result may still be complete. */
  outputTruncated?: boolean;
  toolOutput?: ToolOutputMetadata;
  /** Structured tool result details (e.g. the edit tool's precomputed diff). */
  details?: unknown;
  /** Monotonic edit counts while a live tool call is still receiving input. */
  liveDiffStat?: { added: number; removed: number };
  /** Producer-reported process exit code, when the result supplies one. */
  exitCode?: number;
  isError?: boolean;
  /** Prepared presentation facts; never replace the raw execution fields above. */
  activity?: AgentActivityItem;
  /** True when the card comes from the live tool stream of the current run. */
  live?: boolean;
  /** True once a result landed, including historical results with empty output. */
  completed?: boolean;
  messageId?: string;
  /** UI-local preview identity for results without a call or transcript id. */
  previewRevision?: string;
  /** Tab actions can identify a route without a previewable page URL. */
  browserTab?: BrowserTabTarget;
  preview?:
    | (NonNullable<ReturnType<typeof extractCanvasFromText>> & { surface: "assistant_message" })
    | (BrowserTabTarget & { kind: "browser-tab"; url: string; title?: string });
};

export type ToolCardOutcome =
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "unknown";
