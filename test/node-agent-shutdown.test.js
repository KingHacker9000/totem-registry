import assert from "node:assert/strict";
import test from "node:test";
import { closeNodeAgent, createNodeAgent, listenNodeAgent } from "../src/node-agent.js";

function descriptor(id) {
  return {
    id,
    name: "Shutdown boundary node",
    platform: "linux",
    arch: "x64",
    capabilities: ["slow"],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function invoke(url) {
  return fetch(`${url}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: "slow", input: {} }),
  });
}

test("closeNodeAgent gives normal in-flight work a graceful drain window", async () => {
  const started = deferred();
  const release = deferred();
  const server = createNodeAgent({
    descriptor: descriptor("node-shutdown-graceful"),
    handlerTimeoutMs: 2_000,
    handlers: {
      slow: async () => {
        started.resolve();
        await release.promise;
        return { ok: true };
      },
    },
  });
  const { url } = await listenNodeAgent(server);
  const responsePromise = invoke(url);
  await started.promise;

  const closePromise = closeNodeAgent(server, { shutdownTimeoutMs: 500 });
  release.resolve();

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    nodeId: "node-shutdown-graceful",
    capability: "slow",
    result: { ok: true },
  });
  await closePromise;
  assert.equal(server.listening, false);
});

test("closeNodeAgent force-closes pathological active connections after the bound", async () => {
  const started = deferred();
  const release = deferred();
  const server = createNodeAgent({
    descriptor: descriptor("node-shutdown-forced"),
    handlerTimeoutMs: 5_000,
    handlers: {
      slow: async () => {
        started.resolve();
        await release.promise;
        return { ok: true };
      },
    },
  });
  const { url } = await listenNodeAgent(server);
  const responsePromise = invoke(url).catch((error) => error);
  await started.promise;

  const before = Date.now();
  await closeNodeAgent(server, { shutdownTimeoutMs: 50 });
  const elapsed = Date.now() - before;

  assert.equal(server.listening, false);
  assert.equal(elapsed >= 25, true);
  assert.equal(elapsed < 1_000, true);

  release.resolve();
  await responsePromise;
});

test("closeNodeAgent validates shutdown bounds and remains repeat-safe", async () => {
  const server = createNodeAgent({ descriptor: descriptor("node-shutdown-config") });

  for (const shutdownTimeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    await assert.rejects(
      closeNodeAgent(server, { shutdownTimeoutMs }),
      /shutdownTimeoutMs must be a positive finite number/,
    );
  }

  await listenNodeAgent(server);
  await Promise.all([
    closeNodeAgent(server, { shutdownTimeoutMs: 250 }),
    closeNodeAgent(server, { shutdownTimeoutMs: 250 }),
  ]);
  await closeNodeAgent(server, { shutdownTimeoutMs: 250 });
  assert.equal(server.listening, false);
});
