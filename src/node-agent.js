import http from "node:http";
import { createNodeDescriptor } from "./node-protocol.js";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 5_000;
const DEFAULT_SERVER_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_INVOCATIONS = 8;
const DEFAULT_HEADERS_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_CLIENT_TIMEOUT_MS = 5_000;
const DEFAULT_CLIENT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CLIENT_REQUEST_BODY_BYTES = MAX_REQUEST_BODY_BYTES;

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function serializeJson(body, { maxBytes, invalidCode, tooLargeCode } = {}) {
  let payload;
  try {
    payload = JSON.stringify(body);
  } catch {
    if (invalidCode) throw new RequestError(500, invalidCode);
    throw new RequestError(500, "node_agent_error");
  }
  const bytes = Buffer.byteLength(payload);
  if (maxBytes !== undefined && bytes > maxBytes) {
    throw new RequestError(500, tooLargeCode ?? "node_agent_response_too_large");
  }
  return { payload, bytes };
}

function json(reply, statusCode, body, options) {
  const { payload, bytes } = serializeJson(body, options);
  reply.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes,
  });
  reply.end(payload);
}

function requireJsonContentType(request) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "unsupported_media_type");
  }
}

function readJson(request, timeoutMs) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestError(413, "request_too_large");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        finish(new RequestError(413, "request_too_large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (chunks.length === 0) {
        finish(null, {});
        return;
      }
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(new RequestError(400, "invalid_json"));
      }
    };

    const onError = () => finish(new RequestError(400, "request_aborted"));
    const onAborted = () => finish(new RequestError(400, "request_aborted"));
    const timer = setTimeout(() => {
      finish(new RequestError(408, "request_body_timeout"));
      request.resume();
    }, timeoutMs);

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function requirePositiveLimit(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function requireListenerHost(host) {
  if (typeof host !== "string" || host.trim() === "" || host !== host.trim()) {
    throw new TypeError("host must be a non-empty trimmed string");
  }
  return host;
}

function requireListenerPort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be an integer between 0 and 65535");
  }
  return port;
}

function requireClientBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("baseUrl must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("baseUrl must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("baseUrl must not contain embedded credentials");
  }
  return url;
}

