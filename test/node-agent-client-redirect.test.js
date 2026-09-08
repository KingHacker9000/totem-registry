import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { NodeAgentClient } from "../src/node-agent.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("node agent client forces manual redirect handling for every request", async () => {
  const observed = [];
  const client = new NodeAgentClient("http://127.0.0.1:1", {
    fetchImpl: async (url, init) => {
      observed.push({ url: String(url), method: init.method ?? "GET", redirect: init.redirect });
      return new Response(null, { status: 307, headers: { location: "http://127.0.0.1:2/elsewhere" } });
    },
  });

  for (const request of [() => client.health(), () => client.descriptor(), () => client.invoke("host.echo", { value: 1 })]) {
    await assert.rejects(request(), (error) => {
      assert.equal(error.code, "node_agent_redirect");
      assert.equal(error.status, 307);
      assert.equal(error.message, "node agent redirect rejected");
      return true;
    });
  }

  assert.deepEqual(
    observed.map(({ method, redirect }) => ({ method, redirect })),
    [
      { method: "GET", redirect: "manual" },
      { method: "GET", redirect: "manual" },
      { method: "POST", redirect: "manual" },
    ],
  );
});

test("invoke body is never replayed to a cross-origin redirect target", async () => {
  let redirectTargetHits = 0;
  let redirectTargetBody = "";
  const target = http.createServer((request, response) => {
    redirectTargetHits += 1;
    request.on("data", (chunk) => {
      redirectTargetBody += chunk.toString("utf8");
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ unexpected: true }));
    });
  });
  const targetUrl = await listen(target);

  let sourceHits = 0;
  const source = http.createServer((request, response) => {
    sourceHits += 1;
    request.resume();
    response.writeHead(307, { location: `${targetUrl}/captured` });
    response.end();
  });
  const sourceUrl = await listen(source);

  try {
    const client = new NodeAgentClient(sourceUrl);
    await assert.rejects(client.invoke("host.echo", { secret: "do-not-forward" }), (error) => {
      assert.equal(error.code, "node_agent_redirect");
      assert.equal(error.status, 307);
      return true;
    });
    assert.equal(sourceHits, 1);
    assert.equal(redirectTargetHits, 0);
    assert.equal(redirectTargetBody, "");
  } finally {
    await close(source);
    await close(target);
  }
});
