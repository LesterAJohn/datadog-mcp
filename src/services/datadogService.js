import { client, v1, v2 } from "@datadog/datadog-api-client";
import { getVaultUserTokenIndexPath, normalizeAppName, normalizeUserIdForPath } from "../config/vaultAuthTokenIndex.js";

const DATADOG_MODULES = { v1, v2 };

function normalizeUserId(value, fallback = "default") {
  return String(value ?? fallback).trim() || fallback;
}

function normalizeSite(site) {
  const candidate = String(site ?? "datadoghq.com").trim();
  return candidate || "datadoghq.com";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeHttpTimeout(value, fallback = 15000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizeApiClass(moduleRef, apiClass) {
  if (!moduleRef || typeof moduleRef !== "object") {
    return null;
  }

  if (moduleRef[apiClass]) {
    return apiClass;
  }

  const suffix = "Api";
  if (apiClass.endsWith(suffix) && moduleRef[apiClass.slice(0, -suffix)]) {
    return apiClass.slice(0, -suffix);
  }

  if (!apiClass.endsWith(suffix) && moduleRef[`${apiClass}${suffix}`]) {
    return `${apiClass}${suffix}`;
  }

  return null;
}

export class DatadogService {
  constructor({ appName, defaultUserId, vaultService, configStore, operationIndex }) {
    if (!vaultService) {
      throw new Error("vaultService is required");
    }

    if (!configStore) {
      throw new Error("configStore is required");
    }

    if (!operationIndex) {
      throw new Error("operationIndex is required");
    }

    this.appName = normalizeAppName(appName ?? "datadog-mcp");
    this.defaultUserId = normalizeUserId(defaultUserId, "default");
    this.vaultService = vaultService;
    this.configStore = configStore;
    this.operationIndex = operationIndex;
  }

  resolveUserId(userId) {
    return normalizeUserId(userId, this.defaultUserId);
  }

  getCredentialVaultPath(userId) {
    const effectiveUserId = this.resolveUserId(userId);
    return `${this.appName}/users/${normalizeUserIdForPath(effectiveUserId)}/datadog/credentials`;
  }

  getHttpTokenIndexPath(userId) {
    const effectiveUserId = this.resolveUserId(userId);
    return getVaultUserTokenIndexPath(this.appName, effectiveUserId);
  }

  async getCredentialSecret(userId) {
    const secret = await this.vaultService.getSecret(this.getCredentialVaultPath(userId));
    return isPlainObject(secret) ? secret : null;
  }

  async upsertCredentials({ userId, apiKey, applicationKey, site }) {
    const effectiveUserId = this.resolveUserId(userId);
    const existing = (await this.getCredentialSecret(effectiveUserId)) ?? {};

    const next = {
      ...existing,
      apiKey: String(apiKey ?? existing.apiKey ?? "").trim(),
      applicationKey: String(applicationKey ?? existing.applicationKey ?? "").trim(),
      site: normalizeSite(site ?? existing.site),
      updatedAt: new Date().toISOString(),
      updatedBy: "mcp-tool"
    };

    if (!next.apiKey) {
      throw new Error("Datadog API key is required");
    }

    if (!next.applicationKey) {
      throw new Error("Datadog application key is required");
    }

    await this.vaultService.setSecret(this.getCredentialVaultPath(effectiveUserId), next);

    return {
      userId: effectiveUserId,
      site: next.site,
      apiKeyConfigured: true,
      applicationKeyConfigured: true,
      updatedAt: next.updatedAt
    };
  }

  async deleteCredentials(userId) {
    const effectiveUserId = this.resolveUserId(userId);
    await this.vaultService.deleteSecret(this.getCredentialVaultPath(effectiveUserId));
    return {
      userId: effectiveUserId,
      deleted: true
    };
  }

  async getCredentialMetadata(userId) {
    const effectiveUserId = this.resolveUserId(userId);
    const secret = await this.getCredentialSecret(effectiveUserId);

    return {
      userId: effectiveUserId,
      vaultPath: this.getCredentialVaultPath(effectiveUserId),
      configured: Boolean(secret?.apiKey && secret?.applicationKey),
      apiKeyConfigured: Boolean(secret?.apiKey),
      applicationKeyConfigured: Boolean(secret?.applicationKey),
      site: normalizeSite(secret?.site),
      updatedAt: secret?.updatedAt ?? null
    };
  }

  async getUserConfig(key, userId) {
    const effectiveUserId = this.resolveUserId(userId);
    return await this.configStore.getConfig(key, effectiveUserId);
  }

  async listUserConfigs(prefix, userId) {
    const effectiveUserId = this.resolveUserId(userId);
    return await this.configStore.listConfigs(prefix, effectiveUserId);
  }

  async setUserConfig(key, value, userId) {
    const effectiveUserId = this.resolveUserId(userId);
    return await this.configStore.setConfig(key, value, effectiveUserId);
  }

  async deleteUserConfig(key, userId) {
    const effectiveUserId = this.resolveUserId(userId);
    return await this.configStore.deleteConfig(key, effectiveUserId);
  }

  async resolveExecutionConfig(userId) {
    const effectiveUserId = this.resolveUserId(userId);
    const credentialSecret = await this.getCredentialSecret(effectiveUserId);

    if (!credentialSecret?.apiKey) {
      throw new Error(`Datadog API key is not configured for userId=${effectiveUserId}`);
    }

    if (!credentialSecret?.applicationKey) {
      throw new Error(`Datadog application key is not configured for userId=${effectiveUserId}`);
    }

    const siteConfig = await this.configStore.getConfig("datadog.site", effectiveUserId);
    const timeoutConfig = await this.configStore.getConfig("datadog.timeoutMs", effectiveUserId);

    return {
      userId: effectiveUserId,
      apiKey: credentialSecret.apiKey,
      applicationKey: credentialSecret.applicationKey,
      site: normalizeSite(siteConfig?.value ?? credentialSecret.site),
      timeoutMs: normalizeHttpTimeout(timeoutConfig?.value, 15000)
    };
  }

  createDatadogClientContext({ userId }) {
    return this.resolveExecutionConfig(userId).then((resolved) => {
      const configuration = client.createConfiguration({
        authMethods: {
          apiKeyAuth: resolved.apiKey,
          appKeyAuth: resolved.applicationKey
        },
        httpConfig: {
          timeout: resolved.timeoutMs
        }
      });

      configuration.setServerVariables({ site: resolved.site });

      return {
        userId: resolved.userId,
        site: resolved.site,
        timeoutMs: resolved.timeoutMs,
        configuration
      };
    });
  }

  listOperations(filters = {}) {
    return this.operationIndex.list(filters);
  }

  getOperation(operationId) {
    return this.operationIndex.get(operationId);
  }

  async invokeOperation({ userId, operationId, params = {}, enableUnstable = true }) {
    const operation = this.getOperation(operationId);
    if (!operation) {
      throw new Error(`Unknown Datadog operationId: ${operationId}`);
    }

    const datadogContext = await this.createDatadogClientContext({ userId });
    const moduleRef = DATADOG_MODULES[operation.version];
    if (!moduleRef) {
      throw new Error(`Unsupported Datadog API version: ${operation.version}`);
    }

    const apiClassName = normalizeApiClass(moduleRef, operation.apiClass);
    if (!apiClassName) {
      throw new Error(`Datadog API class is not available: ${operation.apiClass}`);
    }

    if (operation.unstable && operation.unstableOperationKey && enableUnstable) {
      datadogContext.configuration.unstableOperations[operation.unstableOperationKey] = true;
    }

    const ApiCtor = moduleRef[apiClassName];
    const apiInstance = new ApiCtor(datadogContext.configuration);

    if (typeof apiInstance[operation.methodName] !== "function") {
      throw new Error(`Datadog API method is not available: ${operation.methodName}`);
    }

    const method = apiInstance[operation.methodName].bind(apiInstance);
    const hasParams = params && Object.keys(params).length > 0;
    const response = hasParams ? await method(params) : await method();

    return {
      operationId: operation.operationId,
      version: operation.version,
      apiClass: operation.apiClass,
      methodName: operation.methodName,
      httpMethod: operation.httpMethod,
      pathTemplate: operation.pathTemplate,
      mutating: operation.mutating,
      unstable: operation.unstable,
      unstableOperationKey: operation.unstableOperationKey,
      userId: datadogContext.userId,
      site: datadogContext.site,
      response
    };
  }
}
