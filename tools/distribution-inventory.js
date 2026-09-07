import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_FILES = Object.freeze([
  "package.json",
  "src/node-agent.js",
  "src/node-protocol.js",
  "src/registry.js",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) {
    throw new Error(`unsafe path: ${String(value)}`);
  }
  if (path.posix.isAbsolute(value) || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`unsafe path: ${value}`);
  }
  if (value !== value.normalize("NFC")) throw new Error(`non-NFC path: ${value}`);
}

async function collectTree(root, relative = "") {
  const absolute = path.join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    assertSafeRelativePath(rel);
    const stat = await lstat(path.join(root, rel));
    if (stat.isSymbolicLink()) throw new Error(`symlink not allowed: ${rel}`);
    if (stat.isDirectory()) files.push(...(await collectTree(root, rel)));
    else if (stat.isFile()) files.push(rel);
    else throw new Error(`special file not allowed: ${rel}`);
  }
  return files;
}

export async function buildDistributionInventory(root = path.resolve(fileURLToPath(new URL("..", import.meta.url)))) {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (packageJson.name !== "@totem/registry" || packageJson.version !== "0.1.0" || packageJson.type !== "module") {
    throw new Error("unexpected package identity");
  }

  const srcFiles = (await collectTree(path.join(root, "src"))).map((item) => `src/${item}`);
  const actual = ["package.json", ...srcFiles].sort();
  const expected = [...EXPECTED_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected distribution surface: ${actual.join(",")}`);
  }

  const collisionKeys = new Set();
  const files = [];
  for (const rel of actual) {
    assertSafeRelativePath(rel);
    const collisionKey = rel.normalize("NFC").toLocaleLowerCase("en-US");
    if (collisionKeys.has(collisionKey)) throw new Error(`case/unicode path collision: ${rel}`);
    collisionKeys.add(collisionKey);
    const stat = await lstat(path.join(root, rel));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`regular file required: ${rel}`);
    const bytes = await readFile(path.join(root, rel));
    files.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
  }

  const aggregateInput = `${files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n")}\n`;
  return {
    schema: "totem.registry-distribution/v1",
    package: { name: packageJson.name, version: packageJson.version, type: packageJson.type },
    files,
    aggregateSha256: sha256(Buffer.from(aggregateInput, "utf8")),
  };
}

export async function serializeDistributionInventory(root) {
  return `${JSON.stringify(await buildDistributionInventory(root), null, 2)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(await serializeDistributionInventory(process.cwd()));
}
