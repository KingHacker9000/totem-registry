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

test("node descriptors fail closed on ambiguous state and unsafe metadata", () => {
  const base = { id: "node-1", name: "Desk", platform: "linux", arch: "x64" };
  assert.throws(() => createNodeDescriptor({ ...base, online: "false" }), /online must be a boolean/);
  assert.throws(() => createNodeDescriptor({ ...base, lastSeenAt: "yesterday" }), /ISO-8601 UTC timestamp/);
  assert.throws(() => createNodeDescriptor({ ...base, metadata: [] }), /metadata must be an object/);
  assert.throws(() => createNodeDescriptor({ ...base, metadata: { load: Number.NaN } }), /finite JSON values/);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => createNodeDescriptor({ ...base, metadata: cyclic }), /circular references/);
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

test("node envelopes reject unsupported lifecycle events and malformed timestamps or payloads", () => {
  const base = { id: "evt-1", nodeId: "node-1", occurredAt: "2026-09-06T12:00:00Z", payload: {} };
  assert.throws(() => createNodeEnvelope({ ...base, type: "node.deleted" }), /unsupported node event type/);
  assert.throws(
    () => createNodeEnvelope({ ...base, type: "node.heartbeat", occurredAt: "2026-09-06 12:00:00" }),
    /ISO-8601 UTC timestamp/,
  );
  assert.throws(() => createNodeEnvelope({ ...base, type: "node.heartbeat", payload: [] }), /payload must be an object/);
  assert.throws(
    () => createNodeEnvelope({ ...base, type: "node.heartbeat", payload: { metric: undefined } }),
    /payload.metric must contain only finite JSON values/,
  );
});
