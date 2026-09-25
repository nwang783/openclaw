import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../../../../src/shared/regexp.js";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import {
  advanceAccumulatedStreamText,
  streamSegmentResetsAccumulatedText,
  streamSegmentUsesAccumulatedText,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";

export function previousStreamOwnersBySegment(
  segments: readonly ChatStreamSegment[],
): Map<ChatStreamSegment, { itemId?: string; itemStartOffset?: number }> {
  const previousOwners = new Map<
    ChatStreamSegment,
    { itemId?: string; itemStartOffset?: number }
  >();
  const latestItemIds = new Map<string | undefined, string>();
  const latestItemStartOffsets = new Map<string | undefined, number>();
  const latestText = new Map<string | undefined, string | null>();
  for (const segment of segments) {
    const runId = normalizeOptionalString(segment.runId);
    const previousText = latestText.get(runId) ?? null;
    const itemId = normalizeOptionalString(segment.itemId);
    let previousItemId = latestItemIds.get(runId);
    let previousItemStartOffset = latestItemStartOffsets.get(runId);
    if (!itemId && previousText && !segment.text.startsWith(previousText)) {
      latestItemIds.delete(runId);
      latestItemStartOffsets.delete(runId);
      previousItemId = undefined;
      previousItemStartOffset = undefined;
    }
    previousOwners.set(segment, {
      ...(previousItemId ? { itemId: previousItemId } : {}),
      ...(previousItemStartOffset === undefined
        ? {}
        : { itemStartOffset: previousItemStartOffset }),
    });
    const resets = streamSegmentResetsAccumulatedText(
      segment,
      previousItemId,
      previousText,
      runId,
      previousItemStartOffset,
    );
    if (itemId) {
      latestItemIds.set(runId, itemId);
      if (segment.producerItemStartOffset !== undefined) {
        latestItemStartOffsets.set(runId, segment.producerItemStartOffset);
      } else if (itemId !== previousItemId) {
        latestItemStartOffsets.delete(runId);
      }
    }
    if (streamSegmentUsesAccumulatedText(segment)) {
      latestText.set(runId, advanceAccumulatedStreamText(previousText, segment.text, resets));
    }
  }
  return previousOwners;
}

function commentaryWhitespacePattern(text: string): string | undefined {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return words.length ? words.map(escapeRegExp).join("\\s+") : undefined;
}

function commentaryWhitespaceShape(text: string): string {
  return text
    .trim()
    .split(/((?:\r?\n){2,})/u)
    .map((part, index) => (index % 2 === 1 ? "\n\n" : part.replace(/\s+/gu, " ")))
    .join("");
}

const MAX_COMMENTARY_MATCH_WORK = 1_000_000;

function endsBeforeParagraphBreak(source: string, index: number): boolean {
  let cursor = index;
  for (let newline = 0; newline < 2; newline++) {
    while (source[cursor] === " " || source[cursor] === "\t") {
      cursor++;
    }
    if (source[cursor] === "\r") {
      cursor++;
    }
    if (source[cursor] !== "\n") {
      return false;
    }
    cursor++;
  }
  return true;
}

function matchCommentaryItem(
  source: string,
  text: string,
  trailingOnly: boolean,
): RegExpExecArray | null {
  const pattern = commentaryWhitespacePattern(text);
  if (!pattern) {
    return null;
  }
  const expectedShape = commentaryWhitespaceShape(text);
  const matcher = new RegExp(pattern, "uy");
  const paragraphBoundary = /(?:\r?\n){2}[ \t]*/gu;
  const firstContentIndex = source.search(/\S/u);
  if (firstContentIndex < 0) {
    return null;
  }
  let trailingWhitespaceIndex = source.length;
  while (trailingWhitespaceIndex > 0 && /\s/u.test(source[trailingWhitespaceIndex - 1] ?? "")) {
    trailingWhitespaceIndex--;
  }
  let searchFrom = firstContentIndex;
  let remainingWork = MAX_COMMENTARY_MATCH_WORK;
  while (searchFrom < source.length) {
    remainingWork -= text.length;
    if (remainingWork < 0) {
      return null;
    }
    matcher.lastIndex = searchFrom;
    const match = matcher.exec(source);
    if (match) {
      const matchEnd = match.index + match[0].length;
      const endsItem =
        matchEnd >= trailingWhitespaceIndex || endsBeforeParagraphBreak(source, matchEnd);
      if (
        endsItem &&
        (!trailingOnly || matchEnd >= trailingWhitespaceIndex) &&
        commentaryWhitespaceShape(match[0]) === expectedShape
      ) {
        return match;
      }
    }
    paragraphBoundary.lastIndex = searchFrom;
    const nextBoundary = paragraphBoundary.exec(source);
    if (!nextBoundary) {
      break;
    }
    searchFrom = nextBoundary.index + nextBoundary[0].length;
  }
  return null;
}

export function matchCommentaryOccurrence(source: string, text: string): RegExpExecArray | null {
  return matchCommentaryItem(source, text, false);
}

export function matchTrailingCommentaryOccurrence(
  source: string,
  text: string,
): RegExpExecArray | null {
  return matchCommentaryItem(source, text, true);
}

export function commentaryProjection(text: string): string {
  return stripInlineDirectiveTagsForDelivery(text).text.replace(/\s+/gu, " ").trim();
}
