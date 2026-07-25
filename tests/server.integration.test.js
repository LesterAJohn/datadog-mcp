import assert from "node:assert/strict";
import test from "node:test";

import { createMcpServer } from "../src/mcp/server.js";

function setEnv(updates) {
  const previous = {};
  for (const [key, value] of Object.entries(updates)) {
    previous[key] = process.env[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function createDatadogServiceMock() {
  const store = new Map();

  return {
    operationIndex: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      count: 2,
      versions: ["v1", "v2"]
    },
    vaultService: {
      async getSecret(path) {
        return store.get(path) ?? null;
      },
      async setSecret(path, value) {
        store.set(path, value);
        return { ok: true };
      }
    },
    getCredentialVaultPath(userId) {
      return `datadog-mcp/users/${userId}/datadog/credentials`;
    },
    resolveUserId(userId) {
      return userId ?? "default";
    },
    listOperations() {
      return [
        {
          operationId: "v1.AuthenticationApi.validate",
          version: "v1",
          apiClass: "AuthenticationApi",
          methodName: "validate",
          httpMethod: "GET",
          pathTemplate: "/api/v1/validate",
          mutating: false,
          unstable: false,
          requestShape: []
        },
        {
          operationId: "v2.DashboardsApi.createDashboard",
          version: "v2",
          apiClass: "DashboardsApi",
          methodName: "createDashboard",
          httpMethod: "POST",
          pathTemplate: "/api/v1/dashboard",
          mutating: true,
          unstable: false,
          requestShape: [{ name: "body", required: true, type: "object" }]
        }
      ];
    },
    getOperation(operationId) {
      return this.listOperations().find((operation) => operation.operationId === operationId) ?? null;
    },
    async getCredentialMetadata(userId) {
      return {
        userId: userId ?? "default",
        configured: true,
        apiKeyConfigured: true,
        applicationKeyConfigured: true,
        site: "datadoghq.com"
      };
    },
    async upsertCredentials({ userId }) {
      return {
        userId: userId ?? "default",
        site: "datadoghq.com",
        apiKeyConfigured: true,
        applicationKeyConfigured: true
      };
    },
    async deleteCredentials(userId) {
      return { userId: userId ?? "default", deleted: true };
    },
    async listUserConfigs() {
      return [];
    },
    async getUserConfig(key) {
      return { key, value: "x" };
    },
    async setUserConfig(key, value, userId) {
      return { user_id: userId ?? "default", key, value };
    },
    async deleteUserConfig() {
      return true;
    },
    async invokeOperation({ operationId, params }) {
      return {
        operationId,
        response: {
          ok: true,
          params: params ?? {}
        }
      };
    }
  };
}

function createEnv() {
  return {
    appName: "datadog-mcp",
    defaultUserId: "default",
    adminAuthKey: process.env.MCP_ADMIN_AUTH_KEY ?? "",
    allowSensitiveOutput: false,
    transport: {
      mode: "stdio",
      http: {
        authMode: "token",
        tokenSource: "vault",
        mcpPath: "/mcp",
        healthPath: "/healthz",
        vaultToken: {
          indexPath: "datadog-mcp/http/auth/token-index"
        }
      }
    }
  };
}

async function invokeTool(server, name, args = {}) {
  const tool = server._registeredTools[name];
  assert.ok(tool, `Expected tool ${name} to exist`);
  const result = await tool.handler(args);
  const payload = JSON.parse(result.content[0].text);
  return { result, payload };
}

test("datadog_list_operations returns catalog entries", async () => {
  const restore = setEnv({ MCP_ADMIN_AUTH_KEY: "" });

  try {
    const server = createMcpServer({
      name: "datadog-mcp",
      version: "0.1.0",
      env: createEnv(),
      datadogService: createDatadogServiceMock()
    });

    const { payload } = await invokeTool(server, "datadog_list_operations", { limit: 5 });
    assert.equal(payload.ok, true);
    assert.equal(payload.data.count, 2);
  } finally {
    restore();
  }
});

test("mutating tools require authorizationKey when MCP_ADMIN_AUTH_KEY is configured", async () => {
  const restore = setEnv({ MCP_ADMIN_AUTH_KEY: "admin-key" });

  try {
    const server = createMcpServer({
      name: "datadog-mcp",
      version: "0.1.0",
      env: createEnv(),
      datadogService: createDatadogServiceMock()
    });

    const unauthorized = await invokeTool(server, "datadog_set_user_config", {
      key: "datadog.site",
      value: "datadoghq.eu"
    });
    assert.equal(unauthorized.result.isError, true);
    assert.equal(unauthorized.payload.status, 401);

    const authorized = await invokeTool(server, "datadog_set_user_config", {
      key: "datadog.site",
      value: "datadoghq.eu",
      authorizationKey: "admin-key"
    });
    assert.equal(authorized.payload.ok, true);
  } finally {
    restore();
  }
});

test("datadog_invoke_operation blocks mutating operation without admin key", async () => {
  const restore = setEnv({ MCP_ADMIN_AUTH_KEY: "admin-key" });

  try {
    const server = createMcpServer({
      name: "datadog-mcp",
      version: "0.1.0",
      env: createEnv(),
      datadogService: createDatadogServiceMock()
    });

    const unauthorized = await invokeTool(server, "datadog_invoke_operation", {
      operationId: "v2.DashboardsApi.createDashboard",
      params: { body: { title: "x" } }
    });
    assert.equal(unauthorized.result.isError, true);
    assert.equal(unauthorized.payload.status, 401);

    const authorized = await invokeTool(server, "datadog_invoke_operation", {
      operationId: "v2.DashboardsApi.createDashboard",
      params: { body: { title: "x" } },
      authorizationKey: "admin-key"
    });
    assert.equal(authorized.payload.ok, true);
  } finally {
    restore();
  }
});
