# datadog-mcp Agent Notes

This repository is a Datadog-specific MCP implementation derived from skeleton patterns.

Guardrails:
- Keep Vault for secrets and Postgres for configuration.
- Maintain user-scoped token and credential behavior.
- Preserve and document `MCP_ADMIN_AUTH_KEY` protections for mutating operations.
- Keep Datadog API coverage complete by regenerating the operation catalog when SDK changes.
