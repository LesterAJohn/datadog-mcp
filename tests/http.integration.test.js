import assert from "node:assert/strict";
import test from "node:test";

import { createHttpMcpServer } from "../src/http/server.js";
import { createMcpServer } from "../src/mcp/server.js";

function createDatadogServiceMock() {
  return {
    operationIndex: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      count: 1,
      versions: ["v1", "v2"]
    },
    vaultService: {
      async getSecret() {
        return {};
      },
      async setSecret() {
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
          httpMethod: "GET"
        }
      ];
    },
    getOperation() {
      return {
        operationId: "v1.AuthenticationApi.validate",
        version: "v1",
        apiClass: "AuthenticationApi",
        methodName: "validate",
        httpMethod: "GET",
        mutating: false,
        unstable: false,
        requestShape: []
      };
    },
    async getCredentialMetadata() {
      return {
        configured: true,
        apiKeyConfigured: true,
        applicationKeyConfigured: true,
        site: "datadoghq.com"
      };
    },
    async upsertCredentials() {
      return {};
    },
    async deleteCredentials() {
      return {};
    },
    async listUserConfigs() {
      return [];
    },
    async getUserConfig() {
      return null;
    },
    async setUserConfig() {
      return {};
    },
    async deleteUserConfig() {
      return true;
    },
    async invokeOperation() {
      return { response: { valid: true } };
    }
  };
}

function createEnv() {
  return {
    appName: "datadog-mcp",
    defaultUserId: "default",
    adminAuthKey: "",
    allowSensitiveOutput: false,
    transport: {
      mode: "http",
      http: {
        authMode: "token",
        tokenSource: "static",
        mcpPath: "/mcp",
        healthPath: "/healthz",
        vaultToken: {
          indexPath: "datadog-mcp/http/auth/token-index"
        }
      }
    }
  };
}

function initializeRequestPayload() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "test-client",
        version: "1.0.0"
      }
    }
  };
}

function createTestServer() {
  const env = createEnv();
  const datadogService = createDatadogServiceMock();

  return createHttpMcpServer({
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    healthPath: "/healthz",
    authMode: "token",
    authTokens: ["test-token"],
    trustedProxy: false,
    allowedOrigins: [],
    allowedIps: [],
    maxBodyBytes: 1024 * 1024,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 60,
    createMcpServer: () =>
      createMcpServer({
        name: "datadog-mcp",
        version: "0.1.0",
        env,
        datadogService
      })
  });
}

test("unauthorized HTTP request is rejected", async () => {
  const server = createTestServer();
  await server.start();

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(initializeRequestPayload())
    });

    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("authorized HTTP MCP initialize call succeeds", async () => {
  const server = createTestServer();
  await server.start();

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-token"
      },
      body: JSON.stringify(initializeRequestPayload())
    });

    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test("health endpoint reports HTTP MCP status", async () => {
  const server = createTestServer();
  await server.start();

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.status, 200);
    assert.equal(payload.transport, "http");
    assert.equal(payload.path, "/mcp");
  } finally {
    await server.close();
  }
});
