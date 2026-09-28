import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../../../../src/shared/regexp.js";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import {
  accumulatedStreamText,
  advanceAccumulatedStreamText,
  streamSegmentHasItemId,
  streamSegmentResetsAccumulatedText,
  streamSegmentUsesAccumulatedText,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import type { StreamCausalBoundaryState } from "./stream-causal-boundary.ts";
import { commentaryProjection } from "./stream-commentary-matching.ts";
import type { ToolStreamReconciliationState } from "./stream-reconciliation.ts";

export function accumulatedRunText(
  segments: readonly ChatStreamSegment[],
  runId: string | null | undefined,
): string | null {
  return accumulatedStreamText(segments, (text) => text, runId);
}

export function hasLiveItemSegment(
  segments: readonly ChatStreamSegment[],
  runId: string,
  itemId: string,
): boolean {
  return segments.some(
    (segment) => segment.runId === runId && segment.persisted !== true && segment.itemId === itemId,
  );
}

export function findRetiredCommentarySegment(
  segments: readonly ChatStreamSegment[],
  commentary: {
    runId: string;
    itemId: string;
    text: string;
    sourceMessageId?: string;
  },
): ChatStreamSegment | undefined {
  const belongsToCommentary = (segment: ChatStreamSegment) =>
    segment.runId === commentary.runId && segment.retiredItemId === commentary.itemId;
  const sourceReceipt = commentary.sourceMessageId
    ? segments.find(
        (segment) =>
          belongsToCommentary(segment) &&
          segment.pendingCommentary?.sourceMessageId === commentary.sourceMessageId,
      )
    : undefined;
  const legacyReceipt = segments.find(
    (segment) =>
      belongsToCommentary(segment) &&
      segment.pendingCommentary?.sourceMessageId === undefined &&
      segment.pendingCommentary?.text === commentary.text,
  );
  const textReceipt = commentary.sourceMessageId
    ? undefined
    : segments.find(
        (segment) =>
          belongsToCommentary(segment) && segment.pendingCommentary?.text === commentary.text,
      );
  const pendingReceipt = commentary.sourceMessageId
    ? undefined
    : segments.find(
        (segment) => belongsToCommentary(segment) && Boolean(segment.pendingCommentary),
      );
  return (
    sourceReceipt ??
    legacyReceipt ??
    textReceipt ??
    pendingReceipt ??
    segments.find(
      (segment) =>
        belongsToCommentary(segment) && (!commentary.sourceMessageId || !segment.pendingCommentary),
    )
  );
}

export function advanceReceipt(
  state: ToolStreamReconciliationState,
  segment: ChatStreamSegment,
  settledPrefix?: string,
): boolean {
  const pending = segment.pendingCommentary;
  if (!segment.retiredItemId || !segment.runId || !pending) {
    return true;
  }
  const commentary = {
    runId: segment.runId,
    itemId: segment.retiredItemId,
    text: pending.text,
    ...(pending.sourceMessageId ? { sourceMessageId: pending.sourceMessageId } : {}),
  };
  const segments = state.chatStreamSegments ?? [];
  const stream = state.chatStream ?? accumulatedRunText(segments, commentary.runId);
  const receipt = findRetiredCommentarySegment(segments, commentary);
  const receiptIndex = receipt ? segments.indexOf(receipt) : -1;
  const precedingSettledPrefix = accumulatedRunText(
    segments
      .slice(0, Math.max(0, receiptIndex))
      .filter((owner) => owner.retiredItemId && owner.pendingCommentary === undefined),
    commentary.runId,
  );
  const consumedPrefix = settledPrefix ?? precedingSettledPrefix ?? undefined;
  if (
    !consumedPrefix ||
    !stream?.startsWith(consumedPrefix) ||
    stream.length <= consumedPrefix.length
  ) {
    return true;
  }
  const separator = /^(?:[ \t]*\r?\n){2}/u.exec(stream.slice(consumedPrefix.length))?.[0];
  const consumedSeparator = /(?:[ \t]*\r?\n){2}$/u.test(consumedPrefix);
  if (!separator && !consumedSeparator) {
    return false;
  }
  const replayStart = consumedPrefix.length + (separator?.length ?? 0);
  state.chatStreamSegments = state.chatStreamSegments?.map((owner) =>
    owner === receipt && owner.pendingCommentary
      ? {
          ...owner,
          pendingCommentary: {
            ...owner.pendingCommentary,
            prefixLength: Math.max(owner.pendingCommentary.prefixLength, replayStart),
          },
        }
      : owner,
  );
  return true;
}

