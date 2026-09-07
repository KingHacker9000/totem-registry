import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SOURCE_INTEGRITY_SCHEMA = "totem.registry-source-integrity/v1";

const EXPECTED_SOURCE_PATHS = [
  "src/node-agent.js",
  "src/node-protocol.js",
  "src/registry.js",
];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_FORBIDDEN = /[<>:"\\|?*]/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertPortableRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath === "") {
    throw new TypeError("source path must be a non-empty string");
  }
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new TypeError(`absolute source path is forbidden: ${relativePath}`);
  }
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`non-canonical source path is forbidden: ${relativePath}`);
  }
  for (const segment of segments) {
    if (CONTROL_CHARACTERS.test(segment) || WINDOWS_FORBIDDEN.test(segment)) {
      throw new TypeError(`platform-unsafe source path is forbidden: ${relativePath}`);
    }
    if (segment.endsWith(".") || segment.endsWith(" ") || WINDOWS_RESERVED.test(segment)) {
      throw new TypeError(`platform-unsafe source path is forbidden: ${relativePath}`);
    }
  }
  if (normalized !== normalized.normalize("NFC")) {
    throw new TypeError(`non-NFC source path is forbidden: ${relativePath}`);
  }
  return normalized;
}

async function walkFiles(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = assertPortableRelativePath(
      path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name),
    );
    const absolutePath = path.join(root, relativePath);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new TypeError(`symlinked source entry is forbidden: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      files.push(...(await walkFiles(root, relativePath)));
      continue;
    }
    if (!stat.isFile()) {
      throw new TypeError(`special source entry is forbidden: ${relativePath}`);
    }
    files.push(relativePath);
  }
  return files;
}

function assertNoPortableCollisions(paths) {
  const seen = new Map();
  for (const relativePath of paths) {
    const key = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = seen.get(key);
    if (previous && previous !== relativePath) {
      throw new TypeError(`portable source path collision: ${previous} vs ${relativePath}`);
    }
    seen.set(key, relativePath);
  }
}

export async function generateSourceInventory(root = process.cwd()) {
  const repositoryRoot = await realpath(root);
  const sourceRoot = path.join(repositoryRoot, "src");
  const sourceStat = await lstat(sourceRoot).catch(() => null);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new TypeError("src must be a real directory");
  }
  const resolvedSourceRoot = await realpath(sourceRoot);
  if (!resolvedSourceRoot.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new TypeError("src escapes repository root");
  }

  const packagePath = path.join(repositoryRoot, "package.json");
  const packageStat = await lstat(packagePath).catch(() => null);
  if (!packageStat?.isFile() || packageStat.isSymbolicLink()) {
    throw new TypeError("package.json must be a regular file");
  }
  const packageBytes = await readFile(packagePath);
  const packageJson = JSON.parse(packageBytes.toString("utf8"));
  if (packageJson.name !== "@totem/registry") throw new TypeError("unexpected package identity");
  if (packageJson.private !== true) throw new TypeError("registry package must remain private");
  if (packageJson.type !== "module") throw new TypeError("registry package must remain ESM");

  const discovered = (await walkFiles(repositoryRoot, "src")).sort((a, b) => a.localeCompare(b, "en"));
  assertNoPortableCollisions(discovered);
  if (JSON.stringify(discovered) !== JSON.stringify(EXPECTED_SOURCE_PATHS)) {
    throw new TypeError(`unexpected registry source surface: ${discovered.join(", ")}`);
  }

  const inventoryPaths = ["package.json", ...discovered];
  const files = [];
  for (const relativePath of inventoryPaths) {
    const bytes = await readFile(path.join(repositoryRoot, relativePath));
    files.push({
      path: relativePath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }

  const canonical = files
    .map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`)
    .join("");
  return {
    schema: SOURCE_INTEGRITY_SCHEMA,
    package: packageJson.name,
    version: packageJson.version,
    private: true,
    files,
    aggregate_sha256: sha256(canonical),
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const inventory = await generateSourceInventory();
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  } catch (error) {
    console.error(`source-integrity: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
