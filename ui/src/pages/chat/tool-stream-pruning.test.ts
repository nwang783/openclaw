// @vitest-environment node
import { describe, expect, it } from "vitest";
import { visibleAssistantStreamParts } from "./stream-reconciliation.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";
import { prunePersistedToolStreamMessages } from "./tool-stream-pruning.ts";

describe("persisted tool stream pruning", () => {
  it("does not assign a synthetic assistant prefix to the positional tool", () => {
    const runId = "run-1";
    const toolCallId = "call-1";
    const identity = buildToolStreamIdentity(runId, toolCallId);
    const state = {
      chatRunId: runId,
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "Earlier\n\n", ts: 1, runId, syntheticItemPrefix: true as const },
        {
          text: "Earlier\n\nWorking",
          ts: 2,
          runId,
          itemId: "commentary-1",
          cumulative: true as const,
          itemStartOffset: "Earlier\n\n".length,
          toolCallId,
        },
      ],
      toolStreamOrder: [identity],
      toolStreamById: new Map([[identity, { runId, toolCallId }]]),
    };

    prunePersistedToolStreamMessages(state, new Set([identity]));

    expect(state.chatStreamSegments[0]).not.toHaveProperty("persisted");
    expect(state.chatStreamSegments[1]).toHaveProperty("persisted", true);
  });

  it("keeps positional tool ownership aligned after a synthetic prefix", () => {
    const runId = "run-1";
    const firstIdentity = buildToolStreamIdentity(runId, "call-1");
    const secondIdentity = buildToolStreamIdentity(runId, "call-2");
    const state = {
      chatRunId: runId,
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "Earlier\n\n", ts: 1, runId, syntheticItemPrefix: true as const },
        {
          text: "Earlier\n\nWorking",
          ts: 2,
          runId,
          itemId: "commentary-1",
          cumulative: true as const,
          itemStartOffset: "Earlier\n\n".length,
          toolCallId: "call-1",
        },
        { text: "Earlier\n\nWorking\n\nLater", ts: 3, runId },
      ],
      toolStreamOrder: [firstIdentity, secondIdentity],
      toolStreamById: new Map([
        [firstIdentity, { runId, toolCallId: "call-1" }],
        [secondIdentity, { runId, toolCallId: "call-2" }],
      ]),
    };

    const parts = visibleAssistantStreamParts(state, {
      isHiddenStreamText: () => false,
    });

    expect(parts.map((part) => part.toolCallId)).toEqual([undefined, "call-1", "call-2"]);
  });

  it("keeps an explicitly owned prefix in positional tool order", () => {
    const runId = "run-1";
    const identities = ["call-1", "call-2", "call-3"].map((id) =>
      buildToolStreamIdentity(runId, id),
    );
    const state = {
      chatRunId: runId,
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "Earlier\n\n", ts: 1, runId, toolCallId: "call-1" },
        {
          text: "Earlier\n\nWorking",
          ts: 2,
          runId,
          itemId: "commentary-1",
          cumulative: true as const,
          itemStartOffset: "Earlier\n\n".length,
          toolCallId: "call-2",
        },
        { text: "Earlier\n\nWorking\n\nLater", ts: 3, runId },
      ],
      toolStreamOrder: identities,
      toolStreamById: new Map(
        identities.map((identity, index) => [identity, { runId, toolCallId: `call-${index + 1}` }]),
      ),
    };

    const parts = visibleAssistantStreamParts(state, {
      isHiddenStreamText: () => false,
    });

    expect(parts.map((part) => part.toolCallId)).toEqual(["call-1", "call-2", "call-3"]);
  });

  it("keeps a genuine unkeyed segment in positional tool order", () => {
    const runId = "run-1";
    const identities = ["call-1", "call-2"].map((id) => buildToolStreamIdentity(runId, id));
    const state = {
      chatRunId: runId,
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "Before", ts: 1, runId },
        {
          text: "Before\n\nAfter",
          ts: 2,
          runId,
          itemId: "commentary-1",
          cumulative: true as const,
          itemStartOffset: "Before\n\n".length,
        },
      ],
      toolStreamOrder: identities,
      toolStreamById: new Map(
        identities.map((identity, index) => [identity, { runId, toolCallId: `call-${index + 1}` }]),
      ),
    };
    const parts = visibleAssistantStreamParts(state, {
      isHiddenStreamText: () => false,
    });

    expect(parts.map((part) => part.toolCallId)).toEqual(["call-1", "call-2"]);
  });

  it("does not assign an explicitly owned tool to an earlier item-only rollover", () => {
    const toolIdentity = buildToolStreamIdentity("run-a", "call-a");
    const state = {
      chatRunId: "run-a",
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        {
          text: "Sibling",
          ts: 1,
          runId: "run-b",
          itemId: "commentary-b",
          itemStartOffset: 0,
          cumulative: true as const,
        },
        { text: "Owned", ts: 2, runId: "run-a", toolCallId: "call-a" },
      ],
      toolStreamOrder: [toolIdentity],
      toolStreamById: new Map([[toolIdentity, { runId: "run-a", toolCallId: "call-a" }]]),
    };

    prunePersistedToolStreamMessages(state, new Set([toolIdentity]));

    expect(state.chatStreamSegments[0]).not.toHaveProperty("persisted");
    expect(state.chatStreamSegments[1]).toHaveProperty("persisted", true);
  });

  it("matches positional tools to each cumulative segment run", () => {
    const toolA = buildToolStreamIdentity("run-a", "call-a");
    const toolB = buildToolStreamIdentity("run-b", "call-b");
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "B", ts: 1, runId: "run-b", cumulative: true as const },
        { text: "A", ts: 2, runId: "run-a", cumulative: true as const },
      ],
      toolStreamOrder: [toolA, toolB],
      toolStreamById: new Map([
        [toolA, { runId: "run-a", toolCallId: "call-a" }],
        [toolB, { runId: "run-b", toolCallId: "call-b" }],
      ]),
    };

    expect(
      visibleAssistantStreamParts(state, { isHiddenStreamText: () => false }).map(
        (part) => part.toolCallId,
      ),
    ).toEqual(["call-b", "call-a"]);
  });

  it("reserves explicitly owned tools from item-only rollovers", () => {
    const tool = buildToolStreamIdentity("run-a", "call-a");
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        {
          text: "Rollover",
          ts: 1,
          runId: "run-a",
          itemId: "item-a",
          itemStartOffset: 0,
          cumulative: true as const,
        },
        { text: "Owner", ts: 2, runId: "run-a", itemId: "item-b", toolCallId: "call-a" },
      ],
      toolStreamOrder: [tool],
      toolStreamById: new Map([[tool, { runId: "run-a", toolCallId: "call-a" }]]),
    };

    expect(
      visibleAssistantStreamParts(state, { isHiddenStreamText: () => false }).map(
        (part) => part.toolCallId,
      ),
    ).toEqual([undefined, "call-a"]);
  });

  it("does not consume a positional tool for a repeated cumulative snapshot", () => {
    const runId = "run-1";
    const firstTool = buildToolStreamIdentity(runId, "call-1");
    const secondTool = buildToolStreamIdentity(runId, "call-2");
    const state = {
      chatRunId: runId,
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "A", ts: 1, runId, cumulative: true as const },
        { text: "A", ts: 2, runId, cumulative: true as const },
        { text: "A\n\nB", ts: 3, runId, cumulative: true as const },
      ],
      toolStreamOrder: [firstTool, secondTool],
      toolStreamById: new Map([
        [firstTool, { runId, toolCallId: "call-1" }],
        [secondTool, { runId, toolCallId: "call-2" }],
      ]),
    };

    expect(
      visibleAssistantStreamParts(state, { isHiddenStreamText: () => false }).map(
        (part) => part.toolCallId,
      ),
    ).toEqual(["call-1", "call-2"]);
    prunePersistedToolStreamMessages(state, new Set([secondTool]));
    expect(state.chatStreamSegments.find((segment) => segment.ts === 2)).not.toHaveProperty(
      "persisted",
    );
    expect(state.chatStreamSegments.find((segment) => segment.ts === 3)).toHaveProperty(
      "persisted",
      true,
    );
  });

  it("keeps positional tool ownership aligned after hidden stream text", () => {
    const runId = "run-1";
    const firstTool = buildToolStreamIdentity(runId, "call-1");
    const secondTool = buildToolStreamIdentity(runId, "call-2");
    const state = {
      chatRunId: runId,
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "hidden", ts: 1, runId, cumulative: true as const },
        { text: "hidden\n\nvisible", ts: 2, runId, cumulative: true as const },
      ],
      toolStreamOrder: [firstTool, secondTool],
      toolStreamById: new Map([
        [firstTool, { runId, toolCallId: "call-1" }],
        [secondTool, { runId, toolCallId: "call-2" }],
      ]),
    };

    expect(
      visibleAssistantStreamParts(state, { isHiddenStreamText: (text) => text === "hidden" }).map(
        (part) => part.toolCallId,
      ),
    ).toEqual(["call-2"]);
  });

  it("resets a reused cumulative item after a keyed intervening owner", () => {
    const runId = "run-1";
    const state = {
      chatRunId: runId,
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        {
          text: "yes",
          ts: 1,
          runId,
          itemId: "commentary-a",
          cumulative: true as const,
          itemStartOffset: 0,
        },
        { text: "Between", ts: 2, runId, itemId: "commentary-b" },
        {
          text: "yes again",
          ts: 3,
          runId,
          itemId: "commentary-a",
          cumulative: true as const,
          itemStartOffset: 0,
        },
      ],
      toolStreamOrder: [],
      toolStreamById: new Map(),
    };
    const parts = visibleAssistantStreamParts(state, { isHiddenStreamText: () => false });

    expect(parts.map((part) => part.text)).toEqual(["yes", "Between", "yes again"]);
  });

  it("clears a prior offset at an offsetless keyed ownership boundary", () => {
    const runId = "run-1";
    const state = {
      chatRunId: runId,
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        {
          text: "A",
          ts: 1,
          runId,
          itemId: "commentary-a",
          cumulative: true as const,
          itemStartOffset: 0,
          producerItemStartOffset: 0,
        },
        { text: "Boundary", ts: 2, runId, itemId: "commentary-b" },
        {
          text: "A\n\nB",
          ts: 3,
          runId,
          itemId: "commentary-b",
          cumulative: true as const,
          itemStartOffset: "A\n\n".length,
          producerItemStartOffset: "A\n\n".length,
        },
      ],
      toolStreamOrder: [],
      toolStreamById: new Map(),
    };
    const parts = visibleAssistantStreamParts(state, { isHiddenStreamText: () => false });

    expect(parts.map((part) => part.text)).toEqual(["A", "Boundary", "B"]);
  });
});
