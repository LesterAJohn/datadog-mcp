import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = process.cwd();

const externalComposePath = path.join(rootDir, "docker-compose.external.yml");
const readmePath = path.join(rootDir, "README.md");
const envExamplePath = path.join(rootDir, ".env.example");

test("external services compose file exists and targets external Vault/Postgres", () => {
  const compose = fs.readFileSync(externalComposePath, "utf8");

  assert.match(compose, /mcp-http:/);
  assert.match(compose, /datadog-mcp-http/);
  assert.match(compose, /POSTGRES_HOST: \$\{POSTGRES_HOST:\?set POSTGRES_HOST for external Postgres\}/);
  assert.match(compose, /VAULT_ADDR: \$\{VAULT_ADDR:\?set VAULT_ADDR for external Vault\}/);
  assert.doesNotMatch(compose, /postgres:/);
  assert.doesNotMatch(compose, /vault:/);
});

test("env example includes Datadog and Vault/Postgres persistence keys", () => {
  const envExample = fs.readFileSync(envExamplePath, "utf8");

  assert.match(envExample, /APP_NAME=datadog-mcp/);
  assert.match(envExample, /DATADOG_SITE=datadoghq.com/);
  assert.match(envExample, /MCP_HTTP_VAULT_TOKEN_INDEX_PATH=datadog-mcp\/http\/auth\/token-index/);
});

test("README documents full Datadog operation coverage and persistence model", () => {
  const readme = fs.readFileSync(readmePath, "utf8");

  assert.match(readme, /Datadog MCP/);
  assert.match(readme, /Vault-backed persistent secrets/);
  assert.match(readme, /Postgres-backed persistent configuration/);
  assert.match(readme, /datadog_invoke_operation/);
  assert.match(readme, /Full Datadog API coverage/i);
});
