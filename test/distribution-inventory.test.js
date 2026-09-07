import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDistributionInventory,
  serializeDistributionInventory,
} from "../tools/distribution-inventory.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function withFixture(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "totem-registry-inventory-"));
  const root = path.join(parent, "repo");
  await cp(path.join(REPO_ROOT, "src"), path.join(root, "src"), { recursive: true });
  await cp(path.join(REPO_ROOT, "package.json"), path.join(root, "package.json"));
  try {
    await run(root);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("distribution inventory is byte-identical and binds package/source identity", async () => {
  const first = await serializeDistributionInventory(REPO_ROOT);
  const second = await serializeDistributionInventory(REPO_ROOT);
  assert.equal(first, second);

  const inventory = JSON.parse(first);
  assert.equal(inventory.schema, "totem.registry-distribution/v1");
  assert.deepEqual(inventory.package, { name: "@totem/registry", version: "0.1.0", type: "module" });
  assert.deepEqual(
    inventory.files.map((file) => file.path),
    ["package.json", "src/node-agent.js", "src/node-protocol.js", "src/registry.js"],
  );
  assert.match(inventory.aggregateSha256, /^[0-9a-f]{64}$/);
  for (const file of inventory.files) {
    assert.equal(Number.isInteger(file.size) && file.size > 0, true);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
});

test("unexpected executable source fails closed", async () => {
  await withFixture(async (root) => {
    await writeFile(path.join(root, "src", "surprise.js"), "export default 1;\n");
    await assert.rejects(() => buildDistributionInventory(root), /unexpected distribution surface/);
  });
});

test("package identity drift fails closed", async () => {
  await withFixture(async (root) => {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "not-totem", version: "0.1.0", type: "module" }));
    await assert.rejects(() => buildDistributionInventory(root), /unexpected package identity/);
  });
});

test("symlinked executable source fails closed", { skip: process.platform === "win32" }, async () => {
  await withFixture(async (root) => {
    const target = path.join(root, "src", "registry.js");
    await rm(target);
    await symlink(path.join(REPO_ROOT, "src", "registry.js"), target);
    await assert.rejects(() => buildDistributionInventory(root), /symlink not allowed|regular file required/);
  });
});
