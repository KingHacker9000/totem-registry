import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { closeNodeAgent, createNodeAgent, listenNodeAgent } from "../src/node-agent.js";

function createTimeoutAgent(requestBodyTimeoutMs, onInvoke = () => {}) {
  return createNodeAgent({
    descriptor: {
      id: "node-body-timeout-1",
      name: "Body timeout node",
      platform: "linux",
      arch: "x64",
      capabilities: ["host.echo"],
    },
    requestBodyTimeoutMs,
    handlers: {
      "host.echo": async (input) => {
        onInvoke();
        return { echoed: input.value ?? null };
      },
    },
  });
}

function readResponse(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.once("error", reject);
    response.once("end", () => {
      try {
        resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("node agent fails closed when an invoke body stalls before completion", async () => {
  let handlerCalls = 0;
  const server = createTimeoutAgent(40, () => {
    handlerCalls += 1;
  });
  const binding = await listenNodeAgent(server);
  try {
    const startedAt = Date.now();
    const result = await new Promise((resolve, reject) => {
      const request = http.request(
        `${binding.url}/invoke`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "128",
          },
        },
        async (response) => {
          try {
            resolve(await readResponse(response));
          } catch (error) {
            reject(error);
          }
        },
      );
      request.once("error", reject);
      request.write('{"capability":"host.echo","input":');
    });

    assert.equal(result.status, 408);
    assert.deepEqual(result.body, { error: "request_body_timeout" });
    assert.equal(handlerCalls, 0);
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    await closeNodeAgent(server);
  }
});

test("node agent uses an absolute ingestion deadline against slow drip-fed bodies", async () => {
  let handlerCalls = 0;
  const server = createTimeoutAgent(60, () => {
    handlerCalls += 1;
  });
  const binding = await listenNodeAgent(server);
  try {
    const payload = JSON.stringify({ capability: "host.echo", input: { value: "slow" } });
    const result = await new Promise((resolve, reject) => {
      let interval;
      const request = http.request(
        `${binding.url}/invoke`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload)),
          },
        },
        async (response) => {
          clearInterval(interval);
          try {
            resolve(await readResponse(response));
          } catch (error) {
            reject(error);
          }
        },
      );
      request.once("error", (error) => {
        clearInterval(interval);
        reject(error);
      });

      let offset = 0;
      interval = setInterval(() => {
        if (offset >= payload.length) {
          clearInterval(interval);
          request.end();
          return;
        }
        request.write(payload[offset]);
        offset += 1;
      }, 15);
    });

    assert.equal(result.status, 408);
    assert.deepEqual(result.body, { error: "request_body_timeout" });
    assert.equal(handlerCalls, 0);
  } finally {
    await closeNodeAgent(server);
  }
});

test("node agent accepts a complete bounded invoke body before the ingestion deadline", async () => {
  const server = createTimeoutAgent(500);
  const binding = await listenNodeAgent(server);
  try {
    const response = await fetch(`${binding.url}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "host.echo", input: { value: 42 } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      nodeId: "node-body-timeout-1",
      capability: "host.echo",
      result: { echoed: 42 },
    });
  } finally {
    await closeNodeAgent(server);
  }
});

test("node agent rejects invalid request body timeout configuration", () => {
  assert.throws(() => createTimeoutAgent(0), /requestBodyTimeoutMs/);
  assert.throws(() => createTimeoutAgent(Number.POSITIVE_INFINITY), /requestBodyTimeoutMs/);
});
