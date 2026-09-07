import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const REGISTRY_SCHEMA = "totem.registry/v0";
export const ROLLBACK_SCHEMA = "totem.registry.rollback/v0";
export const PACKAGE_KINDS = new Set(["extension", "theme", "agent-provider", "node-plugin"]);

const PACKAGE_FIELDS = new Set(["id", "kind", "version", "source", "sha256", "compatibility", "permissions"]);
const COMPATIBILITY_FIELDS = new Set(["totem"]);
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value !== value.trim()) throw new TypeError(`${name} must not contain leading or trailing whitespace`);
}

function assertKnownFields(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unsupported field '${key}'`);
  }
}

function assertUtcTimestamp(value, name) {
  assertString(value, name);
  if (!RFC3339_UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an RFC 3339 UTC timestamp`);
  }
}

function assertArtifactSource(value) {
  assertString(value, "source");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("source must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError("source must be an absolute HTTPS URL without credentials or a fragment");
  }
}

function validatePermissions(value) {
  if (!Array.isArray(value)) throw new TypeError("permissions must be an array of non-empty strings");
  const seen = new Set();
  const permissions = value.map((permission) => {
    assertString(permission, "permission");
    if (seen.has(permission)) throw new TypeError(`duplicate permission '${permission}'`);
    seen.add(permission);
    return permission;
  });
  return Object.freeze(permissions);
}

function validateCompatibility(value) {
  assertObject(value, "compatibility");
  assertKnownFields(value, COMPATIBILITY_FIELDS, "compatibility");
  const compatibility = {};
  if (value.totem !== undefined) {
    assertString(value.totem, "compatibility.totem");
    compatibility.totem = value.totem;
  }
  return Object.freeze(compatibility);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validatePackageVersion(input) {
  assertObject(input, "package version");
  assertKnownFields(input, PACKAGE_FIELDS, "package version");
  assertString(input.id, "id");
  assertString(input.kind, "kind");
  if (!PACKAGE_KINDS.has(input.kind)) throw new TypeError(`unsupported kind '${input.kind}'`);
  assertString(input.version, "version");
  assertArtifactSource(input.source);
  assertString(input.sha256, "sha256");
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new TypeError("sha256 must be 64 hex characters");

  const compatibility = input.compatibility === undefined ? undefined : validateCompatibility(input.compatibility);
  const permissions = input.permissions === undefined ? undefined : validatePermissions(input.permissions);
  return Object.freeze({
    id: input.id,
    kind: input.kind,
    version: input.version,
    source: input.source,
    sha256: input.sha256.toLowerCase(),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(permissions === undefined ? {} : { permissions }),
  });
}

export function validateRegistryIndex(index) {
  assertObject(index, "registry index");
  assertKnownFields(index, new Set(["schema", "generatedAt", "packages"]), "registry index");
  if (index.schema !== REGISTRY_SCHEMA) throw new TypeError("unsupported registry schema");
  assertUtcTimestamp(index.generatedAt, "generatedAt");
  if (!Array.isArray(index.packages)) throw new TypeError("packages must be an array");
  const packages = index.packages.map(validatePackageVersion);
  const seen = new Set();
  for (const pkg of packages) {
    const key = `${pkg.kind}:${pkg.id}:${pkg.version}`;
    if (seen.has(key)) throw new TypeError(`duplicate package version '${key}'`);
    seen.add(key);
  }
  packages.sort((a, b) => `${a.kind}:${a.id}:${a.version}`.localeCompare(`${b.kind}:${b.id}:${b.version}`));
  return Object.freeze({ schema: REGISTRY_SCHEMA, generatedAt: index.generatedAt, packages: Object.freeze(packages) });
}

export function createRegistryIndex({ generatedAt, packages }) {
  return validateRegistryIndex({ schema: REGISTRY_SCHEMA, generatedAt, packages });
}

export function signRegistryIndex(index, privateKeyPem, keyId) {
  assertString(keyId, "keyId");
  const validatedIndex = validateRegistryIndex(index);
  const payload = canonicalJson(validatedIndex);
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(payload), privateKey).toString("base64url");
  return { index: validatedIndex, signature: { algorithm: "Ed25519", keyId, value: signature } };
}

