// Builds coinvello-mcp-<version>.mcpb: an MCP Bundle (https://github.com/modelcontextprotocol/mcpb) of this server
// with its production dependencies, for one-click install in Claude Desktop and for Smithery's local-server listing.
//
//   npm run build && node scripts/build-mcpb.mjs        # -> dist-mcpb/coinvello-mcp-<version>.mcpb
//
// Tool names and titles are read from src/server.ts so the manifest never drifts from the server.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "dist-mcpb");
const stage = join(out, "stage");

const src = readFileSync(join(root, "src", "server.ts"), "utf8");
const tools = [...src.matchAll(/registerTool\(\s*"([a-z_]+)",\s*\{\s*title:\s*"([^"]+)"/g)].map(([, name, description]) => ({ name, description }));
if (tools.length < 10) throw new Error(`only ${tools.length} tools found in src/server.ts; did the registerTool format change?`);

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
cpSync(join(root, "README.md"), join(stage, "README.md"));
writeFileSync(join(stage, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, type: pkg.type, dependencies: pkg.dependencies }, null, 2));
execSync("npm install --omit=dev --ignore-scripts --no-audit --no-fund", { cwd: stage, stdio: "ignore" });

const manifest = {
  manifest_version: "0.3",
  name: "coinvello",
  display_name: "CoinVello",
  version: pkg.version,
  description: "Non-custodial crypto payments: checkout sessions, invoices, webhooks and test payments. No KYC.",
  long_description:
    "Create hosted checkout sessions and invoices priced in fiat or crypto, list payments, register and verify webhooks, check credits and rates, export records and simulate test payments. Payments go straight to the merchant's own wallet on 11 networks. Nothing in the server can move funds; live keys are refused unless COINVELLO_ALLOW_LIVE=1.",
  author: { name: "CoinVello", email: "support@coinvello.com", url: "https://coinvello.com" },
  homepage: "https://coinvello.com/ai",
  documentation: "https://coinvello.com/llms-full.txt",
  support: "https://github.com/CoinVello/coinvello-ai/issues",
  repository: { type: "git", url: "https://github.com/CoinVello/coinvello-ai" },
  license: "MIT",
  keywords: ["payments", "crypto", "stablecoins", "usdc", "webhooks", "checkout"],
  server: {
    type: "node",
    entry_point: "dist/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/index.js"],
      env: { COINVELLO_API_KEY: "${user_config.api_key}", COINVELLO_API_BASE: "${user_config.api_base}" },
    },
  },
  user_config: {
    api_key: { type: "string", title: "CoinVello API key", description: "A cv_test_ key from https://coinvello.com/app/settings.php while developing. Live keys are refused.", sensitive: true, required: true },
    api_base: { type: "string", title: "API base URL", description: "Leave as is, or use http://localhost:4242/v1 for the local mock server.", default: "https://api.coinvello.com/v1", required: false },
  },
  tools,
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=18.0.0" } },
};
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const file = join(out, `coinvello-mcp-${pkg.version}.mcpb`);
execSync(`npx -y @anthropic-ai/mcpb pack "${stage}" "${file}"`, { cwd: root, stdio: "inherit" });
console.log(`${tools.length} tools -> ${file}`);
