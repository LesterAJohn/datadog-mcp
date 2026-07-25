import dotenv from "dotenv";

dotenv.config();

const TRANSPORT_MODES = new Set(["stdio", "http", "both"]);
const HTTP_AUTH_MODES = new Set(["token", "oauth2", "both"]);
const HTTP_TOKEN_SOURCES = new Set(["static", "vault"]);

function enumValue(name, fallback, allowedValues) {
  const value = String(process.env[name] ?? fallback).toLowerCase();
  if (!allowedValues.has(value)) {
    throw new Error(
      `Environment variable ${name} must be one of: ${Array.from(allowedValues).join(", ")}`
    );
  }
  return value;
}

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number`);
  }
  return value;
}

function positiveInt(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }

  return value;
}

function portNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Environment variable ${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function parseCsv(name, fallback = "") {
  return String(process.env[name] ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanValue(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = String(raw).toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`Environment variable ${name} must be either true or false`);
}

function normalizeAppName(value, fallback = "skeleton") {
  return String(value ?? fallback).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-") || fallback;
}

const transportMode = enumValue("MCP_TRANSPORT_MODE", "stdio", TRANSPORT_MODES);
const httpAuthMode = enumValue("MCP_HTTP_AUTH_MODE", "token", HTTP_AUTH_MODES);
const httpTokenSource = enumValue("MCP_HTTP_TOKEN_SOURCE", "vault", HTTP_TOKEN_SOURCES);

const appName = normalizeAppName(process.env.APP_NAME, "datadog-mcp");
const defaultUserId = String(process.env.MCP_CONFIG_DEFAULT_USER_ID ?? "default").trim() || "default";

export const env = {
  appName,
  mcpServerName: process.env.MCP_SERVER_NAME ?? "datadog-mcp",
  mcpServerVersion: process.env.MCP_SERVER_VERSION ?? "0.1.0",
  allowSensitiveOutput: booleanValue("MCP_ALLOW_SENSITIVE_OUTPUT", false),
  adminAuthKey: process.env.MCP_ADMIN_AUTH_KEY ?? "",
  defaultUserId,
  postgres: {
    host: required("POSTGRES_HOST", "127.0.0.1"),
    port: portNumber("POSTGRES_PORT", "5432"),
    database: required("POSTGRES_DB", "mcp_config"),
    user: required("POSTGRES_USER", "mcp_user"),
    password: required("POSTGRES_PASSWORD", "mcp_password"),
    maxConnections: positiveInt("POSTGRES_MAX_CONNECTIONS", "10")
  },
  vault: {
    endpoint: required("VAULT_ADDR", "http://127.0.0.1:8200"),
    token: process.env.VAULT_TOKEN ?? "",
    agentEnabled: booleanValue("VAULT_AGENT_ENABLED", false),
    agentAuthMode: required("VAULT_AGENT_AUTH_MODE", "file"),
    agentTokenFilePath: process.env.VAULT_AGENT_TOKEN_FILE_PATH ?? "",
    agentListenerEnabled: booleanValue("VAULT_AGENT_LISTENER_ENABLED", false),
    agentListenerAddr: process.env.VAULT_AGENT_LISTENER_ADDR ?? "",
    kvMount: required("VAULT_KV_MOUNT", "secret"),
    writeRetryAttempts: positiveInt("VAULT_WRITE_RETRY_ATTEMPTS", "3"),
    writeRetryBaseDelayMs: positiveNumber("VAULT_WRITE_RETRY_BASE_DELAY_MS", "200"),
    writeRetryMaxDelayMs: positiveNumber("VAULT_WRITE_RETRY_MAX_DELAY_MS", "2000")
  },
  datadog: {
    defaultSite: process.env.DATADOG_SITE ?? "datadoghq.com",
    defaultTimeoutMs: positiveNumber("DATADOG_TIMEOUT_MS", "15000")
  },
  transport: {
    mode: transportMode,
    http: {
      host: required("MCP_HTTP_HOST", "127.0.0.1"),
      port: portNumber("MCP_HTTP_PORT", "3000"),
      mcpPath: required("MCP_HTTP_PATH", "/mcp"),
      healthPath: required("MCP_HTTP_HEALTH_PATH", "/healthz"),
      authMode: httpAuthMode,
      tokenSource: httpTokenSource,
      authTokens: parseCsv("MCP_HTTP_AUTH_TOKENS", "replace-me-token"),
      trustedProxy: booleanValue("MCP_HTTP_TRUST_PROXY", false),
      allowedOrigins: parseCsv("MCP_HTTP_ALLOWED_ORIGINS", ""),
      allowedIps: parseCsv("MCP_HTTP_ALLOWED_IPS", ""),
      maxBodyBytes: positiveNumber("MCP_HTTP_MAX_BODY_BYTES", "1048576"),
      rateLimitWindowMs: positiveNumber("MCP_HTTP_RATE_LIMIT_WINDOW_MS", "60000"),
      rateLimitMaxRequests: positiveNumber("MCP_HTTP_RATE_LIMIT_MAX_REQUESTS", "60"),
      vaultToken: {
        indexPath: process.env.MCP_HTTP_VAULT_TOKEN_INDEX_PATH ?? `${appName}/http/auth/token-index`,
        defaultUserId: process.env.MCP_HTTP_VAULT_TOKEN_DEFAULT_USER_ID ?? defaultUserId,
        requiredScopes: parseCsv("MCP_HTTP_VAULT_TOKEN_REQUIRED_SCOPES", ""),
        requiredAudience: process.env.MCP_HTTP_VAULT_TOKEN_REQUIRED_AUDIENCE ?? "",
        cacheTtlMs: positiveNumber("MCP_HTTP_VAULT_TOKEN_CACHE_TTL_MS", "30000")
      },
      oauth2: {
        introspectionUrl: process.env.MCP_HTTP_OAUTH2_INTROSPECTION_URL ?? "",
        clientId: process.env.MCP_HTTP_OAUTH2_CLIENT_ID ?? "",
        clientSecret: process.env.MCP_HTTP_OAUTH2_CLIENT_SECRET ?? "",
        requiredScopes: parseCsv("MCP_HTTP_OAUTH2_REQUIRED_SCOPES", ""),
        requiredAudience: process.env.MCP_HTTP_OAUTH2_REQUIRED_AUDIENCE ?? "",
        timeoutMs: positiveNumber("MCP_HTTP_OAUTH2_TIMEOUT_MS", "5000"),
        cacheTtlMs: positiveNumber("MCP_HTTP_OAUTH2_CACHE_TTL_MS", "30000")
      },
      tls: {
        enabled: booleanValue("MCP_HTTP_TLS_ENABLED", false),
        certPath: process.env.MCP_HTTP_TLS_CERT_PATH ?? "",
        keyPath: process.env.MCP_HTTP_TLS_KEY_PATH ?? ""
      }
    }
  }
};
