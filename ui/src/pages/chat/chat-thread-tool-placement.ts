import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import type { ChatProjection, TurnInsertionBounds } from "./chat-thread-items.ts";
import { nextUnclaimedToolForRun } from "./tool-stream-identity.ts";

type ToolProjectionEntry = {
  projection: ChatProjection;
  runId?: string;
  callId?: string;
};

export function collectExplicitlyOwnedTools<T>(
  segments: readonly ChatStreamSegment[],
  resolve: (runId: string | undefined, toolCallId: string | undefined) => T | undefined,
): Set<T> {
  return new Set(
    segments.flatMap((segment) => {
      const tool = resolve(
        normalizeOptionalString(segment.runId),
        normalizeOptionalString(segment.toolCallId),
      );
      return tool ? [tool] : [];
    }),
  );
}

export function createChatThreadToolPlacement(params: {
  afterBoundaryBySegment: ReadonlyMap<ChatStreamSegment, string>;
  explicitlyOwnedTools: ReadonlySet<ChatProjection>;
  projections: ChatProjection[];
  resolveBounds: (
    runId: unknown,
    boundaryRunId?: string,
    afterBoundaryRunId?: string,
  ) => TurnInsertionBounds | undefined;
  showToolCalls: boolean;
  syntheticItemPrefixes: ReadonlySet<ChatStreamSegment>;
  toolItems: readonly ToolProjectionEntry[];
  toolLookup: { get: (runId?: string, callId?: string) => ChatProjection | undefined };
  toolAfterBoundaries: { get: (runId?: string, callId?: string) => string | undefined };
  toolBeforeBoundaries: { get: (runId?: string, callId?: string) => string | undefined };
}) {
  const emittedTools = new Set<ChatProjection>();
  const previousToolKeyByRun = new Map<string | undefined, string>();
  const latestVisibleStreamKeyByRun = new Map<string | undefined, string>();
  const resolveSegmentTool = (
    segment: ChatStreamSegment,
    runId: string | undefined,
    toolCallId: string | undefined,
  ) => {
    const explicitTool = params.toolLookup.get(runId, toolCallId);
    if (explicitTool || toolCallId || params.syntheticItemPrefixes.has(segment)) {
      return explicitTool;
    }
    return nextUnclaimedToolForRun(
      params.toolItems,
      runId,
      (tool) =>
        emittedTools.has(tool.projection) || params.explicitlyOwnedTools.has(tool.projection),
    )?.projection;
  };
  const emitAfterSegment = (
    segment: ChatStreamSegment,
    streamKey: string | undefined,
    tool: ChatProjection | undefined,
    runId: string | undefined,
  ) => {
    if (streamKey) {
      latestVisibleStreamKeyByRun.set(runId, streamKey);
    }
    const predecessorKey = streamKey ?? latestVisibleStreamKeyByRun.get(runId);
    if (!predecessorKey || !tool || emittedTools.has(tool)) {
      return;
    }
    tool.predecessorKey = predecessorKey;
    if (!params.showToolCalls) {
      return;
    }
    tool.bounds = params.resolveBounds(
      segment.runId,
      segment.boundaryRunId,
      params.afterBoundaryBySegment.get(segment),
    );
    params.projections.push(tool);
    emittedTools.add(tool);
    previousToolKeyByRun.set(runId, tool.item.key);
  };
  const emitRemaining = (
    tools: readonly ToolProjectionEntry[],
    reserved?: ReadonlySet<ChatProjection>,
  ) => {
    if (!params.showToolCalls) {
      return;
    }
    for (const tool of tools) {
      if (emittedTools.has(tool.projection) || reserved?.has(tool.projection)) {
        continue;
      }
      const predecessorKey = previousToolKeyByRun.get(tool.runId);
      if (predecessorKey) {
        tool.projection.predecessorKey = predecessorKey;
      }
      tool.projection.bounds = params.resolveBounds(
        tool.runId,
        params.toolBeforeBoundaries.get(tool.runId, tool.callId),
        params.toolAfterBoundaries.get(tool.runId, tool.callId),
      );
      params.projections.push(tool.projection);
      emittedTools.add(tool.projection);
      previousToolKeyByRun.set(tool.runId, tool.projection.item.key);
    }
  };
  return {
    emitAfterSegment,
    emitRemaining,
    previousToolKeyByRun,
    resolveSegmentTool,
  };
}
