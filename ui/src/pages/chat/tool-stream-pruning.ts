import {
  visibleAssistantStreamParts,
  type ToolStreamReconciliationState,
} from "./stream-reconciliation.ts";
import { pruneAccumulatedStreamSegments } from "./stream-segment-retirement.ts";
import {
  extractToolMessageRefs,
  resolveLiveToolStreamRefs,
  resolveMatchingLiveToolIdentity,
} from "./tool-stream-identity.ts";

export function prunePersistedToolStreamMessages(
  state: ToolStreamReconciliationState,
  persistedToolIds: Set<string>,
) {
  if (persistedToolIds.size === 0) {
    return;
  }
  const liveToolRefs = resolveLiveToolStreamRefs(state);
  const toolIdentityBySegmentIndex = new Map(
    visibleAssistantStreamParts(state, {
      includeCurrent: false,
      isHiddenStreamText: () => false,
    }).flatMap((part) => {
      if (part.segmentIndex === undefined || !part.toolCallId) {
        return [];
      }
      const identity = resolveMatchingLiveToolIdentity(
        { id: part.toolCallId, ...(part.runId ? { runId: part.runId } : {}) },
        liveToolRefs,
      );
      return identity ? ([[part.segmentIndex, identity]] as const) : [];
    }),
  );
  if (state.toolStreamById instanceof Map) {
    for (const id of persistedToolIds) {
      state.toolStreamById.delete(id);
    }
  }
  if (Array.isArray(state.toolStreamOrder)) {
    state.toolStreamOrder = state.toolStreamOrder.filter(
      (id): id is string => typeof id === "string" && !persistedToolIds.has(id),
    );
  }
  if (Array.isArray(state.chatToolMessages)) {
    state.chatToolMessages = state.chatToolMessages.filter((message) => {
      const refs = extractToolMessageRefs(message);
      return refs.every((ref) => {
        const identity = resolveMatchingLiveToolIdentity(ref, liveToolRefs);
        return identity === undefined || !persistedToolIds.has(identity);
      });
    });
  }
  if (!Array.isArray(state.chatStreamSegments)) {
    return;
  }
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (segment, index) => {
      if (segment.boundaryMarker === true || segment.persisted === true) {
        return false;
      }
      const toolIdentity = toolIdentityBySegmentIndex.get(index);
      return Boolean(toolIdentity && persistedToolIds.has(toolIdentity));
    },
    undefined,
    state.chatStreamItemId,
  );
}
