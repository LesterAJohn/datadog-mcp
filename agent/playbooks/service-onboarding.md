# Datadog Service Onboarding Playbook

## Goal

Add new Datadog-facing capabilities without breaking persistence, auth, or scope guarantees.

## Required Checks

1. Do not store secrets in Postgres.
2. Do not store non-secret configuration in Vault.
3. Preserve user-scoped storage paths and keys.
4. For mutating behavior, gate with `MCP_ADMIN_AUTH_KEY`.
5. If SDK version changes, regenerate operation catalog.

## Steps

1. Update `@datadog/datadog-api-client` version if required.
2. Run `npm run catalog:generate`.
3. Verify `src/data/datadog-operation-catalog.json` has expected operation volume.
4. Update `src/mcp/server.js` tool descriptions for LLM guidance.
5. Add/adjust tests under `tests/`.
6. Run `npm test`.

## External Deployment Mode

When deploying against external dependencies:
- Use `docker-compose.external.yml`.
- Ensure `POSTGRES_*` and `VAULT_*` env vars are provided.
