import { createPrivateKey, createPublicKey } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  createRegistryIndex,
  createRollbackRecord,
  planInstall,
  sha256Hex,
  signRegistryIndex,
  verifySignedRegistry,
} from "../src/registry.js";

// RFC 8032 Ed25519 test-vector seed. This is public, deterministic test material only.
const TEST_SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const PRIVATE_KEY = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, TEST_SEED]), format: "der", type: "pkcs8" });
const PUBLIC_KEY = createPublicKey(PRIVATE_KEY);
const KEY_ID = "totem-registry-test-rfc8032-1";

export function buildTrustFixture() {
  const artifact = Buffer.from("totem-registry deterministic fixture artifact\n", "utf8");
  const packages = [
    {
      id: "retro-terminal",
      kind: "theme",
      version: "1.2.0",
      source: "https://example.invalid/themes/retro-terminal-1.2.0.tgz",
      sha256: sha256Hex(artifact),
      compatibility: { totem: ">=0.1.0" },
      permissions: [],
    },
    {
      id: "weather",
      kind: "extension",
      version: "0.2.0",
      source: "https://example.invalid/extensions/weather-0.2.0.tgz",
      sha256: sha256Hex(artifact),
      compatibility: { totem: ">=0.1.0" },
      permissions: ["network.http"],
    },
  ];
  const index = createRegistryIndex({ generatedAt: "2026-09-07T00:00:00Z", packages });
  const privateKeyPem = PRIVATE_KEY.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = PUBLIC_KEY.export({ type: "spki", format: "pem" });
  const signed = signRegistryIndex(index, privateKeyPem, KEY_ID);
  const verification = verifySignedRegistry(signed, { [KEY_ID]: publicKeyPem });
  if (!verification.ok) throw new Error(`deterministic fixture signature failed: ${verification.reason}`);

  const installPlan = planInstall({
    installed: { "extension:weather": { id: "weather", kind: "extension", version: "0.1.0" } },
    candidate: index.packages.find((pkg) => pkg.id === "weather"),
    grantedPermissions: [],
  });
  const rollback = createRollbackRecord(
    { id: "weather", kind: "extension", version: "0.1.0" },
    { id: "weather", kind: "extension", version: "0.2.0" },
  );
  const canonicalIndex = canonicalJson(index);

  return {
    schema: "totem.registry-trust-fixture/v1",
    keyId: KEY_ID,
    publicKeyPem,
    canonicalIndex,
    canonicalIndexSha256: sha256Hex(Buffer.from(canonicalIndex)),
    signed,
    installPlan,
    rollback,
  };
}

export function serializeTrustFixture() {
  return `${canonicalJson(buildTrustFixture())}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(serializeTrustFixture());
}
