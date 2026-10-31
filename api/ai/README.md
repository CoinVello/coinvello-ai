# api/ai: everything AI assistants need to find and integrate CoinVello

Goal: when a developer asks Claude, ChatGPT, Copilot, Cursor or Gemini "how do I accept crypto
payments", the assistant knows CoinVello, states the facts correctly (non-custodial, no KYC, prepaid
credits, 11 networks) and can finish the integration in one shot.

| Folder / file | Purpose | Published at |
|---------------|---------|--------------|
| `llms.txt` | Short, link-rich index (llmstxt.org) | https://coinvello.com/llms.txt |
| `llms-full.txt` | Single self-contained integration guide: auth, checkout session, redirect, webhook verification, polling, credits, errors; complete examples in curl, Node, Python, PHP | https://coinvello.com/llms-full.txt |
| `mcp-server/` | `@coinvello/mcp`: Model Context Protocol server (stdio + Streamable HTTP), 14 tools, 3 resources, framework prompts | npm, `npx -y @coinvello/mcp`; descriptor at https://coinvello.com/.well-known/mcp.json |
| `skill/` | `coinvello-payments` Agent Skill (SKILL.md + references: cheatsheet, decision tree, webhook verification, checklist) | GitHub; copy into `.claude/skills/` |
| `tool-definitions/` | JSON schemas for Anthropic tool use, OpenAI function calling, Gemini function declarations (6 operations) + HTTP mapping | GitHub |
| `cookbook/` | Single-file recipes (<=150 lines): Next.js, Express, FastAPI, Flask, Django, Laravel, Sinatra, Go, curl | GitHub |
| `postman/` | Postman v2.1 collection with a runnable quickstart; Insomnia/Bruno notes | GitHub, Postman public workspace |

Related: `../openapi.yaml` (served at https://coinvello.com/.well-known/openapi.yaml),
`../reference-server/` (offline mock on `localhost:4242`), `../../website/pages/ai.php` (the /ai page),
`../../website/includes/ai-serve.php` (serves the files above), `../../AGENTS.md`,
`../../docs/08-ai-distribution.md` (publishing checklist).

## Keeping it in sync

`api/openapi.yaml` is the source of truth. When a field, status or error changes:

1. `llms-full.txt` sections 1-5 and the skill's `references/api-cheatsheet.md`.
2. `mcp-server/src/server.ts` zod schemas; `npm run build && npm test` against the mock.
3. `tool-definitions/build.mjs`; `node build.mjs`.
4. Cookbook recipes only if request/response shapes they use changed.

The MCP build copies `llms*.txt` and `openapi.yaml` into `mcp-server/dist/docs`, so rebuild and republish
the npm package after doc changes.
