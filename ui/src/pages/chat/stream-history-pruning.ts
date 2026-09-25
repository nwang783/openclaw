import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { streamCausalInterval } from "./stream-causal-boundary.ts";
import { previousStreamOwnersBySegment } from "./stream-commentary-matching.ts";
import {
  hasAssistantStreamPartReplacement,
  visibleAssistantStreamParts,
  type ToolStreamReconciliationState,
} from "./stream-reconciliation.ts";
import { pruneAccumulatedStreamSegments } from "./stream-segment-retirement.ts";

type AssistantMessageVisibility = (message: unknown) => boolean;
type StreamVisibility = (stream: string) => boolean;

export function pruneHistoryReplacedStreamSegments(
  messages: unknown[],
  state: ToolStreamReconciliationState,
  opts: {
    isHiddenAssistantMessage: AssistantMessageVisibility;
    isHiddenStreamText: StreamVisibility;
    persistCommentary?: boolean;
  },
): boolean {
  if (!Array.isArray(state.chatStreamSegments)) {
    return false;
  }
  const replacedIndexes = new Set<number>();
  const replacedItemIds = new Map<number, string>();
  const previousOwners = previousStreamOwnersBySegment(state.chatStreamSegments);
  for (const part of visibleAssistantStreamParts(state, {
    includeCurrent: false,
    isHiddenStreamText: opts.isHiddenStreamText,
  })) {
    if (part.segmentIndex === undefined) {
      continue;
    }
    const segment = state.chatStreamSegments[part.segmentIndex];
    if (part.itemId && segment?.cumulative !== true && opts.persistCommentary !== true) {
      continue;
    }
    const interval = streamCausalInterval(messages, part);
    if (
      hasAssistantStreamPartReplacement(
        messages,
        part,
        opts.isHiddenAssistantMessage,
        interval.start,
        interval.end,
      )
    ) {
      replacedIndexes.add(part.segmentIndex);
      if (part.itemId) {
        replacedItemIds.set(part.segmentIndex, part.itemId);
        for (let index = part.segmentIndex + 1; index < state.chatStreamSegments.length; index++) {
          const revision = state.chatStreamSegments[index];
          if (normalizeOptionalString(revision?.runId) !== part.runId) {
            continue;
          }
          const previousOwner = revision ? previousOwners.get(revision) : undefined;
          const revisionItemId = normalizeOptionalString(revision?.itemId);
          if (
            previousOwner?.itemId !== part.itemId ||
            (revisionItemId && revisionItemId !== part.itemId) ||
            (revision?.producerItemStartOffset !== undefined &&
              previousOwner.itemStartOffset !== undefined &&
              revision.producerItemStartOffset !== previousOwner.itemStartOffset)
          ) {
            break;
          }
          if (revision?.cumulative === true && revisionItemId === part.itemId) {
            replacedIndexes.add(index);
            replacedItemIds.set(index, part.itemId);
          }
        }
      }
    }
  }
  if (replacedIndexes.size === 0) {
    return false;
  }
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (_segment, index) => replacedIndexes.has(index),
    (_segment, index) => replacedItemIds.get(index),
    state.chatStreamItemId,
  );
  return true;
}
