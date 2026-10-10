# Security Policy

## Reporting a vulnerability

Please email **founder@dolseom.com** with the details. Do not open a public issue for security problems.

We aim to reply within 3 business days.

## Scope

gongsi-mcp runs locally as an MCP server. It sends no telemetry and contacts only public government APIs (OpenDART, data.go.kr) when a question needs them. API keys are stored only on the user's machine (`~/.gongsi-mcp/.env`).

## Supported versions

Only the latest release on npm receives fixes.