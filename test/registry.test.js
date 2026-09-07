import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  applyRollback,
  createRegistryIndex,
  createRollbackRecord,
  planInstall,
  sha256Hex,
  signRegistryIndex,
  validatePackageVersion,
  validateRegistryIndex,
  validateRollbackRecord,
  verifyArtifact,
  verifySignedRegistry,
} from "../src/registry.js";

function packageFixture(overrides = {}) {
  return {
    id: "weather",
    kind: "extension",
    version: "0.2.0",
    source: "https://example.invalid/weather.tgz",
    sha256: sha256Hex(Buffer.from("totem-extension")),
    compatibility: { totem: ">=0.1.0" },
    permissions: ["network.http"],
    ...overrides,
  };
}

function rollbackPackageFixture(version) {
  return {
    id: "clock",
    kind: "extension",
    version,
    source: `https://example.invalid/clock-${version}.tgz`,
    sha256: sha256Hex(Buffer.from(`clock-${version}`)),
    compatibility: { totem: ">=0.1.0" },
    permissions: ["clock.read"],
  };
}

test("registry index signs and verifies with an explicitly trusted Ed25519 key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const index = createRegistryIndex({
    generatedAt: "2026-09-06T12:00:00Z",
    packages: [packageFixture()],
  });
  const signed = signRegistryIndex(index, privateKey.export({ type: "pkcs8", format: "pem" }), "release-1");
  const trusted = { "release-1": publicKey.export({ type: "spki", format: "pem" }) };
  assert.deepEqual(verifySignedRegistry(signed, trusted), { ok: true });
  assert.deepEqual(verifySignedRegistry(signed, {}), { ok: false, reason: "untrusted_key" });
  const tampered = structuredClone(signed);
  tampered.index.packages[0].version = "9.9.9";
  assert.deepEqual(verifySignedRegistry(tampered, trusted), { ok: false, reason: "invalid_signature" });
});

test("registry semantic validation rejects ambiguous package and index metadata", () => {
  assert.throws(
    () => createRegistryIndex({ generatedAt: "yesterday", packages: [packageFixture()] }),
    /RFC 3339 UTC timestamp/,
  );
  assert.throws(
    () => createRegistryIndex({ generatedAt: "2026-09-06T12:00:00+00:00", packages: [packageFixture()] }),
    /RFC 3339 UTC timestamp/,
  );
  assert.throws(() => validatePackageVersion(packageFixture({ source: "file:///tmp/weather.tgz" })), /absolute HTTPS URL/);
  assert.throws(
    () => validatePackageVersion(packageFixture({ source: "https://user:secret@example.invalid/weather.tgz" })),
    /without credentials/,
  );
  assert.throws(() => validatePackageVersion(packageFixture({ permissions: ["network.http", ""] })), /non-empty string/);
  assert.throws(
    () => validatePackageVersion(packageFixture({ permissions: ["network.http", "network.http"] })),
    /duplicate permission/,
  );
  assert.throws(
    () => validatePackageVersion(packageFixture({ compatibility: { totem: ">=0.1.0", arbitrary: true } })),
    /unsupported field 'arbitrary'/,
  );
  assert.throws(() => validatePackageVersion({ ...packageFixture(), arbitrary: true }), /unsupported field 'arbitrary'/);
  assert.throws(
    () => validateRegistryIndex({ schema: "totem.registry/v0", generatedAt: "2026-09-06T12:00:00Z", packages: "nope" }),
    /packages must be an array/,
  );
});

test("validated registry metadata is copied, normalized, frozen, and deterministic", () => {
  const candidate = packageFixture({ sha256: "A".repeat(64), permissions: ["network.http"] });
  const index = createRegistryIndex({ generatedAt: "2026-09-06T12:00:00Z", packages: [candidate] });
  assert.equal(index.packages[0].sha256, "a".repeat(64));
  assert.equal(Object.isFrozen(index), true);
  assert.equal(Object.isFrozen(index.packages), true);
  assert.equal(Object.isFrozen(index.packages[0]), true);
  assert.equal(Object.isFrozen(index.packages[0].permissions), true);
  candidate.permissions.push("mcp.register");
  assert.deepEqual(index.packages[0].permissions, ["network.http"]);
});

test("signing fails closed if callers bypass the registry-index constructor", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(
    () => signRegistryIndex({ schema: "totem.registry/v0", generatedAt: "invalid", packages: [packageFixture()] }, key, "release-1"),
    /RFC 3339 UTC timestamp/,
  );
});

test("artifact integrity and install planning never auto-grant permissions", () => {
  const bytes = Buffer.from("package bytes");
  assert.equal(verifyArtifact(bytes, sha256Hex(bytes)), true);
  assert.equal(verifyArtifact(Buffer.from("tampered"), sha256Hex(bytes)), false);
  assert.throws(() => verifyArtifact(bytes, "not-a-digest"), /64 hex characters/);
  const plan = planInstall({
    installed: {},
    candidate: {
      id: "github",
      kind: "extension",
      version: "1.0.0",
      source: "https://example.invalid/github.tgz",
      sha256: sha256Hex(bytes),
      permissions: ["network.http", "mcp.register"],
    },
    grantedPermissions: ["network.http"],
  });
  assert.equal(plan.action, "install");
  assert.equal(plan.autoGrant, false);
  assert.deepEqual(plan.missingPermissions, ["mcp.register"]);
  assert.throws(
    () => planInstall({ installed: {}, candidate: packageFixture(), grantedPermissions: ["network.http", "network.http"] }),
    /duplicate permission/,
  );
});

test("rollback records restore the exact validated previous package metadata", () => {
  const previous = rollbackPackageFixture("1.0.0");
  const installed = rollbackPackageFixture("1.1.0");
  const record = createRollbackRecord(previous, installed);
  assert.equal(record.fromVersion, "1.1.0");
  assert.equal(record.toVersion, "1.0.0");
  assert.deepEqual(applyRollback(record), previous);
  assert.equal(Object.isFrozen(record.previous.permissions), true);
});

test("rollback application fails closed on inconsistent or malformed records", () => {
  const valid = createRollbackRecord(
    { id: "clock", kind: "extension", version: "1.0.0" },
    { id: "clock", kind: "extension", version: "1.1.0" },
  );
  assert.throws(() => applyRollback({ ...valid, packageKey: "extension:other" }), /packageKey does not match/);
  assert.throws(() => applyRollback({ ...valid, fromVersion: "9.9.9" }), /fromVersion does not match/);
  assert.throws(
    () => applyRollback({ ...valid, previous: { id: "other", kind: "extension", version: "1.0.0" } }),
    /previous package identity does not match/,
  );
  assert.throws(() => applyRollback({ ...valid, toVersion: "0.9.0" }), /toVersion does not match/);
  assert.throws(() => validateRollbackRecord({ ...valid, unexpected: true }), /unsupported field 'unexpected'/);
  assert.throws(
    () => createRollbackRecord(null, { id: "clock", kind: "extension", version: "1.1.0", source: "https://example.invalid/clock.tgz" }),
    /requires source and sha256/,
  );
});
