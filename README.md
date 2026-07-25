# datadog-mcp

Datadog MCP server built from the skeleton architecture with:
- Vault-backed persistent secrets
- Postgres-backed persistent configuration
- Multi-user token and credential scoping
- Full Datadog API coverage through generated operation catalog and dynamic invocation

## Solution Summary

This repository implements a production-oriented MCP server dedicated to Datadog.

Design guarantees:
- All Datadog credentials and MCP HTTP tokens are stored in Vault.
- All non-secret runtime configuration is stored in Postgres.
- All operations are user-scoped (`app + user`) with deterministic path/table mapping.
- Mutating operations can be protected with `MCP_ADMIN_AUTH_KEY`.

Coverage strategy:
- `scripts/generate-datadog-operation-catalog.js` scans the official `@datadog/datadog-api-client` SDK.
- The generated catalog in `src/data/datadog-operation-catalog.json` currently includes 1603 operations across Datadog `v1` and `v2`.
- `datadog_invoke_operation` exposes all operations via `operationId`.

## Core Architecture

Runtime bootstrap:
- `src/bootstrap.js`: constructs `ConfigStore`, `VaultService`, Datadog catalog index, and `DatadogService`.
- `src/index.js`: stdio transport bootstrap.
- `src/http/index.js`: HTTP transport bootstrap with token/OAuth2 auth middleware.

Service layer:
- `src/services/datadogService.js`: credential lifecycle, user config persistence, operation invocation.
- `src/services/datadogApiCatalog.js`: loads and indexes generated Datadog operation metadata.
- `src/services/configStore.js`: Postgres persistence.
- `src/services/vault.js`: Vault persistence.

MCP tools:
- `src/mcp/server.js`: all Datadog, token, and configuration tools with explicit LLM-facing tool guidance.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Copy environment file and adjust values:

```bash
cp .env.example .env
```

3. Start local dependencies and HTTP MCP server:

```bash
docker compose up -d postgres vault
npm run start:http
```

4. Optional stdio mode:

```bash
npm run start:stdio
```

## Persistence Model

### Secrets in Vault

Stored under app/user scope:
- Datadog credentials: `APP_NAME/users/<user>/datadog/credentials`
- User token index: `APP_NAME/users/<user>/http/auth/token-index`
- Global HTTP verifier token index: `MCP_HTTP_VAULT_TOKEN_INDEX_PATH`

### Configuration in Postgres

Table:
- `<app_name>_config`

Primary key:
- `(user_id, key)`

Typical keys:
- `datadog.site`
- `datadog.timeoutMs`

## Tool Catalog

All tools return JSON via MCP text content:
- Success: `{ ok: true, status, data }`
- Failure: `{ ok: false, status, error }` with `isError=true`

### Read-Only Tools

- `datadog_connection_info`
- `datadog_scope_info`
- `datadog_list_operations`
- `datadog_get_operation`
- `datadog_get_user_credential_metadata`
- `datadog_validate_user_credentials`
- `datadog_list_user_configs`
- `datadog_get_user_config`

### Mutating Tools

- `datadog_upsert_user_credentials`
- `datadog_delete_user_credentials`
- `datadog_set_user_config`
- `datadog_delete_user_config`
- `datadog_create_or_update_user_token`
- `datadog_revoke_user_token`
- `datadog_invoke_operation` (mutating only when target endpoint is mutating)

### Tool Definition Quality (LLM-Facing)

Every tool description in `src/mcp/server.js` includes:
- When the tool should and should not be used
- Whether it is read-only, mutating, or high-risk
- Required permissions and prerequisites
- Environment-selection behavior
- Parameter formats and constraints
- Expected response shape
- Common failure conditions
- Recommended prerequisite and follow-up tools
- Safety warnings for destructive operations
- Short valid invocation examples

## MCP_ADMIN_AUTH_KEY Behavior

If `MCP_ADMIN_AUTH_KEY` is set:
- All mutating credential/config/token tools require `authorizationKey`.
- `datadog_invoke_operation` requires `authorizationKey` only when the selected Datadog operation is mutating (`POST|PUT|PATCH|DELETE`).

## HTTP Auth Options

Configured through:
- `MCP_HTTP_AUTH_MODE`: `token | oauth2 | both`
- `MCP_HTTP_TOKEN_SOURCE`: `static | vault`

Token source behavior:
- `static`: validates against `MCP_HTTP_AUTH_TOKENS`
- `vault`: validates against Vault index path `MCP_HTTP_VAULT_TOKEN_INDEX_PATH`

OAuth2 behavior:
- Introspection based verifier with optional scope and audience enforcement.

## Operation Coverage Generation

Regenerate catalog after upgrading Datadog SDK:

```bash
npm run catalog:generate
```

## Scripts

- `npm run start:stdio`
- `npm run start:http`
- `npm run start:both`
- `npm run catalog:generate`
- `npm test`
- `npm run vault:seed-http-token`
- `npm run vault:seed-oauth-token`

## External Services Mode

Use `docker-compose.external.yml` when Postgres and Vault are managed externally.
Only the app container is started in this mode.

## Testing

Run:

```bash
npm test
```

Coverage includes:
- Datadog catalog integrity and known operation resolution.
- MCP tool auth-gating and mutating safety behavior.
- HTTP auth/transport behavior.
- External configuration/documentation alignment checks.