export function verifySignedRegistry(signedIndex, trustedKeys) {
  assertObject(signedIndex, "signed registry");
  assertObject(signedIndex.signature, "signature");
  const { keyId, algorithm, value } = signedIndex.signature;
  if (algorithm !== "Ed25519") return { ok: false, reason: "unsupported_signature_algorithm" };
  const publicKeyPem = trustedKeys?.[keyId];
  if (!publicKeyPem) return { ok: false, reason: "untrusted_key" };
  try {
    const validatedIndex = validateRegistryIndex(signedIndex.index);
    const publicKey = createPublicKey(publicKeyPem);
    const ok = verify(null, Buffer.from(canonicalJson(validatedIndex)), publicKey, Buffer.from(value, "base64url"));
    return ok ? { ok: true } : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "invalid_registry" };
  }
}

export function verifyArtifact(bytes, expectedSha256) {
  assertString(expectedSha256, "expectedSha256");
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new TypeError("expectedSha256 must be 64 hex characters");
  return sha256Hex(bytes).toLowerCase() === expectedSha256.toLowerCase();
}

export function planInstall({ installed, candidate, grantedPermissions = [] }) {
  const pkg = validatePackageVersion(candidate);
  if (!Array.isArray(grantedPermissions)) throw new TypeError("grantedPermissions must be an array of non-empty strings");
  const granted = new Set(validatePermissions(grantedPermissions));
  const current = installed?.[`${pkg.kind}:${pkg.id}`] ?? null;
  const requested = new Set(pkg.permissions ?? []);
  const missingPermissions = [...requested].filter((permission) => !granted.has(permission)).sort();
  return {
    action: current ? "update" : "install",
    currentVersion: current?.version ?? null,
    targetVersion: pkg.version,
    package: pkg,
    missingPermissions,
    autoGrant: false,
  };
}

function validateRollbackPackage(value, name) {
  assertObject(value, name);
  assertKnownFields(value, new Set(["id", "kind", "version"]), name);
  assertString(value.id, `${name}.id`);
  assertString(value.kind, `${name}.kind`);
  if (!PACKAGE_KINDS.has(value.kind)) throw new TypeError(`unsupported kind '${value.kind}'`);
  assertString(value.version, `${name}.version`);
  return Object.freeze({ id: value.id, kind: value.kind, version: value.version });
}

export function validateRollbackRecord(record) {
  assertObject(record, "rollback record");
  assertKnownFields(
    record,
    new Set(["schema", "packageKey", "fromVersion", "toVersion", "previous", "installed"]),
    "rollback record",
  );
  if (record.schema !== ROLLBACK_SCHEMA) throw new TypeError("unsupported rollback schema");
  const installed = validateRollbackPackage(record.installed, "installed");
  const expectedKey = `${installed.kind}:${installed.id}`;
  if (record.packageKey !== expectedKey) throw new TypeError("rollback packageKey does not match installed package");
  if (record.fromVersion !== installed.version) throw new TypeError("rollback fromVersion does not match installed package");

  let previous = null;
  if (record.previous !== null) {
    previous = validateRollbackPackage(record.previous, "previous");
    if (previous.id !== installed.id || previous.kind !== installed.kind) {
      throw new TypeError("rollback previous package identity does not match installed package");
    }
    if (record.toVersion !== previous.version) throw new TypeError("rollback toVersion does not match previous package");
  } else if (record.toVersion !== null) {
    throw new TypeError("rollback toVersion must be null when previous is null");
  }

  return Object.freeze({
    schema: ROLLBACK_SCHEMA,
    packageKey: expectedKey,
    fromVersion: installed.version,
    toVersion: previous?.version ?? null,
    previous,
    installed,
  });
}

export function createRollbackRecord(previous, installed) {
  return validateRollbackRecord({
    schema: ROLLBACK_SCHEMA,
    packageKey: `${installed?.kind}:${installed?.id}`,
    fromVersion: installed?.version,
    toVersion: previous?.version ?? null,
    previous: previous ?? null,
    installed,
  });
}

export function applyRollback(record) {
  return validateRollbackRecord(record).previous;
}
