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
  verifyArtifact,
  verifySignedRegistry,
} from "../src/registry.js";

test("registry index signs and verifies with an explicitly trusted Ed25519 key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const artifact = Buffer.from("totem-extension");
  const index = createRegistryIndex({
    generatedAt: "2026-09-06T12:00:00Z",
    packages: [
      {
        id: "weather",
        kind: "extension",
        version: "0.2.0",
        source: "https://example.invalid/weather.tgz",
        sha256: sha256Hex(artifact),
        compatibility: { totem: ">=0.1.0" },
        permissions: ["network.http"],
      },
    ],
  });
  const signed = signRegistryIndex(index, privateKey.export({ type: "pkcs8", format: "pem" }), "release-1");
  const trusted = { "release-1": publicKey.export({ type: "spki", format: "pem" }) };
  assert.deepEqual(verifySignedRegistry(signed, trusted), { ok: true });
  assert.deepEqual(verifySignedRegistry(signed, {}), { ok: false, reason: "untrusted_key" });
  signed.index.packages[0].version = "9.9.9";
  assert.deepEqual(verifySignedRegistry(signed, trusted), { ok: false, reason: "invalid_signature" });
});

test("artifact integrity and install planning never auto-grant permissions", () => {
  const bytes = Buffer.from("package bytes");
  assert.equal(verifyArtifact(bytes, sha256Hex(bytes)), true);
  assert.equal(verifyArtifact(Buffer.from("tampered"), sha256Hex(bytes)), false);
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
});

test("rollback records restore the exact previous package metadata", () => {
  const previous = { id: "clock", kind: "extension", version: "1.0.0" };
  const installed = { id: "clock", kind: "extension", version: "1.1.0" };
  const record = createRollbackRecord(previous, installed);
  assert.equal(record.fromVersion, "1.1.0");
  assert.equal(record.toVersion, "1.0.0");
  assert.deepEqual(applyRollback(record), previous);
});
