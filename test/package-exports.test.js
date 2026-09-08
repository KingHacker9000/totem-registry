import assert from "node:assert/strict";
import test from "node:test";

test("registry package exposes only supported public subpaths", async () => {
  const registry = await import("@totem/registry/registry");
  const protocol = await import("@totem/registry/node-protocol");
  const agent = await import("@totem/registry/node-agent");

  assert.equal(typeof registry.createRegistryIndex, "function");
  assert.equal(typeof protocol.createNodeDescriptor, "function");
  assert.equal(typeof agent.NodeAgentClient, "function");

  await assert.rejects(import("@totem/registry/src/registry.js"), (error) => {
    assert.equal(error.code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
    return true;
  });

  await assert.rejects(import("@totem/registry/package.json"), (error) => {
    assert.equal(error.code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
    return true;
  });
});