export function completePendingCommentary(
  state: ToolStreamReconciliationState,
  retired: ChatStreamSegment,
): { text: string; prefix: string } | null {
  const pending = retired.pendingCommentary;
  const stream =
    state.chatStream ?? accumulatedRunText(state.chatStreamSegments ?? [], retired.runId);
  const resetReplay =
    state.chatStreamItemId === retired.retiredItemId && state.chatStreamItemPrefix === "";
  if (!pending || !stream || (!resetReplay && !stream.startsWith(retired.text))) {
    return null;
  }
  const expectedText = pending.text;
  const replayStart = resetReplay ? 0 : pending.prefixLength;
  const rawTail = stream.slice(replayStart);
  const delivered = stripInlineDirectiveTagsForDelivery(rawTail).text;
  const projected = commentaryProjection(delivered);
  if (!projected) {
    return null;
  }
  let prefix = stream;
  let text = expectedText;
  let pendingCommentary: ChatStreamSegment["pendingCommentary"];
  const expectedProjection = commentaryProjection(expectedText);
  if (expectedProjection.startsWith(projected) && projected !== expectedProjection) {
    pendingCommentary = { ...pending, text: expectedText };
  } else {
    const pattern = expectedText.split(/\s+/u).map(escapeRegExp).join("\\s+");
    const match = new RegExp(`^\\s*${pattern}`, "u").exec(delivered);
    if (!match) {
      return null;
    }
    const suffix = delivered.slice(match[0].length).trimEnd();
    const source = rawTail.trimEnd();
    if (suffix && !source.endsWith(suffix)) {
      return null;
    }
    prefix = stream.slice(
      0,
      Math.max(resetReplay ? 0 : retired.text.length, replayStart + source.length - suffix.length),
    );
    text = match[0].replace(/^(?:[ \t]*\r?\n)+/u, "").trimEnd();
  }
  const originalSegments = state.chatStreamSegments ?? [];
  const retiredIndex = originalSegments.indexOf(retired);
  const liveOwnerIndex = originalSegments.findIndex(
    (segment, index) =>
      index > retiredIndex &&
      segment.runId === retired.runId &&
      segment.persisted !== true &&
      !streamSegmentUsesAccumulatedText(segment) &&
      segment.itemId === retired.retiredItemId,
  );
  const latePriorOwnerIndexes = new Set(
    originalSegments.flatMap((segment, index) =>
      index > retiredIndex &&
      segment.runId === retired.runId &&
      segment.persisted !== true &&
      streamSegmentHasItemId(segment) &&
      segment.itemId !== retired.retiredItemId &&
      retired.text.startsWith(segment.text)
        ? [index]
        : [],
    ),
  );
  const settledSegments: ChatStreamSegment[] = [];
  for (const [index, segment] of originalSegments.entries()) {
    let settled = segment;
    if (segment === retired) {
      settled = { ...segment, text: prefix, pendingCommentary };
    } else if (index === liveOwnerIndex) {
      settled = { ...segment, text };
    } else if (segment.pendingCommentaryPrefixFor === retired.retiredItemId) {
      const keyedOwner = state.chatStreamSegments?.some(
        (owner) =>
          owner !== segment &&
          owner.runId === retired.runId &&
          owner.persisted !== true &&
          streamSegmentHasItemId(owner) &&
          owner.itemId !== retired.retiredItemId &&
          owner.text === segment.text,
      );
      settled = keyedOwner ? { ...segment, persisted: true } : segment;
    } else if (
      segment.runId === retired.runId &&
      streamSegmentUsesAccumulatedText(segment) &&
      (!streamSegmentHasItemId(segment) || segment.itemId === retired.retiredItemId) &&
      segment.text.startsWith(retired.text) &&
      prefix.startsWith(segment.text)
    ) {
      settled = { ...segment, persisted: true };
    }
    settledSegments.push(settled);
  }
  const reorderedSegments: ChatStreamSegment[] = [];
  for (const [index, segment] of settledSegments.entries()) {
    if (index === retiredIndex) {
      for (const ownerIndex of latePriorOwnerIndexes) {
        const owner = settledSegments[ownerIndex];
        if (owner) {
          reorderedSegments.push(owner);
        }
      }
      reorderedSegments.push(segment);
    } else if (!latePriorOwnerIndexes.has(index)) {
      reorderedSegments.push(segment);
    }
  }
  state.chatStreamSegments = reorderedSegments;
  return { text, prefix };
}

