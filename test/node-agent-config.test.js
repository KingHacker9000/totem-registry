import assert from "node:assert/strict";
import test from "node:test";
import {
  NodeAgentClient,
  closeNodeAgent,
  createNodeAgent,
  listenNodeAgent,
} from "../src/node-agent.js";

function descriptor(id = "node-config-boundary-1") {
  return {
    id,
    name: "Config boundary node",
    platform: "linux",
    arch: "x64",
    capabilities: [],
  };
}

test("node agent client rejects invalid runtime bounds before transport", () => {
  for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(
      () => new NodeAgentClient("http://127.0.0.1:1", { timeoutMs }),
      /timeoutMs must be a positive finite number/,
    );
  }

  for (const maxResponseBytes of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(
      () => new NodeAgentClient("http://127.0.0.1:1", { maxResponseBytes }),
      /maxResponseBytes must be a positive finite number/,
    );
  }

  assert.throws(
    () => new NodeAgentClient("http://127.0.0.1:1", { fetchImpl: null }),
    /fetchImpl must be a function/,
  );
});

test("node agent client accepts only credential-free HTTP(S) endpoints", () => {
  for (const baseUrl of [
    "ftp://registry.example/node",
    "file:///tmp/node-agent.sock",
    "ws://registry.example/node",
    "http://user:secret@registry.example",
    "https://user@registry.example",
  ]) {
    assert.throws(() => new NodeAgentClient(baseUrl), TypeError);
  }

  assert.doesNotThrow(() => new NodeAgentClient("http://127.0.0.1:8080"));
  assert.doesNotThrow(() => new NodeAgentClient("https://registry.example"));
});

test("node agent server has deterministic bounded HTTP connection lifetimes", () => {
  const server = createNodeAgent({ descriptor: descriptor("node-http-limits-default") });
  assert.equal(server.headersTimeout, 5_000);
  assert.equal(server.requestTimeout, 10_000);
  assert.equal(server.keepAliveTimeout, 5_000);
});

test("node agent server accepts explicit positive HTTP connection lifetime bounds", () => {
  const server = createNodeAgent({
    descriptor: descriptor("node-http-limits-custom"),
    headersTimeoutMs: 2_500,
    requestTimeoutMs: 7_500,
    keepAliveTimeoutMs: 1_250,
  });
  assert.equal(server.headersTimeout, 2_500);
  assert.equal(server.requestTimeout, 7_500);
  assert.equal(server.keepAliveTimeout, 1_250);
});

test("node agent server rejects invalid HTTP connection lifetime bounds", () => {
  for (const [name, option] of [
    ["headersTimeoutMs", "headersTimeoutMs"],
    ["requestTimeoutMs", "requestTimeoutMs"],
    ["keepAliveTimeoutMs", "keepAliveTimeoutMs"],
  ]) {
    for (const value of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      assert.throws(
        () => createNodeAgent({ descriptor: descriptor(`${name}-${String(value)}`), [option]: value }),
        new RegExp(`${name} must be a positive finite number`),
      );
    }
  }
});

test("node agent listener rejects invalid host and port deterministically", async () => {
  for (const host of ["", "   ", " 127.0.0.1", null]) {
    const server = createNodeAgent({ descriptor: descriptor(`host-${String(host)}`) });
    await assert.rejects(listenNodeAgent(server, { host }), /host must be a non-empty trimmed string/);
    await closeNodeAgent(server);
  }

  for (const port of [-1, 1.5, 65_536, Number.POSITIVE_INFINITY, "8080"]) {
    const server = createNodeAgent({ descriptor: descriptor(`port-${String(port)}`) });
    await assert.rejects(listenNodeAgent(server, { port }), /port must be an integer between 0 and 65535/);
    await closeNodeAgent(server);
  }
});

test("node agent listener preserves valid local binding behavior", async () => {
  const server = createNodeAgent({ descriptor: descriptor("node-valid-listener-1") });
  const binding = await listenNodeAgent(server, { host: "127.0.0.1", port: 0 });
  try {
    assert.equal(binding.host, "127.0.0.1");
    assert.equal(Number.isInteger(binding.port), true);
    assert.equal(binding.port > 0, true);
    assert.equal(binding.url, `http://127.0.0.1:${binding.port}`);

    const client = new NodeAgentClient(binding.url);
    assert.deepEqual(await client.health(), { status: "ok", nodeId: "node-valid-listener-1" });
  } finally {
    await closeNodeAgent(server);
  }
});
