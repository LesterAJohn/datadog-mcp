import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createBearerToken,
  createVaultTokenEntry,
  getVaultUserTokenIndexPath,
  mergeVaultTokenIndex,
  normalizeAppName,
  normalizeUserIdForPath,
  sha256Hex
} from "../config/vaultAuthTokenIndex.js";
import { redactObject } from "../services/security.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function toolDescription({
  summary,
  whenToUse,
  whenNotToUse,
  risk,
  access,
  permissions,
  environment,
  params,
  responseShape,
  failures,
  prerequisites,
  followUps,
  warning,
  example
}) {
  const lines = [
    summary,
    "",
    `When to use: ${whenToUse}`,
    `When not to use: ${whenNotToUse}`,
    `Risk classification: ${risk}`,
    `Access type: ${access}`,
    `Required permissions and prerequisites: ${permissions}`,
    `Environment selection behavior: ${environment}`,
    `Parameter formats and constraints: ${params}`,
    `Expected response shape: ${responseShape}`,
    `Common failure conditions: ${failures}`,
    `Recommended prerequisite tools: ${prerequisites}`,
    `Recommended follow-up tools: ${followUps}`,
    `Safety warning: ${warning}`,
    `Valid invocation example: ${example}`
  ];

  return lines.join("\n");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneObject(value) {
  return isObject(value) ? { ...value } : {};
}

export function createMcpServer({ name, version, env, datadogService }) {
  const server = new McpServer({
    name,
    version
  });

  const appName = normalizeAppName(env?.appName ?? process.env.APP_NAME ?? "datadog-mcp");
  const defaultUserId = String(env?.defaultUserId ?? process.env.MCP_CONFIG_DEFAULT_USER_ID ?? "default").trim() || "default";
  const adminAuthKey = String(env?.adminAuthKey ?? process.env.MCP_ADMIN_AUTH_KEY ?? "").trim();

  function getScopeModel(userId = defaultUserId) {
    const resolvedUserId = String(userId ?? defaultUserId).trim() || defaultUserId;

    return {
      appName,
      userId: resolvedUserId,
      userIdPathSegment: normalizeUserIdForPath(resolvedUserId),
      postgres: {
        tableName: `${appName.replace(/-/g, "_")}_config`,
        primaryKey: ["user_id", "key"],
        scope: "app_and_user"
      },
      vault: {
        datadogCredentialsPath: datadogService.getCredentialVaultPath(resolvedUserId),
        mcpTokenIndexPath: env.transport.http.vaultToken.indexPath,
        userTokenIndexPath: getVaultUserTokenIndexPath(appName, resolvedUserId),
        scope: "app_and_user"
      }
    };
  }

  function asText(value, { redact = false } = {}) {
    const output = redact ? redactObject(value, Boolean(env.allowSensitiveOutput)) : value;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(output, null, 2)
        }
      ]
    };
  }

  function classifyToolError(error) {
    const status = Number(error?.status ?? error?.statusCode ?? 500);
    const message = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      status: Number.isFinite(status) ? status : 500,
      error: message
    };
  }

  function withErrorHandling(handler, options = {}) {
    return async (args) => {
      try {
        const payload = await handler(args ?? {});
        return asText(payload, options);
      } catch (error) {
        return {
          ...asText(classifyToolError(error)),
          isError: true
        };
      }
    };
  }

  function assertAuthorized(authorizationKey, context) {
    if (!adminAuthKey) {
      return;
    }

    if (!authorizationKey || authorizationKey !== adminAuthKey) {
      const unauthorized = new Error(`Unauthorized: invalid authorizationKey for ${context}`);
      unauthorized.status = 401;
      throw unauthorized;
    }
  }

  async function readTokenIndex(path) {
    const payload = await datadogService.vaultService.getSecret(path);
    return isObject(payload) ? payload : {};
  }

  async function writeTokenIndex(path, payload) {
    await datadogService.vaultService.setSecret(path, payload);
    return { ok: true, path };
  }

  function parseArrayValue(value, fallback) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof value === "string" && value.trim()) {
      return value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return fallback;
  }

  const TOOL_GUIDE = [
    {
      name: "datadog_connection_info",
      category: "overview",
      summary: "Return runtime, catalog, transport, and scope metadata.",
      whenToUse: "You want a readiness snapshot before doing anything else.",
      whenNotToUse: "You need user-specific credentials or Datadog operation details.",
      params: "No parameters.",
      responseShape: "{ ok, status, data: { server, datadogCatalog, transport, scopeModel } }",
      prerequisites: "None.",
      followUps: "datadog_scope_info, datadog_list_operations, datadog_tool_recommendations."
    },
    {
      name: "datadog_scope_info",
      category: "overview",
      summary: "Return app/user scope paths for Postgres and Vault.",
      whenToUse: "You need to map a userId to persistent storage paths.",
      whenNotToUse: "You only need server-level metadata.",
      params: "userId optional non-empty string.",
      responseShape: "{ ok, status, data: scopeModel }",
      prerequisites: "datadog_connection_info.",
      followUps: "datadog_upsert_user_credentials, datadog_set_user_config."
    },
    {
      name: "datadog_list_operations",
      category: "operation discovery",
      summary: "List Datadog SDK operations from the generated catalog.",
      whenToUse: "You need to find candidate Datadog API operations.",
      whenNotToUse: "You already know the exact operationId.",
      params: "version/apiClass optional filters; mutating/unstable booleans; limit 1..500 default 200.",
      responseShape: "{ ok, status, data: { count, operations[] } }",
      prerequisites: "datadog_connection_info.",
      followUps: "datadog_get_operation, datadog_invoke_operation."
    },
    {
      name: "datadog_get_operation",
      category: "operation discovery",
      summary: "Return metadata for one Datadog operationId.",
      whenToUse: "You need the exact request shape before invocation.",
      whenNotToUse: "You need broad discovery across many APIs.",
      params: "operationId required, format version.ApiClass.methodName.",
      responseShape: "{ ok, status, data: operation }",
      prerequisites: "datadog_list_operations.",
      followUps: "datadog_invoke_operation."
    },
    {
      name: "datadog_get_user_credential_metadata",
      category: "credentials",
      summary: "Return non-secret credential state for a user.",
      whenToUse: "You need to verify whether Datadog credentials are configured.",
      whenNotToUse: "You need to create, rotate, or delete credentials.",
      params: "userId optional string; defaults to MCP_CONFIG_DEFAULT_USER_ID.",
      responseShape: "{ ok, status, data: { userId, vaultPath, configured, apiKeyConfigured, applicationKeyConfigured, site, updatedAt } }",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_upsert_user_credentials, datadog_validate_user_credentials."
    },
    {
      name: "datadog_upsert_user_credentials",
      category: "credentials",
      summary: "Create or update user-scoped Datadog API and application keys in Vault.",
      whenToUse: "You are onboarding a user or rotating Datadog secrets.",
      whenNotToUse: "You only need read-only checks or non-secret config changes.",
      params: "apiKey and applicationKey required; site optional; userId optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: { userId, site, apiKeyConfigured, applicationKeyConfigured, updatedAt } }",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_validate_user_credentials, datadog_invoke_operation."
    },
    {
      name: "datadog_delete_user_credentials",
      category: "credentials",
      summary: "Delete user-scoped Datadog credential secret from Vault.",
      whenToUse: "You are deprovisioning a user or forcing a full reset.",
      whenNotToUse: "You can rotate credentials without deleting them.",
      params: "userId optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: { userId, deleted } }",
      prerequisites: "datadog_get_user_credential_metadata.",
      followUps: "datadog_upsert_user_credentials."
    },
    {
      name: "datadog_validate_user_credentials",
      category: "credentials",
      summary: "Validate configured Datadog keys by calling the authentication endpoint.",
      whenToUse: "You want to confirm that configured Datadog credentials work.",
      whenNotToUse: "You are still creating or deleting the credentials.",
      params: "userId optional.",
      responseShape: "{ ok, status, data: invokeResult }",
      prerequisites: "datadog_upsert_user_credentials.",
      followUps: "datadog_invoke_operation."
    },
    {
      name: "datadog_list_user_configs",
      category: "config",
      summary: "List user-scoped Postgres configuration entries for this app.",
      whenToUse: "You want to inspect persisted runtime settings.",
      whenNotToUse: "You only need one known key.",
      params: "userId optional, prefix optional string filter.",
      responseShape: "{ ok, status, data: rows[] }",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_get_user_config, datadog_set_user_config."
    },
    {
      name: "datadog_get_user_config",
      category: "config",
      summary: "Get one user-scoped Postgres configuration key.",
      whenToUse: "You need the effective value of a specific config key.",
      whenNotToUse: "You need many keys; list them instead.",
      params: "key required non-empty string; userId optional.",
      responseShape: "{ ok, status, data: row|null }",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_set_user_config."
    },
    {
      name: "datadog_set_user_config",
      category: "config",
      summary: "Set or update one user-scoped Postgres configuration key.",
      whenToUse: "You need to persist runtime settings like site or timeout.",
      whenNotToUse: "You are handling secrets; use Vault-backed tools instead.",
      params: "key required; value any JSON type; userId optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: row }",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_get_user_config, datadog_invoke_operation."
    },
    {
      name: "datadog_delete_user_config",
      category: "config",
      summary: "Delete one user-scoped Postgres configuration key.",
      whenToUse: "You want to clear a key and fall back to defaults.",
      whenNotToUse: "You need to inspect current values first.",
      params: "key required; userId optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: { deleted, userId, key } }",
      prerequisites: "datadog_get_user_config.",
      followUps: "datadog_invoke_operation."
    },
    {
      name: "datadog_create_or_update_user_token",
      category: "tokens",
      summary: "Create or update a user token in Vault token indexes.",
      whenToUse: "You are provisioning or rotating MCP HTTP bearer tokens.",
      whenNotToUse: "You are managing Datadog API credentials.",
      params: "userId optional; token optional; tokenId/scopes/audience/expiresAt optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: { userId, tokenId, tokenHash, token, scopes, audience, expiresAt, indexPaths[] } }",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_revoke_user_token, datadog_connection_info."
    },
    {
      name: "datadog_revoke_user_token",
      category: "tokens",
      summary: "Revoke a user token in Vault token indexes.",
      whenToUse: "A token is compromised or must be deprovisioned.",
      whenNotToUse: "You only need a short-lived rotation path.",
      params: "token or tokenHash required; userId optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: { userId, tokenHash, revoked, indexPaths[] } }",
      prerequisites: "datadog_create_or_update_user_token.",
      followUps: "datadog_create_or_update_user_token."
    },
    {
      name: "datadog_invoke_operation",
      category: "execution",
      summary: "Invoke any Datadog SDK operation from the generated catalog.",
      whenToUse: "You know the operationId and want to call the Datadog API.",
      whenNotToUse: "You are still exploring candidate endpoints.",
      params: "operationId required; params optional; userId optional; enableUnstable optional; authorizationKey optional unless enforced for mutating operations.",
      responseShape: "{ ok, status, data: { operationId, version, apiClass, methodName, httpMethod, pathTemplate, userId, site, response } }",
      prerequisites: "datadog_get_operation and datadog_get_user_credential_metadata.",
      followUps: "datadog_set_user_config, datadog_list_operations."
    }
  ];

  function tokenizeQuery(query) {
    return String(query ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  }

  function scoreToolForQuery(tool, tokens) {
    const haystack = [tool.name, tool.category, tool.summary, tool.whenToUse, tool.whenNotToUse, tool.params, tool.responseShape, tool.prerequisites, tool.followUps]
      .join(" ")
      .toLowerCase();

    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) {
        score += token.length >= 4 ? 2 : 1;
      }
    }

    const queryText = tokens.join(" ");
    if (tool.category === "operation discovery" && /schema|discover|find|search|operation|api/.test(queryText)) {
      score += 5;
    }
    if (tool.category === "credentials" && /credential|secret|api key|application key|auth|validate|rotate/.test(queryText)) {
      score += 5;
    }
    if (tool.category === "config" && /config|setting|preferences|timeout|site/.test(queryText)) {
      score += 5;
    }
    if (tool.category === "tokens" && /token|bearer|http auth|http token|oauth/.test(queryText)) {
      score += 5;
    }
    if (tool.category === "execution" && /invoke|call|run|execute|submit/.test(queryText)) {
      score += 5;
    }
    if (tool.category === "overview" && /overview|start|begin|before|first|what can|how do/.test(queryText)) {
      score += 4;
    }

    return score;
  }

  function buildRecommendationWorkflow(query) {
    const queryText = tokenizeQuery(query).join(" ");
    const workflow = [];
    const pushUnique = (toolName) => {
      if (!workflow.includes(toolName)) {
        workflow.push(toolName);
      }
    };

    const genericStart = ["datadog_connection_info", "datadog_scope_info", "datadog_tool_recommendations"];

    if (/credential|secret|api key|application key|rotate|validate|auth/.test(queryText)) {
      pushUnique("datadog_scope_info");
      pushUnique("datadog_get_user_credential_metadata");
      if (/validate|check|test/.test(queryText)) {
        pushUnique("datadog_validate_user_credentials");
      }
      if (/create|update|rotate|provision|fix/.test(queryText)) {
        pushUnique("datadog_upsert_user_credentials");
      }
    } else if (/token|bearer|http auth|mcp http|oauth/.test(queryText)) {
      pushUnique("datadog_scope_info");
      if (/revoke|disable|compromise/.test(queryText)) {
        pushUnique("datadog_revoke_user_token");
      } else {
        pushUnique("datadog_create_or_update_user_token");
        pushUnique("datadog_revoke_user_token");
      }
    } else if (/config|setting|timeout|site|preference/.test(queryText)) {
      pushUnique("datadog_scope_info");
      pushUnique("datadog_list_user_configs");
      if (/get|find|show|current|effective/.test(queryText)) {
        pushUnique("datadog_get_user_config");
      }
      if (/set|update|write|change|persist/.test(queryText)) {
        pushUnique("datadog_set_user_config");
      }
      if (/delete|remove|clear|reset/.test(queryText)) {
        pushUnique("datadog_delete_user_config");
      }
    } else if (/invoke|call|run|execute|datadog api|endpoint|operation/.test(queryText)) {
      pushUnique("datadog_connection_info");
      pushUnique("datadog_list_operations");
      pushUnique("datadog_get_operation");
      pushUnique("datadog_get_user_credential_metadata");
      pushUnique("datadog_invoke_operation");
    } else if (/discover|search|list|schema|shape|fields|what can|how do|help/.test(queryText)) {
      pushUnique("datadog_connection_info");
      pushUnique("datadog_list_operations");
      pushUnique("datadog_get_operation");
      pushUnique("datadog_tool_recommendations");
    } else {
      genericStart.forEach(pushUnique);
      pushUnique("datadog_list_operations");
      pushUnique("datadog_get_operation");
      pushUnique("datadog_get_user_credential_metadata");
      pushUnique("datadog_invoke_operation");
    }

    return workflow;
  }

  function buildToolGuide(query, topK = 5) {
    const tokens = tokenizeQuery(query);
    const scoredTools = TOOL_GUIDE
      .map((tool) => ({
        ...tool,
        score: scoreToolForQuery(tool, tokens)
      }))
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

    const recommendations = scoredTools.slice(0, topK).map(({ score, ...tool }) => ({
      toolName: tool.name,
      category: tool.category,
      score,
      whyUse: tool.whenToUse,
      schemaDiscovery: {
        params: tool.params,
        responseShape: tool.responseShape,
        prerequisites: tool.prerequisites,
        followUps: tool.followUps
      }
    }));

    return {
      query: String(query ?? ""),
      workflow: buildRecommendationWorkflow(query),
      recommendations,
      catalog: scoredTools.map(({ score, ...tool }) => tool)
    };
  }

  server.tool(
    "datadog_tool_recommendations",
    toolDescription({
      summary: "Return ranked recommendations and schema-discovery guidance for every other MCP tool.",
      whenToUse: "You want a query-suggestion layer that explains which tool to call next and what schema it expects.",
      whenNotToUse: "You already know the exact tool and payload to use.",
      risk: "read-only, low",
      access: "read-only",
      permissions: "No additional permissions required.",
      environment: "Uses the built-in tool catalog and query keywords; no external service calls.",
      params: "query required non-empty string; topK optional integer 1..10 default 5.",
      responseShape: "{ ok, status, data: { query, workflow, recommendations[], catalog[] } }",
      failures: "Invalid query or out-of-range topK.",
      prerequisites: "datadog_connection_info.",
      followUps: "datadog_list_operations, datadog_get_operation, datadog_invoke_operation.",
      warning: "No destructive behavior.",
      example: '{ "name": "datadog_tool_recommendations", "arguments": { "query": "How do I find the right Datadog API and its request schema?", "topK": 3 } }'
    }),
    {
      query: z.string().min(1),
      topK: z.number().int().min(1).max(10).optional()
    },
    withErrorHandling(async ({ query, topK }) => ({
      ok: true,
      status: 200,
      data: buildToolGuide(query, topK ?? 5)
    }))
  );

  server.tool(
    "datadog_connection_info",
    toolDescription({
      summary: "Return MCP runtime, Datadog catalog coverage, and persistence backend connection metadata.",
      whenToUse: "You need a quick readiness snapshot before invoking Datadog operations.",
      whenNotToUse: "You need per-user credential state or operation-level details.",
      risk: "read-only, low",
      access: "read-only",
      permissions: "No additional permissions required.",
      environment: "Uses active process env, APP_NAME, default user scope, and loaded Datadog SDK catalog.",
      params: "No parameters.",
      responseShape: "{ ok, status, data: { server, datadogCatalog, transport, scopeModel } }",
      failures: "Misconfigured env or service bootstrap failure.",
      prerequisites: "None.",
      followUps: "datadog_scope_info, datadog_get_user_credential_metadata, datadog_list_operations.",
      warning: "No destructive behavior.",
      example: '{ "name": "datadog_connection_info", "arguments": {} }'
    }),
    {},
    withErrorHandling(async () => ({
      ok: true,
      status: 200,
      data: {
        server: {
          name,
          version,
          appName,
          adminAuthConfigured: Boolean(adminAuthKey)
        },
        datadogCatalog: {
          generatedAt: datadogService.operationIndex.generatedAt,
          count: datadogService.operationIndex.count,
          versions: datadogService.operationIndex.versions
        },
        transport: {
          mode: env.transport.mode,
          http: {
            authMode: env.transport.http.authMode,
            tokenSource: env.transport.http.tokenSource,
            mcpPath: env.transport.http.mcpPath,
            healthPath: env.transport.http.healthPath
          }
        },
        scopeModel: getScopeModel()
      }
    }))
  );

  server.tool(
    "datadog_scope_info",
    toolDescription({
      summary: "Return app/user scope paths used for Postgres config and Vault secret/token storage.",
      whenToUse: "You are preparing user-scoped operations and need explicit storage paths.",
      whenNotToUse: "You only need server-level metadata.",
      risk: "read-only, low",
      access: "read-only",
      permissions: "No additional permissions required.",
      environment: "Uses APP_NAME and MCP_CONFIG_DEFAULT_USER_ID; userId overrides default at request time.",
      params: "userId optional non-empty string.",
      responseShape: "{ ok, status, data: scopeModel }",
      failures: "Invalid userId normalization edge cases.",
      prerequisites: "datadog_connection_info.",
      followUps: "datadog_upsert_user_credentials, datadog_set_user_config.",
      warning: "No destructive behavior.",
      example: '{ "name": "datadog_scope_info", "arguments": { "userId": "alice" } }'
    }),
    {
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId }) => ({
      ok: true,
      status: 200,
      data: getScopeModel(userId)
    }))
  );

  server.tool(
    "datadog_list_operations",
    toolDescription({
      summary: "List Datadog API operations discovered from the official Datadog SDK (v1 and v2).",
      whenToUse: "You need discoverability and filtering before invoking an operation.",
      whenNotToUse: "You already know exact operationId and only need details.",
      risk: "read-only, low",
      access: "read-only",
      permissions: "No additional permissions required.",
      environment: "Catalog is generated from installed @datadog/datadog-api-client version.",
      params: "version/apiClass optional filters; mutating/unstable booleans; limit 1..500 default 200.",
      responseShape: "{ ok, status, data: { count, operations[] } }",
      failures: "Catalog load failure or invalid filter values.",
      prerequisites: "datadog_connection_info.",
      followUps: "datadog_get_operation, datadog_invoke_operation.",
      warning: "No destructive behavior.",
      example: '{ "name": "datadog_list_operations", "arguments": { "version": "v2", "mutating": false, "limit": 25 } }'
    }),
    {
      version: z.enum(["v1", "v2"]).optional(),
      apiClass: z.string().min(1).optional(),
      mutating: z.boolean().optional(),
      unstable: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional()
    },
    withErrorHandling(async ({ version: selectedVersion, apiClass, mutating, unstable, limit }) => {
      const operations = datadogService.listOperations({
        version: selectedVersion,
        apiClass,
        mutating,
        unstable,
        limit
      });

      return {
        ok: true,
        status: 200,
        data: {
          count: operations.length,
          operations
        }
      };
    })
  );

  server.tool(
    "datadog_get_operation",
    toolDescription({
      summary: "Return metadata for a specific Datadog operationId including request fields, method, path template, and risk.",
      whenToUse: "You need exact parameter shape and method metadata before invocation.",
      whenNotToUse: "You need broad discovery across many APIs.",
      risk: "read-only, low",
      access: "read-only",
      permissions: "No additional permissions required.",
      environment: "Resolved from local catalog generated from Datadog SDK.",
      params: "operationId required, format version.ApiClass.methodName.",
      responseShape: "{ ok, status, data: operation }",
      failures: "404 when operationId does not exist.",
      prerequisites: "datadog_list_operations.",
      followUps: "datadog_invoke_operation.",
      warning: "No destructive behavior.",
      example: '{ "name": "datadog_get_operation", "arguments": { "operationId": "v1.AuthenticationApi.validate" } }'
    }),
    {
      operationId: z.string().min(1)
    },
    withErrorHandling(async ({ operationId }) => {
      const operation = datadogService.getOperation(operationId);
      if (!operation) {
        const notFound = new Error(`Datadog operation not found: ${operationId}`);
        notFound.status = 404;
        throw notFound;
      }

      return {
        ok: true,
        status: 200,
        data: operation
      };
    })
  );

  server.tool(
    "datadog_get_user_credential_metadata",
    toolDescription({
      summary: "Return non-secret credential state for a user (configured flags, site, and update time).",
      whenToUse: "You need to verify user credential readiness without exposing secrets.",
      whenNotToUse: "You need to create/update credentials.",
      risk: "read-only, medium",
      access: "read-only",
      permissions: "Vault read access for this app path.",
      environment: "Reads from Vault user-scoped Datadog credential path.",
      params: "userId optional string; defaults to MCP_CONFIG_DEFAULT_USER_ID.",
      responseShape: "{ ok, status, data: { userId, vaultPath, configured, apiKeyConfigured, applicationKeyConfigured, site, updatedAt } }",
      failures: "Vault unavailable, permission denied, missing path.",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_upsert_user_credentials, datadog_invoke_operation.",
      warning: "Returns metadata only; secret values stay redacted.",
      example: '{ "name": "datadog_get_user_credential_metadata", "arguments": { "userId": "team-a" } }'
    }),
    {
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId }) => ({
      ok: true,
      status: 200,
      data: await datadogService.getCredentialMetadata(userId)
    }))
  );

  server.tool(
    "datadog_upsert_user_credentials",
    toolDescription({
      summary: "Create or update user-scoped Datadog API and application keys in Vault.",
      whenToUse: "Onboarding, rotation, or credential repair for a user scope.",
      whenNotToUse: "Read-only checks or non-secret config changes.",
      risk: "mutating, high",
      access: "mutating",
      permissions: "Requires Vault write access; when MCP_ADMIN_AUTH_KEY is configured, authorizationKey is required.",
      environment: "Writes Vault secret under app/user Datadog credential path.",
      params: "apiKey and applicationKey required non-empty strings; site optional; userId optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: { userId, site, apiKeyConfigured, applicationKeyConfigured, updatedAt } }",
      failures: "401 invalid authorizationKey, Vault write failure, invalid key values.",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_validate_user_credentials, datadog_invoke_operation.",
      warning: "Credential changes impact all future operations for that user.",
      example: '{ "name": "datadog_upsert_user_credentials", "arguments": { "userId": "team-a", "apiKey": "<api>", "applicationKey": "<app>", "site": "datadoghq.com", "authorizationKey": "<admin>" } }'
    }),
    {
      userId: z.string().min(1).optional(),
      apiKey: z.string().min(1),
      applicationKey: z.string().min(1),
      site: z.string().min(1).optional(),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId, apiKey, applicationKey, site, authorizationKey }) => {
      assertAuthorized(authorizationKey, "credential update");
      return {
        ok: true,
        status: 200,
        data: await datadogService.upsertCredentials({ userId, apiKey, applicationKey, site })
      };
    })
  );

  server.tool(
    "datadog_delete_user_credentials",
    toolDescription({
      summary: "Delete user-scoped Datadog credential secret from Vault.",
      whenToUse: "Deprovisioning a user or forcing full credential reset.",
      whenNotToUse: "Routine key rotation where replacement is available.",
      risk: "mutating, high",
      access: "mutating",
      permissions: "Requires Vault delete permission; authorizationKey when MCP_ADMIN_AUTH_KEY is configured.",
      environment: "Deletes app/user Datadog credential secret path in Vault.",
      params: "userId optional, authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: { userId, deleted } }",
      failures: "401 invalid authorizationKey, Vault permission or transport errors.",
      prerequisites: "datadog_get_user_credential_metadata.",
      followUps: "datadog_upsert_user_credentials.",
      warning: "Destructive operation; Datadog calls for this user fail until credentials are re-added.",
      example: '{ "name": "datadog_delete_user_credentials", "arguments": { "userId": "team-a", "authorizationKey": "<admin>" } }'
    }),
    {
      userId: z.string().min(1).optional(),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId, authorizationKey }) => {
      assertAuthorized(authorizationKey, "credential deletion");
      return {
        ok: true,
        status: 200,
        data: await datadogService.deleteCredentials(userId)
      };
    })
  );

  server.tool(
    "datadog_validate_user_credentials",
    toolDescription({
      summary: "Validate configured Datadog keys by calling v1.AuthenticationApi.validate.",
      whenToUse: "After key creation/rotation to confirm key health.",
      whenNotToUse: "You need broad endpoint functionality validation.",
      risk: "read-only, medium",
      access: "read-only",
      permissions: "Requires user-scoped Datadog keys configured in Vault.",
      environment: "Uses resolved user credentials and site settings from Vault/Postgres.",
      params: "userId optional.",
      responseShape: "{ ok, status, data: invokeResult }",
      failures: "Missing keys, invalid keys, Datadog auth failures, network issues.",
      prerequisites: "datadog_upsert_user_credentials.",
      followUps: "datadog_invoke_operation.",
      warning: "No destructive behavior.",
      example: '{ "name": "datadog_validate_user_credentials", "arguments": { "userId": "team-a" } }'
    }),
    {
      userId: z.string().min(1).optional()
    },
      withErrorHandling(async ({ userId }) => ({
        ok: true,
        status: 200,
        data: await datadogService.invokeOperation({
          userId,
          operationId: "v1.AuthenticationApi.validate",
          params: {}
        })
      }), { redact: true })
  );

  server.tool(
    "datadog_list_user_configs",
    toolDescription({
      summary: "List user-scoped Postgres configuration entries for this MCP app.",
      whenToUse: "Inspect persisted user configuration like datadog.site or datadog.timeoutMs.",
      whenNotToUse: "Single key retrieval where key is known.",
      risk: "read-only, low",
      access: "read-only",
      permissions: "Requires Postgres read access.",
      environment: "Reads from app-prefixed config table scoped by userId.",
      params: "userId optional, prefix optional string filter.",
      responseShape: "{ ok, status, data: rows[] }",
      failures: "Postgres connectivity or table issues.",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_set_user_config, datadog_get_user_config.",
      warning: "No destructive behavior.",
      example: '{ "name": "datadog_list_user_configs", "arguments": { "userId": "team-a", "prefix": "datadog." } }'
    }),
    {
      userId: z.string().min(1).optional(),
      prefix: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId, prefix }) => ({
      ok: true,
      status: 200,
      data: await datadogService.listUserConfigs(prefix, userId)
    }))
  );

  server.tool(
    "datadog_get_user_config",
    toolDescription({
      summary: "Get one user-scoped Postgres configuration key.",
      whenToUse: "You need the effective value of a specific persisted config key.",
      whenNotToUse: "You need many keys; use listing instead.",
      risk: "read-only, low",
      access: "read-only",
      permissions: "Requires Postgres read access.",
      environment: "Looks up app/user scoped row in Postgres config table.",
      params: "key required non-empty string; userId optional.",
      responseShape: "{ ok, status, data: row|null }",
      failures: "Postgres connectivity issues.",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_set_user_config.",
      warning: "No destructive behavior.",
      example: '{ "name": "datadog_get_user_config", "arguments": { "userId": "team-a", "key": "datadog.site" } }'
    }),
    {
      userId: z.string().min(1).optional(),
      key: z.string().min(1)
    },
    withErrorHandling(async ({ userId, key }) => ({
      ok: true,
      status: 200,
      data: await datadogService.getUserConfig(key, userId)
    }))
  );

  server.tool(
    "datadog_set_user_config",
    toolDescription({
      summary: "Set or update one user-scoped Postgres configuration key.",
      whenToUse: "Persist runtime behavior values like datadog.site and datadog.timeoutMs.",
      whenNotToUse: "Sensitive values such as API keys; use Vault credential tools.",
      risk: "mutating, medium",
      access: "mutating",
      permissions: "Requires Postgres write access; authorizationKey when MCP_ADMIN_AUTH_KEY is configured.",
      environment: "Writes to app/user row in Postgres config table.",
      params: "key required; value any JSON type; userId optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: row }",
      failures: "401 invalid authorizationKey, Postgres write failures.",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_get_user_config, datadog_invoke_operation.",
      warning: "Changing config alters future operation behavior for that user.",
      example: '{ "name": "datadog_set_user_config", "arguments": { "userId": "team-a", "key": "datadog.site", "value": "datadoghq.eu", "authorizationKey": "<admin>" } }'
    }),
    {
      userId: z.string().min(1).optional(),
      key: z.string().min(1),
      value: z.unknown(),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId, key, value, authorizationKey }) => {
      assertAuthorized(authorizationKey, "config update");
      return {
        ok: true,
        status: 200,
        data: await datadogService.setUserConfig(key, value, userId)
      };
    })
  );

  server.tool(
    "datadog_delete_user_config",
    toolDescription({
      summary: "Delete one user-scoped Postgres configuration key.",
      whenToUse: "Reset a user key to default resolution behavior.",
      whenNotToUse: "You need to audit current values first; inspect before delete.",
      risk: "mutating, medium",
      access: "mutating",
      permissions: "Requires Postgres write access; authorizationKey when MCP_ADMIN_AUTH_KEY is configured.",
      environment: "Deletes app/user scoped row in Postgres config table.",
      params: "key required; userId optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: { deleted, userId, key } }",
      failures: "401 invalid authorizationKey, Postgres delete failure.",
      prerequisites: "datadog_get_user_config.",
      followUps: "datadog_invoke_operation.",
      warning: "Destructive for that key; defaults/fallbacks apply afterward.",
      example: '{ "name": "datadog_delete_user_config", "arguments": { "userId": "team-a", "key": "datadog.timeoutMs", "authorizationKey": "<admin>" } }'
    }),
    {
      userId: z.string().min(1).optional(),
      key: z.string().min(1),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId, key, authorizationKey }) => {
      assertAuthorized(authorizationKey, "config deletion");
      const deleted = await datadogService.deleteUserConfig(key, userId);
      return {
        ok: true,
        status: 200,
        data: {
          deleted,
          userId: datadogService.resolveUserId(userId),
          key
        }
      };
    })
  );

  server.tool(
    "datadog_create_or_update_user_token",
    toolDescription({
      summary: "Create or update a multi-user MCP HTTP bearer token entry persisted in Vault token indexes.",
      whenToUse: "Provisioning/rotating MCP user tokens for HTTP transport access.",
      whenNotToUse: "Datadog API credential management.",
      risk: "mutating, high",
      access: "mutating",
      permissions: "Requires Vault write access; authorizationKey when MCP_ADMIN_AUTH_KEY is configured.",
      environment: "Writes both global verifier index path and user-scoped token index path in Vault.",
      params: "userId optional; token optional (generated if omitted); tokenId/scopes/audience/expiresAt optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: { userId, tokenId, tokenHash, token, scopes, audience, expiresAt, indexPaths[] } }",
      failures: "401 invalid authorizationKey, Vault write failures, invalid token payload.",
      prerequisites: "datadog_scope_info.",
      followUps: "datadog_revoke_user_token, datadog_connection_info.",
      warning: "Returned token is sensitive and shown only once; store securely.",
      example: '{ "name": "datadog_create_or_update_user_token", "arguments": { "userId": "team-a", "scopes": ["mcp:invoke"], "audience": ["codex"], "authorizationKey": "<admin>" } }'
    }),
    {
      userId: z.string().min(1).optional(),
      token: z.string().min(16).optional(),
      tokenId: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).optional(),
      audience: z.array(z.string().min(1)).optional(),
      expiresAt: z.string().min(1).optional(),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId, token, tokenId, scopes, audience, expiresAt, authorizationKey }) => {
      assertAuthorized(authorizationKey, "token create/update");

      const effectiveUserId = datadogService.resolveUserId(userId);
      const tokenValue = token ?? createBearerToken({ byteLength: 32 });
      const tokenPayload = createVaultTokenEntry({
        userId: effectiveUserId,
        tokenId,
        token: tokenValue,
        scopes: parseArrayValue(scopes, ["mcp:invoke", "mcp:read"]),
        audience: parseArrayValue(audience, ["codex"]),
        expiresAt
      });

      const globalPath = env.transport.http.vaultToken.indexPath;
      const userPath = getVaultUserTokenIndexPath(appName, effectiveUserId);

      const [globalExisting, userExisting] = await Promise.all([readTokenIndex(globalPath), readTokenIndex(userPath)]);
      const mergeInput = {
        userId: effectiveUserId,
        tokenHash: tokenPayload.tokenHash,
        entry: tokenPayload.entry
      };

      const mergedGlobal = mergeVaultTokenIndex(globalExisting, mergeInput);
      const mergedUser = mergeVaultTokenIndex(userExisting, mergeInput);

      await Promise.all([writeTokenIndex(globalPath, mergedGlobal), writeTokenIndex(userPath, mergedUser)]);

      return {
        ok: true,
        status: 200,
        data: {
          userId: effectiveUserId,
          tokenId: tokenPayload.entry.tokenId,
          tokenHash: tokenPayload.tokenHash,
          token: tokenPayload.token,
          scopes: tokenPayload.entry.scopes,
          audience: tokenPayload.entry.audience,
          expiresAt: tokenPayload.entry.expiresAt ?? null,
          indexPaths: [globalPath, userPath]
        }
      };
    }, { redact: true })
  );

  server.tool(
    "datadog_revoke_user_token",
    toolDescription({
      summary: "Revoke a user token in Vault token indexes by token value or token hash.",
      whenToUse: "Compromised key response or deprovisioning.",
      whenNotToUse: "Routine rotation where old token must remain active temporarily.",
      risk: "mutating, high",
      access: "mutating",
      permissions: "Requires Vault write access; authorizationKey when MCP_ADMIN_AUTH_KEY is configured.",
      environment: "Updates both global verifier index path and user-scoped token index path.",
      params: "token or tokenHash required; userId optional; authorizationKey optional unless enforced.",
      responseShape: "{ ok, status, data: { userId, tokenHash, revoked, indexPaths[] } }",
      failures: "401 invalid authorizationKey, token not found, Vault write failures.",
      prerequisites: "datadog_create_or_update_user_token.",
      followUps: "datadog_create_or_update_user_token.",
      warning: "Destructive security operation; token becomes unusable immediately.",
      example: '{ "name": "datadog_revoke_user_token", "arguments": { "userId": "team-a", "tokenHash": "<sha256>", "authorizationKey": "<admin>" } }'
    }),
    {
      userId: z.string().min(1).optional(),
      token: z.string().min(1).optional(),
      tokenHash: z.string().min(1).optional(),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId, token, tokenHash, authorizationKey }) => {
      assertAuthorized(authorizationKey, "token revocation");

      const effectiveUserId = datadogService.resolveUserId(userId);
      const resolvedTokenHash = String(tokenHash ?? "").trim() || sha256Hex(String(token ?? ""));
      if (!resolvedTokenHash) {
        throw new Error("token or tokenHash is required");
      }

      const globalPath = env.transport.http.vaultToken.indexPath;
      const userPath = getVaultUserTokenIndexPath(appName, effectiveUserId);

      const [globalExisting, userExisting] = await Promise.all([readTokenIndex(globalPath), readTokenIndex(userPath)]);

      const revokePayload = (payload) => {
        const next = cloneObject(payload);
        const now = new Date().toISOString();

        const tokens = cloneObject(next.tokens);
        if (isObject(tokens[resolvedTokenHash])) {
          tokens[resolvedTokenHash] = {
            ...tokens[resolvedTokenHash],
            active: false,
            revokedAt: now
          };
          next.tokens = tokens;
        }

        const users = cloneObject(next.users);
        const userEntry = cloneObject(users[effectiveUserId]);
        const userTokens = cloneObject(userEntry.tokens);
        if (isObject(userTokens[resolvedTokenHash])) {
          userTokens[resolvedTokenHash] = {
            ...userTokens[resolvedTokenHash],
            active: false,
            revokedAt: now
          };
          userEntry.tokens = userTokens;
          users[effectiveUserId] = userEntry;
          next.users = users;
        }

        return next;
      };

      const nextGlobal = revokePayload(globalExisting);
      const nextUser = revokePayload(userExisting);

      await Promise.all([writeTokenIndex(globalPath, nextGlobal), writeTokenIndex(userPath, nextUser)]);

      return {
        ok: true,
        status: 200,
        data: {
          userId: effectiveUserId,
          tokenHash: resolvedTokenHash,
          revoked: true,
          indexPaths: [globalPath, userPath]
        }
      };
    })
  );

  server.tool(
    "datadog_invoke_operation",
    toolDescription({
      summary: "Invoke any Datadog SDK operation from the generated full-catalog operationId list.",
      whenToUse: "You need direct access to any Datadog API endpoint with user-scoped keys.",
      whenNotToUse: "You are still exploring which operation to call.",
      risk: "mixed; read-only for GET/HEAD, high for mutating methods",
      access: "read-only or mutating based on operation method",
      permissions: "User-scoped Datadog credentials required. If operation is mutating and MCP_ADMIN_AUTH_KEY is configured, authorizationKey is required.",
      environment: "Credentials from Vault, config from Postgres, endpoint metadata from local Datadog SDK catalog.",
      params: "operationId required; params object optional; userId optional; enableUnstable optional default true; authorizationKey optional unless enforced for mutating operation.",
      responseShape: "{ ok, status, data: { operationId, version, apiClass, methodName, httpMethod, pathTemplate, userId, site, response } }",
      failures: "401 invalid authorizationKey, missing credentials, Datadog API validation/auth/rate-limit/network errors, unknown operationId.",
      prerequisites: "datadog_get_operation and datadog_get_user_credential_metadata.",
      followUps: "datadog_set_user_config, datadog_list_operations.",
      warning: "Mutating operations can change or delete Datadog resources; verify params and scope before execution.",
      example: '{ "name": "datadog_invoke_operation", "arguments": { "userId": "team-a", "operationId": "v1.AuthenticationApi.validate", "params": {} } }'
    }),
    {
      userId: z.string().min(1).optional(),
      operationId: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
      enableUnstable: z.boolean().optional(),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId, operationId, params, enableUnstable, authorizationKey }) => {
      const operation = datadogService.getOperation(operationId);
      if (!operation) {
        const notFound = new Error(`Datadog operation not found: ${operationId}`);
        notFound.status = 404;
        throw notFound;
      }

      if (MUTATING_METHODS.has(String(operation.httpMethod).toUpperCase())) {
        assertAuthorized(authorizationKey, `mutating Datadog operation ${operationId}`);
      }

      return {
        ok: true,
        status: 200,
        data: await datadogService.invokeOperation({
          userId,
          operationId,
          params,
          enableUnstable: enableUnstable !== false
        })
      };
    }, { redact: true })
  );

  return server;
}
