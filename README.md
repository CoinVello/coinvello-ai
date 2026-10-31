# CoinVello AI kit

Everything an AI assistant or agent needs to integrate [CoinVello](https://coinvello.com), the
non-custodial crypto payment processor: payments go straight to the merchant's own wallet, no KYC,
fees are prepaid credits or a fixed on-chain split.

| Path | What |
|------|------|
| [`api/ai/mcp-server`](api/ai/mcp-server) | MCP server, `npx -y @coinvello/mcp` ([npm](https://www.npmjs.com/package/@coinvello/mcp), [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.CoinVello/coinvello): `io.github.CoinVello/coinvello`) |
| [`api/ai/llms-full.txt`](api/ai/llms-full.txt) | The whole integration guide in one file (also at https://coinvello.com/llms-full.txt) |
| [`api/ai/skill`](api/ai/skill) | `coinvello-payments` Agent Skill: drop it into `.claude/skills/` |
| [`api/ai/cookbook`](api/ai/cookbook) | Single-file recipes: Next.js, Express, FastAPI, Flask, Django, Laravel, Sinatra, Go, curl |
| [`api/ai/tool-definitions`](api/ai/tool-definitions) | Tool schemas for Anthropic, OpenAI and Gemini function calling |
| [`api/ai/postman`](api/ai/postman) | Postman collection with a runnable quickstart |
| [`api/reference-server`](api/reference-server) | Mock API: `npm start`, then use `http://localhost:4242/v1` with any `cv_test_` key; signs real webhooks |
| [`api/openapi.yaml`](api/openapi.yaml) | OpenAPI 3.1 reference for `https://api.coinvello.com/v1` |

SDKs: `npm install @coinvello/sdk`; Python and PHP install commands are on https://coinvello.com/developers.

This repository is a read-only mirror, synced from CoinVello's main repository. Issues are welcome;
security reports go to security@coinvello.com.
