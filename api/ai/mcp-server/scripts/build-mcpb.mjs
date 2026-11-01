// Builds coinvello-mcp-<version>.mcpb: an MCP Bundle (https://github.com/modelcontextprotocol/mcpb) of this server
// with its production dependencies, for one-click install in Claude Desktop and for Smithery's local-server listing.
//
//   npm run build && node scripts/build-mcpb.mjs        # -> dist-mcpb/coinvello-mcp-<version>.mcpb
//
// Tools (with input schemas) are read from the built server itself, so the manifest never drifts from it.
import { execSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "dist-mcpb");
const stage = join(out, "stage");

// Ask the built server for its tool list (name, description, inputSchema), as an MCP client would; Smithery
// requires each tool's inputSchema in the manifest.
const tools = await new Promise((done, fail) => {
  const child = spawn(process.execPath, [join(root, "dist", "index.js")], { env: { ...process.env, COINVELLO_API_KEY: "cv_test_manifest" }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (const line of buf.split("\n").slice(0, -1)) {
      const msg = JSON.parse(line);
      if (msg.id === 2) {
        child.kill();
        done(msg.result.tools.map((t) => ({ name: t.name, description: t.title ?? t.description, inputSchema: t.inputSchema })));
      }
    }
    buf = buf.slice(buf.lastIndexOf("\n") + 1);
  });
  child.on("error", fail);
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build-mcpb", version: "1" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  setTimeout(() => { child.kill(); fail(new Error("server did not answer tools/list")); }, 15000);
});
if (tools.length < 10) throw new Error(`only ${tools.length} tools listed by the server`);

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
  tools: tools.map(({ name, description }) => ({ name, description })),
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=18.0.0" } },
};
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const file = join(out, `coinvello-mcp-${pkg.version}.mcpb`);
execSync(`npx -y @anthropic-ai/mcpb pack "${stage}" "${file}"`, { cwd: root, stdio: "inherit" });
console.log(`${tools.length} tools -> ${file}`);

// Smithery's bundle upload also wants each tool's inputSchema, which the MCPB 0.3 schema (and `mcpb pack`) rejects,
// so the Smithery copy is the same bundle with a richer manifest, zipped by Python's zipfile.
writeFileSync(join(stage, "manifest.json"), JSON.stringify({ ...manifest, tools }, null, 2) + "\n");
const smithery = join(out, `coinvello-mcp-${pkg.version}-smithery.mcpb`);
execSync(`python -c "import os,sys,zipfile; s,o=sys.argv[1],sys.argv[2]; z=zipfile.ZipFile(o,'w',zipfile.ZIP_DEFLATED); [z.write(os.path.join(d,f), os.path.relpath(os.path.join(d,f), s).replace(os.sep,'/')) for d,_,fs in os.walk(s) for f in fs]; z.close()" "${stage}" "${smithery}"`);
console.log(`Smithery copy -> ${smithery}`);
