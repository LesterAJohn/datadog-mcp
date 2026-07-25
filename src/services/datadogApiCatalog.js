import { readFileSync } from "node:fs";

const catalog = JSON.parse(
  readFileSync(new URL("../data/datadog-operation-catalog.json", import.meta.url), "utf8")
);

export function getDatadogCatalog() {
  return catalog;
}

export function createDatadogOperationIndex() {
  const byId = new Map();
  const byVersion = new Map();

  for (const operation of catalog.operations) {
    byId.set(operation.operationId, operation);

    if (!byVersion.has(operation.version)) {
      byVersion.set(operation.version, []);
    }

    byVersion.get(operation.version).push(operation);
  }

  return {
    generatedAt: catalog.generatedAt,
    count: catalog.count,
    versions: catalog.versions,
    operations: catalog.operations,
    get(operationId) {
      return byId.get(operationId) ?? null;
    },
    list({ version, apiClass, mutating, unstable, limit = 200 } = {}) {
      let entries = catalog.operations;

      if (version) {
        entries = byVersion.get(version) ?? [];
      }

      if (apiClass) {
        const target = String(apiClass).trim().toLowerCase();
        entries = entries.filter((entry) => entry.apiClass.toLowerCase() === target);
      }

      if (typeof mutating === "boolean") {
        entries = entries.filter((entry) => entry.mutating === mutating);
      }

      if (typeof unstable === "boolean") {
        entries = entries.filter((entry) => entry.unstable === unstable);
      }

      return entries.slice(0, Math.max(1, Number(limit) || 200));
    }
  };
}