async function invokeWithDeadline(handler, input, node, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new RequestError(504, "capability_timeout"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([handler(input, { node, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createNodeAgent({
  descriptor,
  handlers = {},
  requestBodyTimeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_SERVER_MAX_RESPONSE_BYTES,
  maxConcurrentInvocations = DEFAULT_MAX_CONCURRENT_INVOCATIONS,
  headersTimeoutMs = DEFAULT_HEADERS_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  keepAliveTimeoutMs = DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
}) {
  const node = createNodeDescriptor(descriptor);
  const capabilities = new Map(Object.entries(handlers));
  const bodyTimeoutMs = requirePositiveLimit(requestBodyTimeoutMs, "requestBodyTimeoutMs");
  const executionTimeoutMs = requirePositiveLimit(handlerTimeoutMs, "handlerTimeoutMs");
  const responseByteLimit = requirePositiveLimit(maxResponseBytes, "maxResponseBytes");
  const invocationLimit = requirePositiveInteger(maxConcurrentInvocations, "maxConcurrentInvocations");
  const headerTimeoutMs = requirePositiveLimit(headersTimeoutMs, "headersTimeoutMs");
  const requestLifetimeMs = requirePositiveLimit(requestTimeoutMs, "requestTimeoutMs");
  const keepAliveLifetimeMs = requirePositiveLimit(keepAliveTimeoutMs, "keepAliveTimeoutMs");
  let activeInvocations = 0;

  const server = http.createServer(async (request, reply) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return json(reply, 200, { status: "ok", nodeId: node.id });
      }
      if (request.method === "GET" && request.url === "/descriptor") {
        return json(reply, 200, node);
      }
      if (request.method === "POST" && request.url === "/invoke") {
        requireJsonContentType(request);
        const body = await readJson(request, bodyTimeoutMs);
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
        if (activeInvocations >= invocationLimit) {
          return json(reply, 503, { error: "capability_overloaded" });
        }
        activeInvocations += 1;
        try {
          const result = await invokeWithDeadline(handler, body.input ?? {}, node, executionTimeoutMs);
          return json(
            reply,
            200,
            { nodeId: node.id, capability: body.capability, result },
            {
              maxBytes: responseByteLimit,
              invalidCode: "capability_output_invalid",
              tooLargeCode: "capability_output_too_large",
            },
          );
        } finally {
          activeInvocations -= 1;
        }
      }
      return json(reply, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.code === "request_body_timeout") reply.shouldKeepAlive = false;
        return json(reply, error.status, { error: error.code });
      }
      return json(reply, 500, { error: "node_agent_error" });
    }
  });

  server.headersTimeout = headerTimeoutMs;
  server.requestTimeout = requestLifetimeMs;
  server.keepAliveTimeout = keepAliveLifetimeMs;
  return server;
}

export async function listenNodeAgent(server, { host = "127.0.0.1", port = 0 } = {}) {
  const listenerHost = requireListenerHost(host);
  const listenerPort = requireListenerPort(port);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenerPort, listenerHost, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("node agent did not bind a TCP address");
  return { host: listenerHost, port: address.port, url: `http://${listenerHost}:${address.port}` };
}

export async function closeNodeAgent(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function clientError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function serializeClientRequestJson(body) {
  let payload;
  try {
    payload = JSON.stringify(body);
  } catch {
    throw clientError("node_agent_request_invalid", "node agent request contains invalid JSON");
  }
  if (Buffer.byteLength(payload) > MAX_CLIENT_REQUEST_BODY_BYTES) {
    throw clientError("node_agent_request_too_large", "node agent request exceeds size limit");
  }
  return payload;
}

function isJsonContentType(response) {
  const contentType = response.headers.get("content-type");
  return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function readBoundedResponseJson(response, maxResponseBytes) {
  if (!isJsonContentType(response)) {
    throw clientError(
      "node_agent_unsupported_media_type",
      "node agent response is not application/json",
      response.status,
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw clientError("node_agent_response_too_large", "node agent response exceeds size limit", response.status);
  }

  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxResponseBytes) {
        throw clientError("node_agent_response_too_large", "node agent response exceeds size limit", response.status);
      }
      chunks.push(bytes);
    }
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw clientError("node_agent_invalid_json", "node agent response contains invalid JSON", response.status);
  }
}

export class NodeAgentClient {
  constructor(
    baseUrl,
    {
      fetchImpl = fetch,
      timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS,
      maxResponseBytes = DEFAULT_CLIENT_MAX_RESPONSE_BYTES,
    } = {},
  ) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    this.baseUrl = requireClientBaseUrl(baseUrl);
    this.fetch = fetchImpl;
    this.timeoutMs = requirePositiveLimit(timeoutMs, "timeoutMs");
    this.maxResponseBytes = requirePositiveLimit(maxResponseBytes, "maxResponseBytes");
  }

  async #json(path, init = {}) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(clientError("node_agent_timeout", "node agent request timed out"));
      }, this.timeoutMs);
    });

    try {
      const request = (async () => {
        const response = await this.fetch(new URL(path, this.baseUrl), {
          ...init,
          signal: controller.signal,
        });
        const body = await readBoundedResponseJson(response, this.maxResponseBytes);
        return { response, body };
      })();

      const { response, body } = await Promise.race([request, timeout]);
      if (!response.ok) {
        const message =
          typeof body?.message === "string"
            ? body.message
            : typeof body?.error === "string"
              ? body.error
              : `node agent request failed with ${response.status}`;
        const code = typeof body?.error === "string" ? body.error : "node_agent_request_failed";
        throw clientError(code, message, response.status);
      }
      return body;
    } catch (error) {
      if (error?.code?.startsWith?.("node_agent_") || typeof error?.status === "number") throw error;
      if (controller.signal.aborted) {
        throw clientError("node_agent_timeout", "node agent request timed out");
      }
      throw clientError("node_agent_transport_error", "node agent request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  health() {
    return this.#json("/health");
  }

  descriptor() {
    return this.#json("/descriptor");
  }

  async invoke(capability, input = {}) {
    const body = serializeClientRequestJson({ capability, input });
    return this.#json("/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }
}
