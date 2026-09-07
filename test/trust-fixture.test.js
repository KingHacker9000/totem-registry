import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256Hex, verifySignedRegistry } from "../src/registry.js";
import { buildTrustFixture, serializeTrustFixture } from "../tools/trust-fixture.js";

test("trust fixture is byte-identical across repeated generation", () => {
  const first = serializeTrustFixture();
  const second = serializeTrustFixture();
  assert.equal(first, second);
  assert.equal(first.endsWith("\n"), true);
});

test("trust fixture binds canonical index digest, deterministic signature, install plan and rollback", () => {
  const fixture = buildTrustFixture();
  assert.equal(fixture.schema, "totem.registry-trust-fixture/v1");
  assert.equal(
    fixture.canonicalIndexSha256,
    sha256Hex(Buffer.from(fixture.canonicalIndex)),
  );
  assert.equal(fixture.canonicalIndex, canonicalJson(fixture.signed.index));
  assert.deepEqual(
    fixture.signed.index.packages.map((pkg) => `${pkg.kind}:${pkg.id}:${pkg.version}`),
    ["extension:weather:0.2.0", "theme:retro-terminal:1.2.0"],
  );
  assert.deepEqual(verifySignedRegistry(fixture.signed, { [fixture.keyId]: fixture.publicKeyPem }), { ok: true });
  assert.equal(fixture.installPlan.autoGrant, false);
  assert.deepEqual(fixture.installPlan.missingPermissions, ["network.http"]);
  assert.equal(fixture.rollback.fromVersion, "0.2.0");
  assert.equal(fixture.rollback.toVersion, "0.1.0");
});

test("tampering with canonical signed metadata fails closed", () => {
  const fixture = buildTrustFixture();
  const tampered = structuredClone(fixture.signed);
  tampered.index.packages[0].version = "9.9.9";
  assert.deepEqual(
    verifySignedRegistry(tampered, { [fixture.keyId]: fixture.publicKeyPem }),
    { ok: false, reason: "invalid_signature" },
  );
});
