export const NODE_PROTOCOL_SCHEMA = "totem.node/v0";

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  return [...new Set(value)].sort();
}

export function createNodeDescriptor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("node descriptor must be an object");
  nonEmptyString(input.id, "id");
  nonEmptyString(input.name, "name");
  nonEmptyString(input.platform, "platform");
  nonEmptyString(input.arch, "arch");
  const capabilities = stringArray(input.capabilities ?? [], "capabilities");
  const tags = stringArray(input.tags ?? [], "tags");
  return {
    schema: NODE_PROTOCOL_SCHEMA,
    id: input.id,
    name: input.name,
    platform: input.platform,
    arch: input.arch,
    capabilities,
    tags,
    online: input.online ?? true,
    lastSeenAt: input.lastSeenAt ?? null,
    metadata: input.metadata ?? {},
  };
}

export function validateNodeEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new TypeError("node envelope must be an object");
  if (envelope.schema !== NODE_PROTOCOL_SCHEMA) throw new TypeError("unsupported node protocol schema");
  nonEmptyString(envelope.type, "type");
  nonEmptyString(envelope.nodeId, "nodeId");
  nonEmptyString(envelope.id, "id");
  nonEmptyString(envelope.occurredAt, "occurredAt");
  if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
    throw new TypeError("payload must be an object");
  }
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
  return current;
}
