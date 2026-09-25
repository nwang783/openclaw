import {
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
} from "@openclaw/gateway-client/browser";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import {
  accumulatedStreamText,
  advanceAccumulatedStreamText,
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { resolveCumulativeAssistantTail } from "./stream-causal-boundary.ts";
import {
  commentaryProjection,
  matchCommentaryOccurrence,
  matchTrailingCommentaryOccurrence,
} from "./stream-commentary-matching.ts";
import {
  visibleAssistantStreamParts,
  type ToolStreamReconciliationState,
} from "./stream-reconciliation.ts";
import {
  accumulatedRunText,
  completePendingCommentary,
  discardStreamSegmentIndexes,
  findRetiredCommentarySegment,
  hasLiveItemSegment,
  pendingCommentaryStart,
  persistedItemSegmentSelection,
  pruneStreamStateSegments,
} from "./stream-segment-retirement.ts";
export { pruneHistoryReplacedStreamSegments } from "./stream-history-pruning.ts";
export { prunePersistedToolStreamMessages } from "./tool-stream-pruning.ts";

export function reconcilePersistedAssistantStream(
  state: ToolStreamReconciliationState,
  replayedCommentaryItemId?: string,
): { itemId: string; prefix: string } | undefined {
  const runId = state.chatRunId;
  if (!runId) {
    return undefined;
  }
  const settledReplayPrefixes = new Map<string, string>();
  let settledReplay: { itemId: string; prefix: string } | undefined;
  let settledIdFreeReplayText: string | undefined;
  for (const segment of state.chatStreamSegments ?? []) {
    if (segment.runId !== runId || !segment.retiredItemId || !segment.pendingCommentary) {
      continue;
    }
    if (segment.pendingCommentary.requiresReplayItemId && !replayedCommentaryItemId) {
      continue;
    }
    if (!replayedCommentaryItemId && settledIdFreeReplayText === segment.pendingCommentary.text) {
      continue;
    }
    if (
      segment.pendingCommentary.replayItemId &&
      replayedCommentaryItemId &&
      segment.pendingCommentary.replayItemId !== replayedCommentaryItemId
    ) {
      const source = state.chatStreamItemPrefix;
      if (source === undefined) {
        continue;
      }
      const settledPrefix = accumulatedRunText(
        (state.chatStreamSegments ?? []).filter(
          (owner) => owner.retiredItemId && owner.pendingCommentary === undefined,
        ),
        runId,
      );
      const pendingText = segment.pendingCommentary.text;
      const visiblePrefixOwner = (state.chatStreamSegments ?? []).find(
        (owner) =>
          owner.runId === runId &&
          Boolean(owner.pendingCommentaryPrefixFor) &&
          source.startsWith(owner.text) &&
          matchCommentaryOccurrence(owner.text, pendingText) !== null,
      );
      const visiblePrefixMatch = visiblePrefixOwner
        ? matchCommentaryOccurrence(visiblePrefixOwner.text, pendingText)
        : null;
      const searchStart = Math.max(
        segment.pendingCommentary.prefixLength,
        !visiblePrefixMatch && settledPrefix && source.startsWith(settledPrefix)
          ? settledPrefix.length
          : 0,
      );
      const tail = source.slice(searchStart);
      const match = visiblePrefixMatch ?? matchCommentaryOccurrence(tail, pendingText);
      if (!match) {
        continue;
      }
      const matchStart = (visiblePrefixMatch ? 0 : searchStart) + match.index;
      const matchEnd = matchStart + match[0].length;
      const separator = /^(?:[ \t]*\r?\n){2}/u.exec(source.slice(matchEnd))?.[0] ?? "";
      const itemEnd = matchEnd + (visiblePrefixMatch ? separator.length : 0);
      const visiblePrefix = source.slice(0, matchStart);
      const accumulated = accumulatedRunText(state.chatStreamSegments ?? [], runId);
      const visibleTail =
        accumulated && visiblePrefix.startsWith(accumulated)
          ? visiblePrefix.slice(accumulated.length)
          : visiblePrefix;
      if (
        visibleTail.trim() &&
        advanceAccumulatedStreamText(accumulated, visiblePrefix) !== accumulated
      ) {
        const baseline = source.slice(0, segment.pendingCommentary.prefixLength);
        state.chatStreamSegments = [
          ...(state.chatStreamSegments ?? []).filter(
            (owner) =>
              owner.pendingCommentaryPrefixFor !== segment.retiredItemId &&
              !(
                owner.runId === runId &&
                owner.persisted !== true &&
                !owner.itemId &&
                !owner.toolCallId &&
                !owner.boundaryRunId &&
                !owner.afterBoundaryRunId &&
                owner.text === baseline
              ),
          ),
          {
            text: visiblePrefix,
            ts: state.chatStreamStartedAt ?? segment.ts,
            runId,
            pendingCommentaryPrefixFor: segment.retiredItemId,
          },
        ];
      }
      const retiredPrefix = source.slice(0, itemEnd);
      state.chatStreamSegments = state.chatStreamSegments
        ?.map((owner) =>
          owner === segment
            ? { ...owner, text: retiredPrefix, pendingCommentary: undefined }
            : owner,
        )
        .filter(
          (owner) =>
            owner !== visiblePrefixOwner || itemEnd < (visiblePrefixOwner?.text.length ?? 0),
        );
      continue;
    }
    const commentary = {
      runId,
      itemId: segment.retiredItemId,
      text: segment.pendingCommentary.text,
      timestamp: segment.ts,
      ...(segment.pendingCommentary.sourceMessageId
        ? { sourceMessageId: segment.pendingCommentary.sourceMessageId }
        : {}),
    };
    const settledPrefix = settledReplayPrefixes.get(segment.retiredItemId);
    if (settledPrefix) {
      const receipt = findRetiredCommentarySegment(state.chatStreamSegments ?? [], commentary);
      const pending = receipt?.pendingCommentary;
      if (pending && pending.prefixLength < settledPrefix.length) {
        state.chatStreamSegments = state.chatStreamSegments?.map((owner) =>
          owner === receipt
            ? {
                ...owner,
                pendingCommentary: {
                  ...pending,
                  prefixLength: settledPrefix.length,
                },
              }
            : owner,
        );
      }
    }
    const handoff = retireCommentaryStream(state, commentary);
    if (handoff) {
      if (!replayedCommentaryItemId) {
        settledIdFreeReplayText = segment.pendingCommentary.text;
      }
      settledReplayPrefixes.set(
        segment.retiredItemId,
        handoff.prefix ?? state.chatStream ?? segment.text,
      );
      settledReplay = {
        itemId: segment.retiredItemId,
        prefix: handoff.prefix ?? state.chatStream ?? segment.text,
      };
      if (state.chatStreamItemId === segment.retiredItemId && state.chatStream !== null) {
        state.chatStreamItemPrefix = state.chatStream;
      }
    }
  }
  const stream = state.chatStream ?? accumulatedRunText(state.chatStreamSegments ?? [], runId);
  if (!stream) {
    return settledReplay;
  }
  const messages = (state.chatMessages ?? []).filter((message) => {
    const identity = readSessionMessageIdentity(message);
    return (
      identity?.role === "assistant" &&
      identity.id &&
      !identity.isImported &&
      identity.runId === runId &&
      !readAssistantStreamSegmentIdentity(message)
    );
  });
  const tail = resolveCumulativeAssistantTail(messages, stream, runId);
  const prefix = stream.slice(0, stream.length - (tail?.length ?? 0));
  if (!prefix) {
    return settledReplay;
  }
  retireCumulativePrefix(state, runId, prefix, Date.now());
  return settledReplay;
}

function retireCumulativePrefix(
  state: ToolStreamReconciliationState,
  runId: string,
  prefix: string,
  timestamp: number,
  retirement?: { itemId: string; segmentIndex?: number },
): void {
  const stream = state.chatStream ?? accumulatedRunText(state.chatStreamSegments ?? [], runId);
  let segments = state.chatStreamSegments ?? [];
  const accumulated = state.chatStream === null ? stream : accumulatedRunText(segments, runId);
  const shouldPrune = (segment: ChatStreamSegment, index: number) =>
    (!retirement || index === retirement.segmentIndex) &&
    segment.persisted !== true &&
    segment.runId === runId &&
    streamSegmentUsesAccumulatedText(segment) &&
    prefix.startsWith(segment.text);
  // Preserve renderer identity fast paths when persistence retires no segments.
  if (segments.some(shouldPrune)) {
    segments = pruneStreamStateSegments(state, runId, shouldPrune, retirement?.itemId);
    state.chatStreamSegments = segments;
  }
  if (retirement?.itemId === state.chatStreamItemId) {
    state.chatStreamItemPrefix = prefix;
  }
  if (accumulated?.startsWith(prefix)) {
    return;
  }
  const resetsProjection = Boolean(accumulated && !prefix.startsWith(accumulated));
  // Persistence can overtake chat deltas. Retire only the observed cumulative
  // prefix; keep the received buffer intact so later deltas cannot restart it.
  const last = segments.at(-1);
  const extendsPersisted =
    last?.persisted &&
    last.runId === runId &&
    !last.boundaryRunId &&
    !last.toolCallId &&
    !last.retiredItemId &&
    !retirement;
  state.chatStreamSegments = [
    ...(extendsPersisted ? segments.slice(0, -1) : segments),
    {
      ...(extendsPersisted ? last : {}),
      text: prefix,
      ts: state.chatStreamStartedAt ?? timestamp,
      runId,
      persisted: true,
      ...(retirement
        ? {
            retiredItemId: retirement.itemId,
            ...(resetsProjection
              ? { itemId: retirement.itemId, cumulative: true as const, itemStartOffset: 0 }
              : {}),
          }
        : {}),
    },
  ];
}

/** Transfer one cumulative occurrence to its first keyed owner. */
export function retireCommentaryStream(
  state: ToolStreamReconciliationState,
  commentary: {
    runId: string;
    itemId: string;
    text: string;
    timestamp: number;
    sourceMessageId?: string;
  },
): { text: string; prefix?: string } | null {
  if (state.chatRunId !== commentary.runId) {
    return null;
  }
  const segments = state.chatStreamSegments ?? [];
  const retired = findRetiredCommentarySegment(segments, commentary);
  if (retired?.pendingCommentary) {
    // Item revisions replace the expected text; only the observed cumulative
    // prefix must stay monotonic. Keep that update even while chat lags behind.
    const owner =
      retired.pendingCommentary && retired.pendingCommentary.text !== commentary.text
        ? { ...retired, pendingCommentary: { ...retired.pendingCommentary, text: commentary.text } }
        : retired;
    if (owner !== retired) {
      state.chatStreamSegments = state.chatStreamSegments?.map((segment) =>
        segment === retired ? owner : segment,
      );
    }
    return completePendingCommentary(state, owner);
  }
  if (
    retired &&
    !segments.some(
      (segment) =>
        segment.runId === commentary.runId &&
        segment.persisted !== true &&
        segment.itemId === commentary.itemId &&
        (segment.itemStartOffset === undefined || segment.itemStartOffset < segment.text.length),
    )
  ) {
    return null;
  }
  // Only the first keyed event can acquire an unowned cumulative occurrence.
  // A later update without a pending retirement must not consume new output.
  if (
    state.chatStreamSegments?.some(
      (segment) =>
        segment.runId === commentary.runId &&
        segment.persisted !== true &&
        segment.itemId === commentary.itemId,
    )
  ) {
    return null;
  }
  const part = visibleAssistantStreamParts(state, {
    includeCurrent: true,
    isHiddenStreamText: () => false,
  }).at(-1);
  if (
    !part ||
    (part.itemId && part.itemId !== commentary.itemId) ||
    part.runId !== commentary.runId ||
    part.boundaryRunId
  ) {
    return null;
  }
  const preceding = (state.chatStreamSegments ?? []).slice(0, part.segmentIndex);
  const prefix = accumulatedRunText(preceding, commentary.runId);
  const rawTail =
    prefix && part.replacementText.startsWith(prefix)
      ? part.replacementText.slice(prefix.length)
      : part.replacementText;
  const text = stripInlineDirectiveTagsForDelivery(rawTail)
    .text.replace(/^(?:[ \t]*\r?\n)+/u, "")
    .trimEnd();
  // The preamble producer flattens whitespace. Keep the cumulative formatting
  // when that exact projection identifies the same complete occurrence.
  const projectedText = text.replace(/\s+/gu, " ").trim();
  if (!text || (text !== commentary.text && projectedText !== commentary.text)) {
    if (!projectedText || !commentary.text.startsWith(projectedText)) {
      return null;
    }
    // Retire observed bytes immediately. Keep completion with the cumulative
    // owner so replacing the keyed display with history cannot lose the handoff.
    retireCumulativePrefix(state, commentary.runId, part.replacementText, commentary.timestamp, {
      itemId: commentary.itemId,
      segmentIndex: part.segmentIndex,
    });
    state.chatStreamSegments = state.chatStreamSegments?.map((segment) =>
      segment.runId === commentary.runId && segment.retiredItemId === commentary.itemId
        ? {
            ...segment,
            pendingCommentary: {
              text: commentary.text,
              prefixLength: prefix?.length ?? 0,
              ...(commentary.sourceMessageId
                ? { sourceMessageId: commentary.sourceMessageId }
                : {}),
            },
          }
        : segment,
    );
    return { text: commentary.text };
  }
  retireCumulativePrefix(state, commentary.runId, part.replacementText, commentary.timestamp, {
    itemId: commentary.itemId,
    segmentIndex: part.segmentIndex,
  });
  return { text };
}

/** A durable commentary row immediately replaces its keyed live projection.
 * Waiting for terminal cleanup renders both copies throughout the active run. */
export function prunePersistedAssistantStreamSegments(
  state: ToolStreamReconciliationState,
  message: unknown,
): void {
  const identity = readAssistantStreamSegmentIdentity(message);
  if (!identity || !state.chatStreamSegments) {
    return;
  }
  const initialSegments = state.chatStreamSegments;
  const text = extractTextCached(message);
  const sourceMessageId = readSessionMessageIdentity(message)?.id;
  const persistedSelection = persistedItemSegmentSelection(
    initialSegments,
    identity,
    text,
    state.chatStreamItemId,
    state.chatStreamItemStartOffset ?? state.chatStreamItemPrefix?.length,
    state.chatStream,
  );
  const replacedIndexes = persistedSelection.indexes;
  if (replacedIndexes.length === 0) {
    const runId = identity.runId ?? state.chatRunId;
    const retiredIndex = state.chatStreamSegments.findLastIndex(
      (segment) => segment.runId === runId && segment.retiredItemId === identity.itemId,
    );
    const reusedAfterRetirement = state.chatStreamSegments.some(
      (segment, index) =>
        index > retiredIndex &&
        segment.runId === runId &&
        segment.persisted !== true &&
        streamSegmentHasItemId(segment) &&
        segment.itemId !== identity.itemId,
    );
    const hasMatchingPendingReceipt = state.chatStreamSegments.some(
      (segment) =>
        segment.runId === runId &&
        segment.retiredItemId === identity.itemId &&
        segment.pendingCommentary?.text === text &&
        (sourceMessageId
          ? segment.pendingCommentary.sourceMessageId === sourceMessageId
          : segment.pendingCommentary.sourceMessageId === undefined),
    );
    const hasDifferentPendingReceipt = state.chatStreamSegments.some(
      (segment) =>
        segment.runId === runId &&
        segment.retiredItemId === identity.itemId &&
        segment.pendingCommentary &&
        segment.pendingCommentary.text !== text,
    );
    if (
      runId &&
      runId === state.chatRunId &&
      text &&
      (state.chatStreamItemId === identity.itemId ||
        retiredIndex < 0 ||
        reusedAfterRetirement ||
        !hasMatchingPendingReceipt)
    ) {
      if (!state.chatStreamItemId || state.chatStreamItemId === identity.itemId) {
        const stream = state.chatStream ?? "";
        const match = matchTrailingCommentaryOccurrence(stream, text);
        const prefix = state.chatStreamItemPrefix || (match ? stream.slice(0, match.index) : "");
        const accumulated = accumulatedStreamText(
          state.chatStreamSegments,
          (segmentText) => segmentText,
          runId,
        );
        if (prefix && advanceAccumulatedStreamText(accumulated, prefix) !== accumulated) {
          state.chatStreamSegments = [
            ...state.chatStreamSegments,
            {
              text: prefix,
              ts: state.chatStreamStartedAt ?? Date.now(),
              runId,
              pendingCommentaryPrefixFor: identity.itemId,
            },
          ];
        }
        const handoff =
          state.chatStream === null && hasDifferentPendingReceipt
            ? null
            : retireCommentaryStream(state, {
                runId,
                itemId: identity.itemId,
                text,
                timestamp: Date.now(),
                ...(sourceMessageId ? { sourceMessageId } : {}),
              });
        if (handoff) {
          return;
        }
      }
      if (state.chatStreamItemId && state.chatStreamItemId !== identity.itemId) {
        const source = state.chatStreamItemPrefix;
        if (source === undefined) {
          return;
        }
        const accumulated = accumulatedRunText(state.chatStreamSegments, runId);
        const retiredPrefix = accumulatedRunText(
          state.chatStreamSegments.filter((segment) => Boolean(segment.retiredItemId)),
          runId,
        );
        const visiblePrefixMatch = state.chatStreamSegments
          .filter(
            (segment) =>
              segment.runId === runId &&
              Boolean(segment.pendingCommentaryPrefixFor) &&
              source.startsWith(segment.text),
          )
          .map((segment) => matchCommentaryOccurrence(segment.text, text))
          .find((candidate): candidate is RegExpExecArray => candidate !== null);
        const searchStart =
          !visiblePrefixMatch && retiredPrefix && source.startsWith(retiredPrefix)
            ? retiredPrefix.length
            : 0;
        const match =
          visiblePrefixMatch ?? matchCommentaryOccurrence(source.slice(searchStart), text);
        const matchStart = match ? (visiblePrefixMatch ? 0 : searchStart) + match.index : 0;
        const matchEnd = match ? matchStart + match[0].length : 0;
        if (match) {
          const separator = /^(?:[ \t]*\r?\n){2}/u.exec(source.slice(matchEnd))?.[0] ?? "";
          const itemEnd = matchEnd + (visiblePrefixMatch ? separator.length : 0);
          const retirementSegmentIndex = state.chatStreamSegments.findLastIndex(
            (segment) =>
              segment.runId === runId &&
              segment.persisted !== true &&
              streamSegmentUsesAccumulatedText(segment) &&
              segment.text.length >= itemEnd &&
              source.startsWith(segment.text),
          );
          const visiblePrefix = source.slice(0, matchStart);
          if (
            visiblePrefix &&
            (retirementSegmentIndex >= 0 ||
              advanceAccumulatedStreamText(accumulated, visiblePrefix) !== accumulated)
          ) {
            state.chatStreamSegments = [
              ...state.chatStreamSegments,
              {
                text: visiblePrefix,
                ts: state.chatStreamStartedAt ?? Date.now(),
                runId,
                pendingCommentaryPrefixFor: identity.itemId,
              },
            ];
          }
          retireCumulativePrefix(state, runId, source.slice(0, itemEnd), Date.now(), {
            itemId: identity.itemId,
            ...(retirementSegmentIndex >= 0 ? { segmentIndex: retirementSegmentIndex } : {}),
          });
          return;
        }
      }
      const accumulated = accumulatedRunText(state.chatStreamSegments, runId);
      const currentStream = state.chatStream;
      const baseline = currentStream ?? accumulated ?? "";
      const rewritesCurrentItem =
        currentStream !== null && state.chatStreamItemId === identity.itemId;
      if (rewritesCurrentItem) {
        state.chatStreamItemPrefix = currentStream;
      }
      const segments =
        !rewritesCurrentItem &&
        baseline &&
        advanceAccumulatedStreamText(accumulated, baseline) !== accumulated
          ? [
              ...state.chatStreamSegments,
              {
                text: baseline,
                ts: state.chatStreamStartedAt ?? Date.now(),
                runId,
                pendingCommentaryPrefixFor: identity.itemId,
              },
            ]
          : state.chatStreamSegments;
      // Persistence arrived before this commentary occurrence reached the
      // cumulative chat stream. Roll the observed prefix into its own visible
      // segment, then keep a one-occurrence receipt anchored after that prefix.
      const waitsForReusedItem = hasLiveItemSegment(initialSegments, runId, identity.itemId);
      state.chatStreamSegments = [
        ...segments,
        {
          text: baseline,
          ts: Date.now(),
          runId,
          persisted: true,
          retiredItemId: identity.itemId,
          pendingCommentary: {
            text,
            prefixLength: baseline.length,
            ...(sourceMessageId ? { sourceMessageId } : {}),
            replayItemId: identity.itemId,
            ...(waitsForReusedItem ? { requiresReplayItemId: true } : {}),
          },
        },
      ];
    }
    return;
  }
  const currentItemText =
    state.chatStreamItemId === identity.itemId && state.chatStream
      ? state.chatStream.slice(state.chatStreamItemPrefix?.length ?? 0)
      : undefined;
  const currentItemSnapshot =
    state.chatStream &&
    currentItemText &&
    text &&
    commentaryProjection(currentItemText) === commentaryProjection(text)
      ? state.chatStream
      : undefined;
  const rewritesContinuedCurrentItem =
    !currentItemSnapshot &&
    persistedSelection.usedFallback &&
    state.chatStreamItemId === identity.itemId &&
    state.chatStream !== null;
  const completedCurrentItemSnapshot =
    !currentItemSnapshot &&
    currentItemText &&
    text &&
    commentaryProjection(text).startsWith(commentaryProjection(currentItemText))
      ? `${state.chatStreamItemPrefix ?? ""}${text}`
      : undefined;
  const laterItemPrefix =
    state.chatStreamItemId && state.chatStreamItemId !== identity.itemId
      ? state.chatStreamItemPrefix
      : undefined;
  const replaced = new Set(replacedIndexes);
  const pendingPrefixLength = replacedIndexes
    .map((index) => initialSegments[index])
    .filter((segment): segment is ChatStreamSegment => segment !== undefined)
    .map((segment) => pendingCommentaryStart(segment, text ?? ""))
    .at(-1);
  state.chatStreamSegments = state.chatStreamSegments.map((segment, index) => {
    if (!replaced.has(index) || !segment.cumulative) {
      return segment;
    }
    let nextSegment = segment;
    if (laterItemPrefix && text) {
      const searchStart = segment.itemStartOffset ?? 0;
      const match = matchCommentaryOccurrence(laterItemPrefix.slice(searchStart), text);
      const matchEnd = match ? searchStart + match.index + match[0].length : 0;
      const durablePrefix = matchEnd > 0 ? laterItemPrefix.slice(0, matchEnd) : "";
      if (durablePrefix.startsWith(segment.text)) {
        nextSegment = { ...segment, text: durablePrefix };
      }
    }
    if (
      currentItemSnapshot &&
      commentaryProjection(currentItemSnapshot).startsWith(commentaryProjection(nextSegment.text))
    ) {
      nextSegment = { ...nextSegment, text: currentItemSnapshot };
    }
    if (nextSegment.itemStartOffset !== undefined) {
      return nextSegment;
    }
    const trailing = text ? matchTrailingCommentaryOccurrence(nextSegment.text, text) : null;
    if (trailing) {
      return { ...nextSegment, itemStartOffset: trailing.index };
    }
    if (text) {
      const inferredStart = pendingCommentaryStart(nextSegment, text);
      if (inferredStart < nextSegment.text.length) {
        return { ...nextSegment, itemStartOffset: inferredStart };
      }
    }
    return currentItemSnapshot ? { ...nextSegment, itemStartOffset: 0 } : nextSegment;
  });
  discardStreamSegmentIndexes(state, replacedIndexes, identity.itemId);
  const runId = identity.runId ?? state.chatRunId;
  if (!currentItemSnapshot && runId && text && pendingPrefixLength !== undefined) {
    state.chatStreamSegments = state.chatStreamSegments.map((segment) => {
      if (
        segment.runId !== runId ||
        segment.retiredItemId !== identity.itemId ||
        segment.pendingCommentary
      ) {
        return segment;
      }
      const partial = commentaryProjection(segment.text.slice(pendingPrefixLength));
      return partial && commentaryProjection(text).startsWith(partial)
        ? {
            ...segment,
            pendingCommentary: {
              text,
              prefixLength: pendingPrefixLength,
              ...(sourceMessageId ? { sourceMessageId } : {}),
              replayItemId: identity.itemId,
              requiresReplayItemId: true,
            },
          }
        : segment;
    });
  }
  if (
    !currentItemSnapshot &&
    runId &&
    text &&
    !state.chatStreamSegments.some(
      (segment) => segment.runId === runId && segment.retiredItemId === identity.itemId,
    )
  ) {
    const baseline = accumulatedRunText(state.chatStreamSegments, runId) ?? "";
    state.chatStreamSegments = [
      ...state.chatStreamSegments,
      {
        text: baseline,
        ts: Date.now(),
        runId,
        persisted: true,
        retiredItemId: identity.itemId,
        pendingCommentary: {
          text,
          prefixLength: Math.min(pendingPrefixLength ?? baseline.length, baseline.length),
          ...(sourceMessageId ? { sourceMessageId } : {}),
          replayItemId: identity.itemId,
          requiresReplayItemId: true,
        },
      },
    ];
  }
  if (currentItemSnapshot) {
    state.chatStreamItemPrefix = currentItemSnapshot;
  } else if (completedCurrentItemSnapshot) {
    state.chatStream = completedCurrentItemSnapshot;
    state.chatStreamItemPrefix = completedCurrentItemSnapshot;
  } else if (rewritesContinuedCurrentItem) {
    state.chatStreamItemPrefix = state.chatStream ?? undefined;
  }
}
