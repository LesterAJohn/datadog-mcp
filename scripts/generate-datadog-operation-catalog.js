import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DIST_ROOT = path.join(ROOT, "node_modules", "@datadog", "datadog-api-client", "dist", "packages");
const OUTPUT = path.join(ROOT, "src", "data", "datadog-operation-catalog.json");
const VERSIONS = ["v1", "v2"];
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function extractRequestFactoryMethods(jsText) {
  const methods = new Map();
  const classStart = jsText.indexOf("class ");
  if (classStart < 0) {
    return methods;
  }

  const requestFactoryIndex = jsText.indexOf("RequestFactory", classStart);
  if (requestFactoryIndex < 0) {
    return methods;
  }

  const classBodyStart = jsText.indexOf("{", requestFactoryIndex);
  if (classBodyStart < 0) {
    return methods;
  }

  const classBodyEnd = jsText.indexOf("exports.", classBodyStart);
  const classText = classBodyEnd > classBodyStart ? jsText.slice(classBodyStart, classBodyEnd) : jsText.slice(classBodyStart);

  const methodRegex = /\n\s{4}([a-zA-Z0-9_]+)\(([^)]*)\)\s*\{([\s\S]*?)\n\s{4}\}/g;
  let match;
  while ((match = methodRegex.exec(classText)) !== null) {
    const methodName = match[1];
    const body = match[3];

    const pathMatch = body.match(/const localVarPath = ([^;]+);/);
    const methodMatch = body.match(/makeRequestContext\(localVarPath,\s*http_1\.HttpMethod\.([A-Z]+)\)/);
    const unstableMatch = body.match(/unstableOperations\["([^"]+)"\]/);

    const requiredParameters = [];
    const requiredRegex = /if \(([a-zA-Z0-9_]+) === null \|\| \1 === undefined\)/g;
    let requiredMatch;
    while ((requiredMatch = requiredRegex.exec(body)) !== null) {
      requiredParameters.push(requiredMatch[1]);
    }

    let pathTemplate = null;
    if (pathMatch) {
      const expr = pathMatch[1].trim();
      const quoted = expr.match(/"([^"]+)"/);
      pathTemplate = quoted ? quoted[1] : expr;
    }

    methods.set(methodName, {
      httpMethod: methodMatch ? methodMatch[1] : null,
      pathTemplate,
      unstableOperationKey: unstableMatch ? unstableMatch[1] : null,
      requiredParameters
    });
  }

  return methods;
}

function parseRequestInterfaces(dtsText) {
  const interfaces = new Map();
  const regex = /export interface ([A-Za-z0-9_]+)\s*\{([\s\S]*?)\n\}/g;
  let match;
  while ((match = regex.exec(dtsText)) !== null) {
    const interfaceName = match[1];
    const body = match[2];
    const fields = [];

    const fieldRegex = /\n\s*([a-zA-Z0-9_]+)(\?)?:\s*([^;]+);/g;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      fields.push({
        name: fieldMatch[1],
        required: fieldMatch[2] !== "?",
        type: fieldMatch[3].trim()
      });
    }

    interfaces.set(interfaceName, fields);
  }

  return interfaces;
}

function parseApiMethodMetadata(dtsText) {
  const summaries = new Map();

  const classMatch = dtsText.match(/export declare class [A-Za-z0-9_]+Api \{([\s\S]*)\n\}/);
  if (!classMatch) {
    return summaries;
  }

  const classBody = classMatch[1];
  const regex = /\/\*\*([\s\S]*?)\*\/\s*([a-zA-Z0-9_]+)\(([^)]*)\):\s*Promise<([^>]+)>;/g;
  let match;
  while ((match = regex.exec(classBody)) !== null) {
    const comment = match[1];
    const methodName = match[2];
    const signatureParams = match[3];
    const returnType = match[4].trim();

    const lines = comment
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter((line) => line && !line.startsWith("@"));

    const summary = lines[0] ?? "";

    const requestTypeMatch = signatureParams.match(/param\??:\s*([A-Za-z0-9_]+)/);
    summaries.set(methodName, {
      summary,
      returnType,
      requestType: requestTypeMatch ? requestTypeMatch[1] : null,
      signature: signatureParams.trim()
    });
  }

  return summaries;
}

async function buildForVersion(version) {
  const apiDir = path.join(DIST_ROOT, `datadog-api-client-${version}`, "apis");
  const files = await readdir(apiDir);
  const results = [];

  for (const fileName of files) {
    if (!fileName.endsWith("Api.d.ts")) {
      continue;
    }

    const apiClass = fileName.replace(/\.d\.ts$/, "");
    const dtsPath = path.join(apiDir, fileName);
    const jsPath = path.join(apiDir, fileName.replace(/\.d\.ts$/, ".js"));

    const [dtsText, jsText] = await Promise.all([readFile(dtsPath, "utf8"), readFile(jsPath, "utf8")]);
    const requestFactoryMethods = extractRequestFactoryMethods(jsText);
    const requestInterfaces = parseRequestInterfaces(dtsText);
    const apiMethodMeta = parseApiMethodMetadata(dtsText);

    for (const [methodName, methodMeta] of apiMethodMeta.entries()) {
      const requestShape = methodMeta.requestType ? requestInterfaces.get(methodMeta.requestType) ?? [] : [];
      const transportMeta = requestFactoryMethods.get(methodName) ?? {};
      const httpMethod = transportMeta.httpMethod ?? "GET";

      results.push({
        operationId: `${version}.${apiClass}.${methodName}`,
        version,
        apiClass,
        methodName,
        httpMethod,
        pathTemplate: transportMeta.pathTemplate ?? null,
        unstableOperationKey: transportMeta.unstableOperationKey ?? null,
        unstable: Boolean(transportMeta.unstableOperationKey),
        mutating: MUTATING.has(httpMethod),
        requestType: methodMeta.requestType,
        requestShape,
        requiredParameters: transportMeta.requiredParameters ?? [],
        summary: methodMeta.summary,
        returnType: methodMeta.returnType
      });
    }
  }

  return results;
}

async function main() {
  const allOperations = [];

  for (const version of VERSIONS) {
    const entries = await buildForVersion(version);
    allOperations.push(...entries);
  }

  allOperations.sort((a, b) => a.operationId.localeCompare(b.operationId));

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "@datadog/datadog-api-client",
    versions: VERSIONS,
    count: allOperations.length,
    operations: allOperations
  };

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`Generated ${allOperations.length} operations into ${OUTPUT}`);
}

main().catch((error) => {
  console.error("Failed to generate Datadog operation catalog", error);
  process.exit(1);
});
