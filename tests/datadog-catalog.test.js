import assert from "node:assert/strict";
import test from "node:test";

import { createDatadogOperationIndex, getDatadogCatalog } from "../src/services/datadogApiCatalog.js";

test("datadog operation catalog is generated and includes both API versions", () => {
  const catalog = getDatadogCatalog();

  assert.equal(Array.isArray(catalog.operations), true);
  assert.equal(catalog.versions.includes("v1"), true);
  assert.equal(catalog.versions.includes("v2"), true);
  assert.equal(catalog.count > 1000, true);
});

test("operation index resolves known operation", () => {
  const index = createDatadogOperationIndex();

  const operation = index.get("v1.AuthenticationApi.validate");
  assert.ok(operation);
  assert.equal(operation.httpMethod, "GET");
  assert.equal(operation.mutating, false);
});
