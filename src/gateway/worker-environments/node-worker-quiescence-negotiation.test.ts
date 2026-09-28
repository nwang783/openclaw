import { expect, it, vi } from "vitest";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import {
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  environment,
  startRequest,
  transport,
  withWorkspaceDrain,
  workspaceCommandPayload,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";

it.each(["legacy", "native", "upgrade-during-acquire"] as const)(
  "negotiates lease and foreground ownership through the tunnel (%s)",
  async (mode) => {
    const record = environment();
    const nodeTransport = transport();
    const [node] = await nodeTransport.listCurrentNodes();
    if (!node) {
      throw new Error("missing fixture node");
    }
    let supported = mode === "native";
    let upgradeOnRead = false;
    nodeTransport.getCurrentNode = async () => {
      const current = {
        ...node,
        workerHost: {
          enabled: true as const,
          capacity: node.workerHost.capacity,
          environmentSession: 1 as const,
          ...(supported ? { workspaceQuiescence: 1 as const } : {}),
        },
      };
      if (upgradeOnRead) {
        supported = true;
      }
      return current;
    };
    const requests: NodeWorkerWorkspaceExecInput[] = [];
    const legacyNonce = "b".repeat(32);
    nodeTransport.invoke = withWorkspaceDrain(async ({ command, params }) => {
      if (command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
        return { ok: true, payloadJSON: "null" };
      }
      const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(params));
      requests.push(input);
      const nonce = input.quiescence?.nonce ?? legacyNonce;
      return {
        ok: true,
        payloadJSON: workspaceCommandPayload("/node/workspace", {
          stdout:
            input.quiescence?.action === "renew" || input.argv.includes("final")
              ? "renewed " + nonce + "\n"
              : "quiesced " + nonce + "\n",
        }),
      };
    });
    const transfer = workspaceTransfer();
    transfer.prepareRepository = vi.fn(async () => {});
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    manager.bindWorkspaceBindingResolver(async () => ({
      source: {
        kind: "repository",
        baseCommit: "a".repeat(40),
        baseManifestRef: "sha256:" + "b".repeat(64),
      },
      manifestRef: "sha256:" + "b".repeat(64),
      remoteWorkspaceDir: "/node/workspace",
    }));
    const handle = await manager.start(startRequest());
    upgradeOnRead = mode === "upgrade-during-acquire";
    const lease = await handle.quiesceWorkspace("/node/workspace");
    try {
      await handle.runWorkspaceCommand({ argv: ["node", "-e", "0"], transportRetry: "never" });
      await lease.assertActive();
      expect(requests[0]?.quiescence?.action).toBe(mode === "native" ? "acquire" : undefined);
      expect(requests[0]).not.toHaveProperty("nativeProcessOwner");
      expect(requests[1]?.nativeProcessOwner).toBe(mode === "legacy" ? undefined : true);
      expect(requests[2]?.quiescence?.action).toBe(mode === "native" ? "renew" : undefined);
      expect(requests[2]).not.toHaveProperty("nativeProcessOwner");
      if (mode !== "native") {
        expect(requests[0]?.argv.slice(0, 2)).toEqual(["node", "-e"]);
        expect(requests[2]?.argv).toContain(legacyNonce);
      }
      if (mode === "native") {
        supported = false;
        const before = requests.length;
        await expect(lease.assertActive()).rejects.toThrow("quiescence support changed");
        expect(requests).toHaveLength(before);
        supported = true;
      }
    } finally {
      supported = mode !== "legacy";
      await lease.resume();
      await handle.stop();
    }
  },
);
