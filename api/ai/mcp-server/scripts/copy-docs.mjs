// Copies the documents served as MCP resources into dist/docs so the published npm package is
// self-contained. Sources live elsewhere in the monorepo; when they are missing (e.g. building from a
// tarball) the server falls back to fetching them from coinvello.com at runtime.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(root, "dist", "docs");
mkdirSync(out, { recursive: true });

const sources = [
  [resolve(root, "..", "llms-full.txt"), resolve(out, "llms-full.txt")],
  [resolve(root, "..", "llms.txt"), resolve(out, "llms.txt")],
  [resolve(root, "..", "..", "openapi.yaml"), resolve(out, "openapi.yaml")],
];

for (const [from, to] of sources) {
  if (existsSync(from)) {
    copyFileSync(from, to);
    console.log(`copied ${from} -> ${to}`);
  } else {
    console.warn(`missing ${from} (will be fetched from coinvello.com at runtime)`);
  }
}
