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

test("node agent bounds capability execution time and exposes cooperative abort", async () => {
  let observedAbort = false;
  const server = createNodeAgent({
    descriptor: {
      id: "node-timeout-1",
      name: "Timeout node",
      platform: "linux",
      arch: "x64",
      capabilities: ["host.slow"],
    },
    handlerTimeoutMs: 20,
    handlers: {
      "host.slow": async (_input, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve({ late: true });
            },
            { once: true },
          );
        }),
    },
  });
  const binding = await listenNodeAgent(server);
  try {
    const response = await fetch(`${binding.url}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "host.slow", input: {} }),
    });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: "capability_timeout" });
    assert.equal(observedAbort, true);
  } finally {
    await closeNodeAgent(server);
  }
});

test("node agent rejects oversized handler output with a stable error", async () => {
  const server = createNodeAgent({
    descriptor: {
      id: "node-output-1",
      name: "Output node",
      platform: "linux",
      arch: "x64",
      capabilities: ["host.large"],
    },
    maxResponseBytes: 128,
    handlers: {
      "host.large": async () => ({ value: "x".repeat(512) }),
    },
  });
  const binding = await listenNodeAgent(server);
  try {
    const response = await fetch(`${binding.url}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "host.large", input: {} }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "capability_output_too_large" });
  } finally {
    await closeNodeAgent(server);
  }
});

test("node agent rejects unserializable handler output without leaking details", async () => {
  const circular = {};
  circular.self = circular;
  const server = createNodeAgent({
    descriptor: {
      id: "node-invalid-output-1",
      name: "Invalid output node",
      platform: "linux",
      arch: "x64",
      capabilities: ["host.circular", "host.bigint"],
    },
    handlers: {
      "host.circular": async () => circular,
      "host.bigint": async () => ({ secret: 1n }),
    },
  });
  const binding = await listenNodeAgent(server);
  try {
    for (const capability of ["host.circular", "host.bigint"]) {
      const response = await fetch(`${binding.url}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability, input: {} }),
      });
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.deepEqual(body, { error: "capability_output_invalid" });
      assert.equal(JSON.stringify(body).includes("circular"), false);
      assert.equal(JSON.stringify(body).includes("BigInt"), false);
    }
  } finally {
    await closeNodeAgent(server);
  }
});

test("node agent rejects invalid execution and response limits at construction", () => {
  const descriptor = {
    id: "node-config-1",
    name: "Config node",
    platform: "linux",
    arch: "x64",
    capabilities: [],
  };
  assert.throws(() => createNodeAgent({ descriptor, handlerTimeoutMs: 0 }), /handlerTimeoutMs/);
  assert.throws(() => createNodeAgent({ descriptor, maxResponseBytes: Number.POSITIVE_INFINITY }), /maxResponseBytes/);
});

test("node agent client times out deterministically", async () => {
  const client = new NodeAgentClient("http://127.0.0.1:1", {
    fetchImpl: async () => new Promise(() => {}),
    timeoutMs: 10,
  });

  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, "node_agent_timeout");
    assert.equal(error.status, undefined);
    return true;
  });
});

test("node agent client rejects unsupported and malformed response bodies", async () => {
  const wrongType = new NodeAgentClient("http://127.0.0.1:1", {
    fetchImpl: async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
  });
  await assert.rejects(wrongType.health(), (error) => {
    assert.equal(error.code, "node_agent_unsupported_media_type");
    assert.equal(error.status, 200);
    return true;
  });

  const malformed = new NodeAgentClient("http://127.0.0.1:1", {
    fetchImpl: async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(malformed.health(), (error) => {
    assert.equal(error.code, "node_agent_invalid_json");
    assert.equal(error.status, 200);
    return true;
  });
});

test("node agent client rejects oversized responses before parsing", async () => {
  const payload = JSON.stringify({ value: "x".repeat(128) });
  const client = new NodeAgentClient("http://127.0.0.1:1", {
    fetchImpl: async () =>
      new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
      }),
    maxResponseBytes: 64,
  });

  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, "node_agent_response_too_large");
    assert.equal(error.status, 200);
    return true;
  });
});

test("node agent client preserves structured HTTP error status and code", async () => {
  const client = new NodeAgentClient("http://127.0.0.1:1", {
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "remote_failure" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(client.health(), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "remote_failure");
    assert.equal(error.message, "remote_failure");
    return true;
  });
});
