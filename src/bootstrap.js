import { env } from "./config/env.js";
import { createDatadogOperationIndex } from "./services/datadogApiCatalog.js";
import { ConfigStore } from "./services/configStore.js";
import { DatadogService } from "./services/datadogService.js";
import { VaultService } from "./services/vault.js";

export function createCoreServices() {
  const configStore = new ConfigStore(
    {
      host: env.postgres.host,
      port: env.postgres.port,
      database: env.postgres.database,
      user: env.postgres.user,
      password: env.postgres.password,
      max: env.postgres.maxConnections
    },
    {
      appName: env.appName,
      defaultUserId: env.defaultUserId,
      tableName: `${env.appName.replace(/-/g, "_")}_config`
    }
  );

  const vaultService = new VaultService({
    endpoint: env.vault.endpoint,
    token: env.vault.token,
    agentEnabled: env.vault.agentEnabled,
    agentAuthMode: env.vault.agentAuthMode,
    agentTokenFilePath: env.vault.agentTokenFilePath,
    agentListenerEnabled: env.vault.agentListenerEnabled,
    agentListenerAddr: env.vault.agentListenerAddr,
    kvMount: env.vault.kvMount,
    writeRetryAttempts: env.vault.writeRetryAttempts,
    writeRetryBaseDelayMs: env.vault.writeRetryBaseDelayMs,
    writeRetryMaxDelayMs: env.vault.writeRetryMaxDelayMs
  });

  const operationIndex = createDatadogOperationIndex();

  const datadogService = new DatadogService({
    appName: env.appName,
    defaultUserId: env.defaultUserId,
    vaultService,
    configStore,
    operationIndex
  });

  return {
    env,
    configStore,
    vaultService,
    operationIndex,
    datadogService
  };
}
