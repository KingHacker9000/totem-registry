import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const REGISTRY_SCHEMA = "totem.registry/v0";
export const PACKAGE_KINDS = new Set(["extension", "theme", "agent-provider", "node-plugin"]);

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
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
  assertString(input.id, "id");
  assertString(input.kind, "kind");
  if (!PACKAGE_KINDS.has(input.kind)) throw new TypeError(`unsupported kind '${input.kind}'`);
  assertString(input.version, "version");
  assertString(input.source, "source");
  assertString(input.sha256, "sha256");
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new TypeError("sha256 must be 64 hex characters");
  if (input.compatibility !== undefined) {
    assertObject(input.compatibility, "compatibility");
    if (input.compatibility.totem !== undefined) assertString(input.compatibility.totem, "compatibility.totem");
  }
  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions) || input.permissions.some((p) => typeof p !== "string")) {
      throw new TypeError("permissions must be an array of strings");
    }
  }
  return Object.freeze({ ...input });
}

export function createRegistryIndex({ generatedAt, packages }) {
  assertString(generatedAt, "generatedAt");
  if (!Array.isArray(packages)) throw new TypeError("packages must be an array");
  const validated = packages.map(validatePackageVersion);
  const seen = new Set();
  for (const pkg of validated) {
    const key = `${pkg.kind}:${pkg.id}:${pkg.version}`;
    if (seen.has(key)) throw new TypeError(`duplicate package version '${key}'`);
    seen.add(key);
  }
  return {
    schema: REGISTRY_SCHEMA,
    generatedAt,
    packages: validated.sort((a, b) => `${a.kind}:${a.id}:${a.version}`.localeCompare(`${b.kind}:${b.id}:${b.version}`)),
  };
}

export function signRegistryIndex(index, privateKeyPem, keyId) {
  assertString(keyId, "keyId");
  const payload = canonicalJson(index);
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(payload), privateKey).toString("base64url");
  return { index, signature: { algorithm: "Ed25519", keyId, value: signature } };
}

export function verifySignedRegistry(signedIndex, trustedKeys) {
  assertObject(signedIndex, "signed registry");
  assertObject(signedIndex.signature, "signature");
  const { keyId, algorithm, value } = signedIndex.signature;
  if (algorithm !== "Ed25519") return { ok: false, reason: "unsupported_signature_algorithm" };
  const publicKeyPem = trustedKeys?.[keyId];
  if (!publicKeyPem) return { ok: false, reason: "untrusted_key" };
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const ok = verify(null, Buffer.from(canonicalJson(signedIndex.index)), publicKey, Buffer.from(value, "base64url"));
    return ok ? { ok: true } : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
}

export function verifyArtifact(bytes, expectedSha256) {
  assertString(expectedSha256, "expectedSha256");
  return sha256Hex(bytes).toLowerCase() === expectedSha256.toLowerCase();
}

export function planInstall({ installed, candidate, grantedPermissions = [] }) {
  const pkg = validatePackageVersion(candidate);
  const current = installed?.[`${pkg.kind}:${pkg.id}`] ?? null;
  const requested = new Set(pkg.permissions ?? []);
  const granted = new Set(grantedPermissions);
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

export function createRollbackRecord(previous, installed) {
  return {
    schema: "totem.registry.rollback/v0",
    packageKey: `${installed.kind}:${installed.id}`,
    fromVersion: installed.version,
    toVersion: previous?.version ?? null,
    previous: previous ?? null,
    installed,
  };
}

export function applyRollback(record) {
  assertObject(record, "rollback record");
  if (record.schema !== "totem.registry.rollback/v0") throw new TypeError("unsupported rollback schema");
  return record.previous;
}
