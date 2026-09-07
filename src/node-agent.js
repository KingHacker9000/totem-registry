import http from "node:http";
import { createNodeDescriptor } from "./node-protocol.js";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(reply, statusCode, body) {
  const payload = JSON.stringify(body);
  reply.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  reply.end(payload);
}

function requireJsonContentType(request) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "unsupported_media_type");
  }
}

async function readJson(request) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestError(413, "request_too_large");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) throw new RequestError(413, "request_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid_json");
  }
}

export function createNodeAgent({ descriptor, handlers = {} }) {
  const node = createNodeDescriptor(descriptor);
  const capabilities = new Map(Object.entries(handlers));

  return http.createServer(async (request, reply) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return json(reply, 200, { status: "ok", nodeId: node.id });
      }
      if (request.method === "GET" && request.url === "/descriptor") {
        return json(reply, 200, node);
      }
      if (request.method === "POST" && request.url === "/invoke") {
        requireJsonContentType(request);
        const body = await readJson(request);
        if (typeof body.capability !== "string" || body.capability.trim() === "") {
          return json(reply, 400, { error: "invalid_capability" });
        }
        if (!node.capabilities.includes(body.capability)) {
          return json(reply, 403, { error: "capability_not_advertised" });
        }
        const handler = capabilities.get(body.capability);
        if (!handler) {
          return json(reply, 501, { error: "capability_not_implemented" });
        }
        const result = await handler(body.input ?? {}, { node });
        return json(reply, 200, { nodeId: node.id, capability: body.capability, result });
      }
      return json(reply, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof RequestError) return json(reply, error.status, { error: error.code });
      return json(reply, 500, { error: "node_agent_error" });
    }
  });
}

export async function listenNodeAgent(server, { host = "127.0.0.1", port = 0 } = {}) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("node agent did not bind a TCP address");
  return { host, port: address.port, url: `http://${host}:${address.port}` };
}

export async function closeNodeAgent(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export class NodeAgentClient {
  constructor(baseUrl, { fetchImpl = fetch } = {}) {
    this.baseUrl = new URL(baseUrl);
    this.fetch = fetchImpl;
  }

  async #json(path, init) {
    const response = await this.fetch(new URL(path, this.baseUrl), init);
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.message ?? body.error ?? `node agent request failed with ${response.status}`);
      error.status = response.status;
      error.code = body.error ?? "node_agent_request_failed";
      throw error;
    }
    return body;
  }

  health() {
    return this.#json("/health");
  }

  descriptor() {
    return this.#json("/descriptor");
  }

  invoke(capability, input = {}) {
    return this.#json("/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability, input }),
    });
  }
}