export function pruneAccumulatedStreamSegments(
  segments: readonly ChatStreamSegment[],
  activeRunId: string | null | undefined,
  shouldPrune: (segment: ChatStreamSegment, index: number) => boolean,
  retiredItemId?: string | ((segment: ChatStreamSegment, index: number) => string | undefined),
  activeItemId?: string,
): ChatStreamSegment[] {
  return segments.flatMap((segment, index) => {
    if (!shouldPrune(segment, index)) {
      return [segment];
    }
    const resolvedRetiredItemId =
      typeof retiredItemId === "function" ? retiredItemId(segment, index) : retiredItemId;
    // Durable rows replace display, not the producer's cumulative baseline.
    // A segment owned by a different run than the active one has no future
    // deltas to trim, so retaining it would leak sibling-run state.
    const foreignRun = Boolean(segment.runId && activeRunId && segment.runId !== activeRunId);
    if (!streamSegmentUsesAccumulatedText(segment)) {
      return activeItemId && segment.itemId !== activeItemId && streamSegmentHasItemId(segment)
        ? [{ ...segment, text: "", boundaryMarker: true as const, persisted: true as const }]
        : [];
    }
    if (
      resolvedRetiredItemId &&
      segment.cumulative &&
      segment.itemStartOffset === undefined &&
      segment.itemId !== resolvedRetiredItemId
    ) {
      return [segment];
    }
    const retained = {
      ...segment,
      persisted: true as const,
      ...(resolvedRetiredItemId ? { retiredItemId: resolvedRetiredItemId } : {}),
    };
    const itemPrefix =
      resolvedRetiredItemId && segment.itemStartOffset
        ? segment.text.slice(0, segment.itemStartOffset)
        : "";
    if (foreignRun) {
      return itemPrefix
        ? [
            {
              text: itemPrefix,
              ts: segment.ts,
              runId: segment.runId,
              pendingCommentaryPrefixFor: resolvedRetiredItemId,
            },
          ]
        : [];
    }
    const accumulatedBefore = accumulatedStreamText(
      segments.slice(0, index),
      (text) => text,
      segment.runId ?? activeRunId,
    );
    const preservesNewPrefix =
      Boolean(itemPrefix) &&
      (!accumulatedBefore ||
        !segment.text.startsWith(accumulatedBefore) ||
        advanceAccumulatedStreamText(accumulatedBefore, itemPrefix) !== accumulatedBefore);
    return preservesNewPrefix
      ? [
          {
            text: itemPrefix,
            ts: segment.ts,
            runId: segment.runId,
            pendingCommentaryPrefixFor: resolvedRetiredItemId,
          },
          retained,
        ]
      : [retained];
  });
}

export function pruneStreamStateSegments(
  state: StreamCausalBoundaryState,
  activeRunId: string,
  shouldPrune: (segment: ChatStreamSegment, index: number) => boolean,
  retiredItemId?: string,
): ChatStreamSegment[] {
  return pruneAccumulatedStreamSegments(
    state.chatStreamSegments ?? [],
    activeRunId,
    shouldPrune,
    retiredItemId,
    state.chatStreamItemId,
  );
}

export function pendingCommentaryStart(segment: ChatStreamSegment, text: string): number {
  if (segment.itemStartOffset !== undefined) {
    return segment.itemStartOffset;
  }
  if (text.startsWith(segment.text)) {
    return 0;
  }
  for (const match of segment.text.matchAll(/(?:\r?\n){2}/gu)) {
    const start = (match.index ?? 0) + match[0].length;
    const itemText = segment.text.slice(start);
    if (text.startsWith(itemText) || itemText.startsWith(text)) {
      return start;
    }
  }
  return segment.text.length;
}

export function discardStreamSegmentIndexes(
  state: StreamCausalBoundaryState,
  discardedIndexes: readonly number[],
  retiredItemId?: string,
): void {
  if (!state.chatStreamSegments || discardedIndexes.length === 0) {
    return;
  }
  const discarded = new Set(discardedIndexes);
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (_segment, index) => discarded.has(index),
    retiredItemId,
    state.chatStreamItemId,
  );
}

