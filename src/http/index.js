import { env } from "../config/env.js";
import { createCoreServices } from "../bootstrap.js";
import { createOAuth2IntrospectionVerifier } from "./oauth2.js";
import { createHttpMcpServer } from "./server.js";
import { createVaultTokenVerifier } from "./vaultTokenAuth.js";
import { createMcpServer } from "../mcp/server.js";

async function main() {
  if (env.transport.http.tls.enabled) {
    throw new Error(
      "MCP_HTTP_TLS_ENABLED=true is not supported in this process mode. Terminate TLS at a reverse proxy/load balancer."
    );
  }

  const { datadogService, vaultService, configStore } = createCoreServices();

  const tokenVerifier =
    env.transport.http.tokenSource === "vault"
      ? createVaultTokenVerifier({
          vaultService,
          indexPath: env.transport.http.vaultToken.indexPath,
          defaultUserId: env.transport.http.vaultToken.defaultUserId,
          requiredScopes: env.transport.http.vaultToken.requiredScopes,
          requiredAudience: env.transport.http.vaultToken.requiredAudience,
          cacheTtlMs: env.transport.http.vaultToken.cacheTtlMs
        })
      : undefined;

  const oauth2Verifier =
    env.transport.http.authMode === "oauth2" || env.transport.http.authMode === "both"
      ? createOAuth2IntrospectionVerifier({
          introspectionUrl: env.transport.http.oauth2.introspectionUrl,
          clientId: env.transport.http.oauth2.clientId,
          clientSecret: env.transport.http.oauth2.clientSecret,
          requiredScopes: env.transport.http.oauth2.requiredScopes,
          requiredAudience: env.transport.http.oauth2.requiredAudience,
          timeoutMs: env.transport.http.oauth2.timeoutMs,
          cacheTtlMs: env.transport.http.oauth2.cacheTtlMs
        })
      : undefined;

  const httpServer = createHttpMcpServer({
    host: env.transport.http.host,
    port: env.transport.http.port,
    mcpPath: env.transport.http.mcpPath,
    healthPath: env.transport.http.healthPath,
    authMode: env.transport.http.authMode,
    authTokens: env.transport.http.authTokens,
    tokenVerifier,
    oauth2Verifier,
    trustedProxy: env.transport.http.trustedProxy,
    allowedOrigins: env.transport.http.allowedOrigins,
    allowedIps: env.transport.http.allowedIps,
    maxBodyBytes: env.transport.http.maxBodyBytes,
    rateLimitWindowMs: env.transport.http.rateLimitWindowMs,
    rateLimitMaxRequests: env.transport.http.rateLimitMaxRequests,
    createMcpServer: () =>
      createMcpServer({
        name: env.mcpServerName,
        version: env.mcpServerVersion,
        env,
        datadogService
      })
  });

  await httpServer.start();

  console.log(
    `HTTP MCP server listening on http://${httpServer.host}:${httpServer.port}${httpServer.mcpPath}`
  );

  const shutdown = async () => {
    await configStore.close();
    await httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("HTTP MCP server failed to start", error);
  process.exit(1);
});
