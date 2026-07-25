# Changelog

## 0.1.0

- Initialized Datadog MCP implementation from skeleton architecture.
- Added full Datadog API coverage through generated operation catalog (v1 + v2).
- Added user-scoped Vault credential management and MCP token lifecycle tools.
- Added Postgres-backed user-scoped configuration tools.
- Added `MCP_ADMIN_AUTH_KEY` enforcement on mutating operations.
- Updated HTTP auth bootstrap for static tokens, Vault-backed token verifier, and OAuth2 introspection.
- Rewrote solution documentation and added Datadog-specific tests.
