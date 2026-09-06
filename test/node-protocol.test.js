import assert from "node:assert/strict";
import test from "node:test";
import {
  canRunOnNode,
  createNodeDescriptor,
  createNodeEnvelope,
  reduceNodeState,
  routeWorkflow,
} from "../src/node-protocol.js";

test("node descriptors normalize capabilities and support deterministic routing", () => {
  const linux = createNodeDescriptor({
    id: "linux-a",
    name: "Linux node",
    platform: "linux",
    arch: "x64",
    capabilities: ["shell", "filesystem", "shell"],
    tags: ["office"],
  });
  const mac = createNodeDescriptor({
    id: "mac-a",
    name: "Mac node",
    platform: "darwin",
    arch: "arm64",
    capabilities: ["shell"],
  });
  assert.deepEqual(linux.capabilities, ["filesystem", "shell"]);
  assert.deepEqual(canRunOnNode(linux, ["filesystem"]), { ok: true, missing: [], online: true });
  assert.deepEqual(canRunOnNode(mac, ["filesystem"]), { ok: false, missing: ["filesystem"], online: true });
  assert.equal(routeWorkflow([mac, linux], ["filesystem"]).id, "linux-a");
});

test("node lifecycle reduces registration heartbeat and offline events", () => {
  const registered = createNodeEnvelope({
    id: "evt-1",
    type: "node.registered",
    nodeId: "node-1",
    occurredAt: "2026-09-06T12:00:00Z",
    payload: { name: "Desk", platform: "win32", arch: "x64", capabilities: ["shell"] },
  });
  const node = reduceNodeState(null, registered);
  assert.equal(node.online, true);
  const heartbeat = createNodeEnvelope({
    id: "evt-2",
    type: "node.heartbeat",
    nodeId: "node-1",
    occurredAt: "2026-09-06T12:01:00Z",
    payload: {},
  });
  const live = reduceNodeState(node, heartbeat);
  assert.equal(live.lastSeenAt, "2026-09-06T12:01:00Z");
  const offline = createNodeEnvelope({
    id: "evt-3",
    type: "node.offline",
    nodeId: "node-1",
    occurredAt: "2026-09-06T12:02:00Z",
    payload: {},
  });
  assert.equal(reduceNodeState(live, offline).online, false);
});
