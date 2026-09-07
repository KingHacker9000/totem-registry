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
      capabilities: ["host.echo", "host.fail", "host.unimplemented"],
      tags: ["office"],
    },
    handlers: {
      "host.echo": async (input) => ({ echoed: input.value ?? null }),
      "host.fail": async () => {
        throw new Error("private handler detail");
      },
    },
  });
  const binding = await listenNodeAgent(server);
  try {
    await fn(new NodeAgentClient(binding.url), binding);
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
    assert.deepEqual(descriptor.capabilities, ["host.echo", "host.fail", "host.unimplemented"]);
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

test("node agent fails closed on malformed invoke transport", async () => {
  await withAgent(async (_client, binding) => {
    const wrongType = await fetch(`${binding.url}/invoke`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);
    assert.deepEqual(await wrongType.json(), { error: "unsupported_media_type" });

    const malformed = await fetch(`${binding.url}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_json" });

    const oversized = await fetch(`${binding.url}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "host.echo", input: { value: "x".repeat(70 * 1024) } }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "request_too_large" });
  });
});

test("node agent does not expose internal handler exception details", async () => {
  await withAgent(async (_client, binding) => {
    const response = await fetch(`${binding.url}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "host.fail", input: {} }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: "node_agent_error" });
    assert.equal(JSON.stringify(body).includes("private handler detail"), false);
  });
});
