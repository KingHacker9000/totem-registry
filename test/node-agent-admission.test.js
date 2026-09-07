import assert from "node:assert/strict";
import test from "node:test";
import { closeNodeAgent, createNodeAgent, listenNodeAgent } from "../src/node-agent.js";

function descriptor(capabilities) {
  return {
    id: "node-admission-1",
    name: "Admission node",
    platform: "linux",
    arch: "x64",
    capabilities,
  };
}

async function invoke(url, capability) {
  return fetch(`${url}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, input: {} }),
  });
}

test("node agent rejects invokes beyond the concurrent handler limit without entering handlers", async () => {
  let release;
  let entered = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = createNodeAgent({
    descriptor: descriptor(["host.block"]),
    maxConcurrentInvocations: 1,
    handlers: {
      "host.block": async () => {
        entered += 1;
        await gate;
        return { ok: true };
      },
    },
  });
  const binding = await listenNodeAgent(server);
  try {
    const first = invoke(binding.url, "host.block");
    while (entered === 0) await new Promise((resolve) => setImmediate(resolve));

    const health = await fetch(`${binding.url}/health`);
    assert.equal(health.status, 200);

    const saturated = await invoke(binding.url, "host.block");
    assert.equal(saturated.status, 503);
    assert.deepEqual(await saturated.json(), { error: "capability_overloaded" });
    assert.equal(entered, 1);

    release();
    assert.equal((await first).status, 200);

    const recovered = await invoke(binding.url, "host.block");
    assert.equal(recovered.status, 200);
    assert.equal(entered, 2);
  } finally {
    release?.();
    await closeNodeAgent(server);
  }
});

test("node agent releases invoke capacity after handler failure, timeout, and output serialization failure", async () => {
  const circular = {};
  circular.self = circular;
  const server = createNodeAgent({
    descriptor: descriptor(["host.fail", "host.timeout", "host.circular", "host.ok"]),
    maxConcurrentInvocations: 1,
    handlerTimeoutMs: 15,
    handlers: {
      "host.fail": async () => {
        throw new Error("private failure");
      },
      "host.timeout": async () => new Promise(() => {}),
      "host.circular": async () => circular,
      "host.ok": async () => ({ ok: true }),
    },
  });
  const binding = await listenNodeAgent(server);
  try {
    for (const [capability, expectedStatus] of [
      ["host.fail", 500],
      ["host.timeout", 504],
      ["host.circular", 500],
    ]) {
      const failed = await invoke(binding.url, capability);
      assert.equal(failed.status, expectedStatus);
      const recovered = await invoke(binding.url, "host.ok");
      assert.equal(recovered.status, 200);
      assert.deepEqual(await recovered.json(), {
        nodeId: "node-admission-1",
        capability: "host.ok",
        result: { ok: true },
      });
    }
  } finally {
    await closeNodeAgent(server);
  }
});

test("node agent validates concurrent invoke admission configuration", () => {
  for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createNodeAgent({ descriptor: descriptor([]), maxConcurrentInvocations: value }),
      /maxConcurrentInvocations/,
    );
  }
  assert.doesNotThrow(() => createNodeAgent({ descriptor: descriptor([]), maxConcurrentInvocations: 1 }));
});
