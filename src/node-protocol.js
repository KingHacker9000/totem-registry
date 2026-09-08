export const NODE_PROTOCOL_SCHEMA = "totem.node/v0";

export const NODE_PROTOCOL_LIMITS = Object.freeze({
  maxStringLength: 4096,
  maxStringArrayItems: 256,
  maxJsonDepth: 24,
  maxJsonMembers: 4096,
  maxJsonArrayItems: 1024,
  maxJsonObjectKeys: 1024,
  maxRouteNodes: 2048,
});

const NODE_EVENT_TYPES = new Set(["node.registered", "node.updated", "node.heartbeat", "node.offline"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  if (value.length > NODE_PROTOCOL_LIMITS.maxStringLength) {
    throw new TypeError(`${name} exceeds maximum length of ${NODE_PROTOCOL_LIMITS.maxStringLength}`);
  }
}

function stringArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of non-empty strings`);
  if (value.length > NODE_PROTOCOL_LIMITS.maxStringArrayItems) {
    throw new TypeError(`${name} exceeds maximum item count of ${NODE_PROTOCOL_LIMITS.maxStringArrayItems}`);
  }
  for (const item of value) {
    nonEmptyString(item, `${name} item`);
  }
  return [...new Set(value)].sort();
}

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${name} must be a plain object`);
}

function timestamp(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return;
  nonEmptyString(value, name);
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO-8601 UTC timestamp`);
  }
}

function jsonValue(value, name, state = { members: 0 }, depth = 0, seen = new Set()) {
  if (depth > NODE_PROTOCOL_LIMITS.maxJsonDepth) {
    throw new TypeError(`${name} exceeds maximum JSON depth of ${NODE_PROTOCOL_LIMITS.maxJsonDepth}`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > NODE_PROTOCOL_LIMITS.maxStringLength) {
      throw new TypeError(`${name} contains a string exceeding maximum length of ${NODE_PROTOCOL_LIMITS.maxStringLength}`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must contain only finite JSON values`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > NODE_PROTOCOL_LIMITS.maxJsonArrayItems) {
      throw new TypeError(`${name} exceeds maximum array length of ${NODE_PROTOCOL_LIMITS.maxJsonArrayItems}`);
    }
    if (seen.has(value)) throw new TypeError(`${name} must not contain circular references`);
    state.members += value.length;
    if (state.members > NODE_PROTOCOL_LIMITS.maxJsonMembers) {
      throw new TypeError(`${name} exceeds maximum JSON member count of ${NODE_PROTOCOL_LIMITS.maxJsonMembers}`);
    }
    seen.add(value);
    value.forEach((item, index) => jsonValue(item, `${name}[${index}]`, state, depth + 1, seen));
    seen.delete(value);
    return;
  }
  plainObject(value, name);
  const entries = Object.entries(value);
  if (entries.length > NODE_PROTOCOL_LIMITS.maxJsonObjectKeys) {
    throw new TypeError(`${name} exceeds maximum object key count of ${NODE_PROTOCOL_LIMITS.maxJsonObjectKeys}`);
  }
  if (seen.has(value)) throw new TypeError(`${name} must not contain circular references`);
  state.members += entries.length;
  if (state.members > NODE_PROTOCOL_LIMITS.maxJsonMembers) {
    throw new TypeError(`${name} exceeds maximum JSON member count of ${NODE_PROTOCOL_LIMITS.maxJsonMembers}`);
  }
  seen.add(value);
  for (const [key, item] of entries) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) throw new TypeError(`${name} contains unsafe key '${key}'`);
    if (key.length > NODE_PROTOCOL_LIMITS.maxStringLength) {
      throw new TypeError(`${name} contains a key exceeding maximum length of ${NODE_PROTOCOL_LIMITS.maxStringLength}`);
    }
    jsonValue(item, `${name}.${key}`, state, depth + 1, seen);
  }
  seen.delete(value);
}

