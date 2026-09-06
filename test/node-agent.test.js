import assert from "node:assert/strict";
import test from "node:test";
import {
  NodeAgentClient,
  closeNodeAgent,
  createNodeAgent,
  listenNodeAgent,
} from "../src/node-agent.js";

async function withAgent(fn) {
  const server = createNodeAgent({
    descriptor: {
      id: "node-win-1",
      name: "Desk PC",
      platform: "win32",
      arch: "x64",
      capabilities: ["host.echo", "host.unimplemented"],
      tags: ["office"],
    },
    handlers: {
      "host.echo": async (input) => ({ echoed: input.value ?? null }),
    },
  });
  const binding = await listenNodeAgent(server);
  try {
    await fn(new NodeAgentClient(binding.url));
  } finally {
    await closeNodeAgent(server);
  }
}

test("node agent exposes health and descriptor", async () => {
  await withAgent(async (client) => {
    assert.deepEqual(await client.health(), { status: "ok", nodeId: "node-win-1" });
    const descriptor = await client.descriptor();
    assert.equal(descriptor.schema, "totem.node/v0");
    assert.equal(descriptor.id, "node-win-1");
    assert.deepEqual(descriptor.capabilities, ["host.echo", "host.unimplemented"]);
  });
});

test("node agent invokes only advertised and implemented capabilities", async () => {
  await withAgent(async (client) => {
    assert.deepEqual(await client.invoke("host.echo", { value: 42 }), {
      nodeId: "node-win-1",
      capability: "host.echo",
      result: { echoed: 42 },
    });

    await assert.rejects(client.invoke("host.secret", {}), (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "capability_not_advertised");
      return true;
    });

    await assert.rejects(client.invoke("host.unimplemented", {}), (error) => {
      assert.equal(error.status, 501);
      assert.equal(error.code, "capability_not_implemented");
      return true;
    });
  });
});
