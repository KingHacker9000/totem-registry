import assert from "node:assert/strict";
import test from "node:test";

import {
  REGISTRY_LIMITS,
  REGISTRY_SCHEMA,
  validatePackageVersion,
  validateRegistryIndex,
} from "../src/registry.js";
import {
  NODE_PROTOCOL_LIMITS,
  createNodeDescriptor,
  validateNodeEnvelope,
  routeWorkflow,
} from "../src/node-protocol.js";

const digest = "a".repeat(64);

function pkg(id, overrides = {}) {
  return {
    id,
    kind: "extension",
    version: "1.0.0",
    source: `https://example.com/${id}.tgz`,
    sha256: digest,
    ...overrides,
  };
}

function envelope(payload) {
  return {
    schema: "totem.node/v0",
    type: "node.updated",
    nodeId: "node-1",
    id: "event-1",
    occurredAt: "2026-09-08T00:00:00Z",
    payload,
  };
}

function nestedObject(depth) {
  let value = "leaf";
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}

function node(id = "node-1") {
  return {
    id,
    name: id,
    platform: "linux",
    arch: "arm64",
    capabilities: ["shell"],
    tags: [],
    metadata: {},
  };
}

test("registry accepts package and permission counts at their documented limits", () => {
  const permissions = Array.from({ length: REGISTRY_LIMITS.maxPermissions }, (_, index) => `permission-${index}`);
  assert.equal(validatePackageVersion(pkg("bounded", { permissions })).permissions.length, REGISTRY_LIMITS.maxPermissions);

  const packages = Array.from({ length: REGISTRY_LIMITS.maxPackages }, (_, index) => pkg(`pkg-${index}`));
  assert.equal(
    validateRegistryIndex({ schema: REGISTRY_SCHEMA, generatedAt: "2026-09-08T00:00:00Z", packages }).packages.length,
    REGISTRY_LIMITS.maxPackages,
  );
});

test("registry rejects package, permission, and string complexity above limits", () => {
  const permissions = Array.from({ length: REGISTRY_LIMITS.maxPermissions + 1 }, (_, index) => `permission-${index}`);
  assert.throws(() => validatePackageVersion(pkg("too-many-permissions", { permissions })), /maximum item count/);

  const packages = Array.from({ length: REGISTRY_LIMITS.maxPackages + 1 }, (_, index) => pkg(`pkg-${index}`));
  assert.throws(
    () => validateRegistryIndex({ schema: REGISTRY_SCHEMA, generatedAt: "2026-09-08T00:00:00Z", packages }),
    /packages exceeds maximum item count/,
  );

  assert.throws(() => validatePackageVersion(pkg("x".repeat(REGISTRY_LIMITS.maxStringLength + 1))), /maximum length/);
});

test("node protocol accepts nested JSON and string arrays at their documented limits", () => {
  const capabilities = Array.from({ length: NODE_PROTOCOL_LIMITS.maxStringArrayItems }, (_, index) => `cap-${index}`);
  assert.equal(createNodeDescriptor({ ...node(), capabilities }).capabilities.length, NODE_PROTOCOL_LIMITS.maxStringArrayItems);
  assert.doesNotThrow(() => validateNodeEnvelope(envelope(nestedObject(NODE_PROTOCOL_LIMITS.maxJsonDepth))));
});

test("node protocol rejects excessive depth, breadth, aggregate members, and string length", () => {
  assert.throws(
    () => validateNodeEnvelope(envelope(nestedObject(NODE_PROTOCOL_LIMITS.maxJsonDepth + 1))),
    /maximum JSON depth/,
  );

  const broad = Object.fromEntries(
    Array.from({ length: NODE_PROTOCOL_LIMITS.maxJsonObjectKeys + 1 }, (_, index) => [`key-${index}`, index]),
  );
  assert.throws(() => validateNodeEnvelope(envelope(broad)), /maximum object key count/);

  const aggregate = Array.from({ length: 5 }, (_, group) =>
    Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`key-${group}-${index}`, index])),
  );
  assert.throws(() => validateNodeEnvelope(envelope({ aggregate })), /maximum JSON member count/);

  assert.throws(
    () => createNodeDescriptor({ ...node(), name: "x".repeat(NODE_PROTOCOL_LIMITS.maxStringLength + 1) }),
    /maximum length/,
  );
});

test("node protocol bounds capability arrays and workflow routing fan-out", () => {
  const capabilities = Array.from({ length: NODE_PROTOCOL_LIMITS.maxStringArrayItems + 1 }, (_, index) => `cap-${index}`);
  assert.throws(() => createNodeDescriptor({ ...node(), capabilities }), /maximum item count/);

  const nodes = Array.from({ length: NODE_PROTOCOL_LIMITS.maxRouteNodes + 1 }, (_, index) => node(`node-${index}`));
  assert.throws(() => routeWorkflow(nodes, ["shell"]), /nodes exceeds maximum item count/);
});
