const DEFAULT_TIMEOUT_MS = 15000;

function joinUrl(baseUrl, path, query) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(normalizedPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function parseResponseBody(contentType, text) {
  if (!text) {
    return null;
  }

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

export class TargetServiceClient {
  constructor({
    baseUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    authMode = "none",
    bearerToken = "",
    basicUsername = "",
    basicPassword = ""
  }) {
    this.baseUrl = String(baseUrl ?? "http://127.0.0.1:4000").trim();
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.authMode = String(authMode ?? "none").toLowerCase();
    this.bearerToken = String(bearerToken ?? "").trim();
    this.basicUsername = String(basicUsername ?? "").trim();
    this.basicPassword = String(basicPassword ?? "");

    if (!["none", "bearer", "basic"].includes(this.authMode)) {
      throw new Error("TARGET_SERVICE_AUTH_MODE must be one of: none, bearer, basic");
    }

    if (this.authMode === "bearer" && !this.bearerToken) {
      throw new Error("TARGET_SERVICE_BEARER_TOKEN is required when TARGET_SERVICE_AUTH_MODE=bearer");
    }

    if (this.authMode === "basic" && !this.basicUsername) {
      throw new Error("TARGET_SERVICE_BASIC_USERNAME is required when TARGET_SERVICE_AUTH_MODE=basic");
    }
  }

  getConnectionInfo() {
    return {
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      authMode: this.authMode,
      bearerTokenConfigured: Boolean(this.bearerToken),
      basicUsernameConfigured: Boolean(this.basicUsername),
      basicPasswordConfigured: Boolean(this.basicPassword)
    };
  }

  listKnownEndpoints() {
    return [
      { method: "GET", path: "/health_check", description: "Target service health endpoint" },
      { method: "PUT", path: "/api/car/:id/logging/suspend", description: "Suspend logging for resource id" },
      { method: "PUT", path: "/api/car/:id/logging/resume", description: "Resume logging for resource id" },
      { method: "GET", path: "/drive/:id/gpx", description: "Export a drive as GPX" }
    ];
  }

  async request({ method = "GET", path = "/", query, body, headers = {} }) {
    const upperMethod = String(method).toUpperCase();
    const url = joinUrl(this.baseUrl, path, query);
    const requestHeaders = {
      Accept: "application/json, text/plain, text/html, application/xml, text/xml",
      ...headers
    };

    if (this.authMode === "bearer") {
      requestHeaders.Authorization = `Bearer ${this.bearerToken}`;
    }

    if (this.authMode === "basic") {
      const credential = Buffer.from(`${this.basicUsername}:${this.basicPassword}`).toString("base64");
      requestHeaders.Authorization = `Basic ${credential}`;
    }

    let payload;
    if (body !== undefined && body !== null && upperMethod !== "GET") {
      if (typeof body === "string") {
        payload = body;
      } else {
        payload = JSON.stringify(body);
        if (!requestHeaders["Content-Type"] && !requestHeaders["content-type"]) {
          requestHeaders["Content-Type"] = "application/json";
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: upperMethod,
        headers: requestHeaders,
        body: payload,
        signal: controller.signal
      });

      const text = await response.text();
      const contentType = String(response.headers.get("content-type") ?? "");
      const parsed = parseResponseBody(contentType, text);

      if (!response.ok) {
        const error = new Error(`Target service request failed: ${upperMethod} ${url.pathname} -> ${response.status}`);
        error.status = response.status;
        error.response = parsed;
        throw error;
      }

      return {
        method: upperMethod,
        path: url.pathname,
        url: url.toString(),
        status: response.status,
        contentType,
        data: parsed
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async healthCheck() {
    return this.request({ method: "GET", path: "/health_check" });
  }

  async suspendLogging(resourceId) {
    return this.request({ method: "PUT", path: `/api/car/${resourceId}/logging/suspend` });
  }

  async resumeLogging(resourceId) {
    return this.request({ method: "PUT", path: `/api/car/${resourceId}/logging/resume` });
  }

  async getDriveGpx(driveId) {
    return this.request({ method: "GET", path: `/drive/${driveId}/gpx` });
  }
}
