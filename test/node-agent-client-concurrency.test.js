import assert from "node:assert/strict";
import test from "node:test";
import { NodeAgentClient } from "../src/node-agent.js";

const jsonResponse = (body = { status: "ok" }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("node agent client rejects invalid concurrency limits", () => {
  for (const maxConcurrentRequests of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new NodeAgentClient("http://127.0.0.1:1", { maxConcurrentRequests }),
      /maxConcurrentRequests must be a positive safe integer/,
    );
  }
});

test("node agent client fails fast once its outbound concurrency limit is full", async () => {
  const first = deferred();
  const second = deferred();
  let fetchCalls = 0;
  const client = new NodeAgentClient("http://127.0.0.1:1", {
    maxConcurrentRequests: 2,
    timeoutMs: 1_000,
    fetchImpl: async () => {
      fetchCalls += 1;
      return fetchCalls === 1 ? first.promise : second.promise;
    },
  });

  const firstRequest = client.health();
  const secondRequest = client.descriptor();
  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, "node_agent_overloaded");
    assert.equal(error.status, undefined);
    assert.equal(error.message, "node agent client request limit reached");
    return true;
  });
  assert.equal(fetchCalls, 2);

  first.resolve(jsonResponse());
  second.resolve(jsonResponse({ schema: "totem.node/v0" }));
  await Promise.all([firstRequest, secondRequest]);
});

test("node agent client releases concurrency after success and transport failure", async () => {
  const first = deferred();
  let fetchCalls = 0;
  const client = new NodeAgentClient("http://127.0.0.1:1", {
    maxConcurrentRequests: 1,
    timeoutMs: 1_000,
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return first.promise;
      if (fetchCalls === 2) throw new Error("private network detail");
      return jsonResponse();
    },
  });

  const inFlight = client.health();
  await assert.rejects(client.descriptor(), (error) => error.code === "node_agent_overloaded");
  first.resolve(jsonResponse());
  await inFlight;

  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, "node_agent_transport_error");
    assert.equal(error.message, "node agent request failed");
    assert.equal(error.message.includes("private network detail"), false);
    return true;
  });

  assert.deepEqual(await client.health(), { status: "ok" });
  assert.equal(fetchCalls, 3);
});

test("node agent client releases concurrency after timeout", async () => {
  let fetchCalls = 0;
  const client = new NodeAgentClient("http://127.0.0.1:1", {
    maxConcurrentRequests: 1,
    timeoutMs: 15,
    fetchImpl: async (_url, { signal }) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return jsonResponse();
    },
  });

  await assert.rejects(client.health(), (error) => error.code === "node_agent_timeout");
  assert.deepEqual(await client.health(), { status: "ok" });
  assert.equal(fetchCalls, 2);
});