export function persistedItemSegmentSelection(
  segments: readonly ChatStreamSegment[],
  identity: { itemId: string; runId?: string },
  text: string | null | undefined,
  activeItemId?: string,
  activeItemStartOffset?: number,
  activeText?: string | null,
): { indexes: number[]; usedFallback: boolean } {
  const belongsToIdentityRun = (segment: ChatStreamSegment) => {
    const runId = normalizeOptionalString(segment.runId);
    return !identity.runId || !runId || identity.runId === runId;
  };
  const durableProjection = text ? commentaryProjection(text) : "";
  const activeProjection =
    activeText === null || activeText === undefined
      ? ""
      : commentaryProjection(activeText.slice(activeItemStartOffset ?? 0));
  const prefersActiveOccurrence =
    activeItemId === identity.itemId &&
    Boolean(activeProjection) &&
    durableProjection.startsWith(activeProjection);
  const activeOccurrenceBoundaryIndex = prefersActiveOccurrence
    ? segments.findLastIndex(
        (segment) =>
          belongsToIdentityRun(segment) &&
          streamSegmentHasItemId(segment) &&
          normalizeOptionalString(segment.itemId) !== identity.itemId,
      )
    : -1;
  const candidateIndexes = segments.flatMap((segment, index) => {
    // Client-materialized commentary can be untagged; known run ownership
    // must still prevent a reused item id from pruning a sibling run.
    return segment.persisted !== true &&
      normalizeOptionalString(segment.itemId) === identity.itemId &&
      index > activeOccurrenceBoundaryIndex &&
      (segment.itemStartOffset === undefined || segment.itemStartOffset < segment.text.length) &&
      (!prefersActiveOccurrence ||
        activeItemStartOffset === undefined ||
        segment.producerItemStartOffset === undefined ||
        segment.producerItemStartOffset === activeItemStartOffset) &&
      belongsToIdentityRun(segment)
      ? [index]
      : [];
  });
  const itemProjection = (segment: ChatStreamSegment) =>
    commentaryProjection(segment.text.slice(pendingCommentaryStart(segment, text ?? "")));
  const divergentUnkeyedIndexes = new Set<number>();
  const identityOccurrenceStartIndexes = new Set<number>();
  let previousIdentityItemStart: number | undefined;
  let accumulatedText: string | null = null;
  let accumulatedItemId: string | undefined;
  let accumulatedItemStartOffset: number | undefined;
  let accumulatedRunId: string | undefined;
  for (const [index, segment] of segments.entries()) {
    if (!belongsToIdentityRun(segment) || !streamSegmentUsesAccumulatedText(segment)) {
      continue;
    }
    const itemId = normalizeOptionalString(segment.itemId);
    const itemStart = Number.isInteger(segment.producerItemStartOffset)
      ? segment.producerItemStartOffset
      : undefined;
    if (itemId === identity.itemId && itemStart !== undefined) {
      if (previousIdentityItemStart !== undefined && itemStart !== previousIdentityItemStart) {
        identityOccurrenceStartIndexes.add(index);
      }
      previousIdentityItemStart = itemStart;
    }
    if (!itemId && accumulatedText && !segment.text.startsWith(accumulatedText)) {
      divergentUnkeyedIndexes.add(index);
      accumulatedItemId = undefined;
      accumulatedItemStartOffset = undefined;
    }
    const resetsAccumulatedText = streamSegmentResetsAccumulatedText(
      segment,
      accumulatedItemId,
      accumulatedText,
      accumulatedRunId,
      accumulatedItemStartOffset,
    );
    accumulatedText = advanceAccumulatedStreamText(
      accumulatedText,
      segment.text,
      resetsAccumulatedText,
    );
    if (itemId) {
      accumulatedItemId = itemId;
      accumulatedItemStartOffset = segment.producerItemStartOffset ?? accumulatedItemStartOffset;
    }
    accumulatedRunId = normalizeOptionalString(segment.runId) ?? accumulatedRunId;
  }
  // Durable fallback metadata has no occurrence token when an item ID is reused.
  // An incompatible revision is safe to retire only when one occurrence remains.
  const candidateOccurrence = (index: number) => {
    const boundaryIndex = segments.findLastIndex(
      (segment, candidateIndex) =>
        candidateIndex < index &&
        belongsToIdentityRun(segment) &&
        ((streamSegmentHasItemId(segment) &&
          normalizeOptionalString(segment.itemId) !== identity.itemId) ||
          divergentUnkeyedIndexes.has(candidateIndex)),
    );
    return `${boundaryIndex}:${segments[index]?.producerItemStartOffset ?? ""}`;
  };
  const candidateOccurrences = new Set(candidateIndexes.map(candidateOccurrence));
  const unambiguousMatch = (
    predicate: (segment: ChatStreamSegment) => boolean,
    preferLast = false,
  ) => {
    const matches = candidateIndexes.filter((index) => {
      const segment = segments[index];
      return Boolean(segment && segment.persisted !== true && predicate(segment));
    });
    if (new Set(matches.map(candidateOccurrence)).size !== 1) {
      return undefined;
    }
    return preferLast ? matches.at(-1) : matches[0];
  };
  const fallbackIndex = candidateOccurrences.size === 1 ? candidateIndexes.at(-1) : undefined;
  const matchedAnchorIndex =
    unambiguousMatch(
      (segment) =>
        Boolean(durableProjection) && commentaryProjection(segment.text) === durableProjection,
    ) ??
    unambiguousMatch(
      (segment) => Boolean(durableProjection) && itemProjection(segment) === durableProjection,
    ) ??
    unambiguousMatch((segment) => {
      const projection = itemProjection(segment);
      return Boolean(projection && durableProjection.startsWith(projection));
    }) ??
    unambiguousMatch((segment) => itemProjection(segment).startsWith(durableProjection), true);
  const anchorIndex =
    matchedAnchorIndex ??
    (fallbackIndex !== undefined &&
    (!activeItemId || activeItemId === identity.itemId) &&
    !segments.some(
      (segment, index) =>
        index > fallbackIndex &&
        belongsToIdentityRun(segment) &&
        streamSegmentHasItemId(segment) &&
        normalizeOptionalString(segment.itemId) !== identity.itemId,
    )
      ? fallbackIndex
      : undefined);
  if (anchorIndex === undefined) {
    return { indexes: [], usedFallback: false };
  }
  const anchorSegment = segments[anchorIndex];
  if (!anchorSegment) {
    return { indexes: [], usedFallback: false };
  }
  const separatesOccurrence = (segment: ChatStreamSegment, index: number) => {
    if (streamSegmentHasItemId(segment)) {
      return normalizeOptionalString(segment.itemId) !== identity.itemId;
    }
    return divergentUnkeyedIndexes.has(index);
  };
  const previousOwnerBoundary = segments.findLastIndex(
    (segment, index) =>
      index < anchorIndex && belongsToIdentityRun(segment) && separatesOccurrence(segment, index),
  );
  const previousOccurrenceStart = Array.from(identityOccurrenceStartIndexes).findLast(
    (index) => index <= anchorIndex,
  );
  const previousOwnerIndex = Math.max(
    previousOwnerBoundary,
    previousOccurrenceStart === undefined ? -1 : previousOccurrenceStart - 1,
  );
  const nextOwnerBoundary = segments.findIndex(
    (segment, index) =>
      index > anchorIndex && belongsToIdentityRun(segment) && separatesOccurrence(segment, index),
  );
  const nextOccurrenceStart = Array.from(identityOccurrenceStartIndexes).find(
    (index) => index > anchorIndex,
  );
  const nextOwnerIndex =
    nextOwnerBoundary < 0
      ? (nextOccurrenceStart ?? -1)
      : nextOccurrenceStart === undefined
        ? nextOwnerBoundary
        : Math.min(nextOwnerBoundary, nextOccurrenceStart);
  const anchorProjection =
    commentaryProjection(anchorSegment.text) === durableProjection
      ? durableProjection
      : itemProjection(anchorSegment);
  const inheritedPrefixIndex =
    previousOwnerIndex >= 0 &&
    anchorSegment?.itemStartOffset === segments[previousOwnerIndex]?.text.length &&
    anchorSegment.text.startsWith(segments[previousOwnerIndex]?.text ?? "") &&
    commentaryProjection(anchorSegment.text) === durableProjection
      ? previousOwnerIndex
      : -1;
  const matchedIndexes = candidateIndexes.filter((index) => {
    if (!(index > previousOwnerIndex && (nextOwnerIndex < 0 || index < nextOwnerIndex))) {
      return false;
    }
    const segment = segments[index];
    const projection = segment ? itemProjection(segment) : "";
    if (index === anchorIndex) {
      return true;
    }
    if (index > anchorIndex && durableProjection && anchorProjection === durableProjection) {
      return false;
    }
    return (
      !anchorProjection ||
      !projection ||
      anchorProjection.startsWith(projection) ||
      projection.startsWith(anchorProjection)
    );
  });
  return {
    indexes: inheritedPrefixIndex >= 0 ? [inheritedPrefixIndex, ...matchedIndexes] : matchedIndexes,
    usedFallback: matchedAnchorIndex === undefined,
  };
}