function metadataObject(value) {
  plainObject(value, "metadata");
  jsonValue(value, "metadata");
}

export function createNodeDescriptor(input) {
  plainObject(input, "node descriptor");
  nonEmptyString(input.id, "id");
  nonEmptyString(input.name, "name");
  nonEmptyString(input.platform, "platform");
  nonEmptyString(input.arch, "arch");
  const capabilities = stringArray(input.capabilities ?? [], "capabilities");
  const tags = stringArray(input.tags ?? [], "tags");
  const online = input.online ?? true;
  if (typeof online !== "boolean") throw new TypeError("online must be a boolean");
  const lastSeenAt = input.lastSeenAt ?? null;
  timestamp(lastSeenAt, "lastSeenAt", { nullable: true });
  const metadata = input.metadata ?? {};
  metadataObject(metadata);
  return {
    schema: NODE_PROTOCOL_SCHEMA,
    id: input.id,
    name: input.name,
    platform: input.platform,
    arch: input.arch,
    capabilities,
    tags,
    online,
    lastSeenAt,
    metadata,
  };
}

export function validateNodeEnvelope(envelope) {
  plainObject(envelope, "node envelope");
  if (envelope.schema !== NODE_PROTOCOL_SCHEMA) throw new TypeError("unsupported node protocol schema");
  nonEmptyString(envelope.type, "type");
  if (!NODE_EVENT_TYPES.has(envelope.type)) throw new TypeError(`unsupported node event type '${envelope.type}'`);
  nonEmptyString(envelope.nodeId, "nodeId");
  nonEmptyString(envelope.id, "id");
  timestamp(envelope.occurredAt, "occurredAt");
  plainObject(envelope.payload, "payload");
  jsonValue(envelope.payload, "payload");
  return envelope;
}

export function createNodeEnvelope({ id, type, nodeId, occurredAt, payload }) {
  return validateNodeEnvelope({ schema: NODE_PROTOCOL_SCHEMA, id, type, nodeId, occurredAt, payload });
}

export function canRunOnNode(node, requiredCapabilities = []) {
  const descriptor = createNodeDescriptor(node);
  const available = new Set(descriptor.capabilities);
  const missing = stringArray(requiredCapabilities, "requiredCapabilities").filter((capability) => !available.has(capability));
  return { ok: missing.length === 0 && descriptor.online, missing, online: descriptor.online };
}

export function routeWorkflow(nodes, requiredCapabilities = []) {
  if (!Array.isArray(nodes)) throw new TypeError("nodes must be an array");
  if (nodes.length > NODE_PROTOCOL_LIMITS.maxRouteNodes) {
    throw new TypeError(`nodes exceeds maximum item count of ${NODE_PROTOCOL_LIMITS.maxRouteNodes}`);
  }
  const candidates = nodes
    .map(createNodeDescriptor)
    .map((node) => ({ node, match: canRunOnNode(node, requiredCapabilities) }))
    .filter(({ match }) => match.ok)
    .sort((a, b) => a.node.id.localeCompare(b.node.id));
  return candidates[0]?.node ?? null;
}

export function reduceNodeState(current, envelope) {
  validateNodeEnvelope(envelope);
  if (current && current.id !== envelope.nodeId) throw new TypeError("envelope nodeId does not match current node");
  if (envelope.type === "node.registered" || envelope.type === "node.updated") {
    return createNodeDescriptor({ ...envelope.payload, id: envelope.nodeId });
  }
  if (envelope.type === "node.heartbeat") {
    if (!current) throw new TypeError("heartbeat requires an existing node");
    return { ...current, online: true, lastSeenAt: envelope.occurredAt };
  }
  if (envelope.type === "node.offline") {
    if (!current) throw new TypeError("offline requires an existing node");
    return { ...current, online: false, lastSeenAt: envelope.occurredAt };
  }
  throw new TypeError(`unsupported node event type '${envelope.type}'`);
}
