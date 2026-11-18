// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OllamaEndpoint = "/web_search" | "/web_fetch";

export type FailureKind =
  | "ok"
  | "quota_exhausted"
  | "bad_success_body"
  | "auth_failed"
  | "forbidden"
  | "payment_required"
  | "target_unfetchable"
  | "rate_limited"
  | "transient"
  | "client_error";

export type Classification = {
  kind: FailureKind;
  retryable: boolean;
  resolution: string;
  requestId?: string;
  data?: unknown;
  maxRetries?: number;
};

export type ClassifyOptions = {
  requestId?: string;
  targetUrl?: string;
};

const MAX_RETRY_DELAY_MS = 30_000;
const JITTER_BASE_MS = 500;
const OLLAMA_SETTINGS_URL = "https://ollama.com/settings";
const OLLAMA_KEYS_URL = "https://ollama.com/settings/keys";
const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function readErrorString(bodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {
    // non-JSON error bodies are a documented Ollama variant
  }
  return undefined;
}

function withRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (request-id: ${requestId})` : message;
}

export function classify(
  endpoint: OllamaEndpoint,
  status: number,
  contentTypeHeader: string | null,
  contentLengthHeader: string | null,
  bodyText: string,
  options: ClassifyOptions = {}
): Classification {
  const requestId = options.requestId;

  if (status === 200) {
    if (contentLengthHeader === "0" || bodyText.trim() === "") {
      return {
        kind: "quota_exhausted",
        retryable: false,
        resolution: `Ollama usage/quota exhausted (200 with empty body). Check ${OLLAMA_SETTINGS_URL} + GET /api/usage and /api/balance${requestId ? `; request-id: ${requestId}` : ""}`,
        requestId,
      };
    }

    const declaredType = contentTypeHeader?.toLowerCase() ?? "";
    if (declaredType !== "" && !declaredType.includes("json")) {
      return {
        kind: "bad_success_body",
        retryable: true,
        maxRetries: 1,
        resolution: withRequestId(
          "Ollama API returned 200 with a non-JSON body (possible usage limit — check /api/usage). Retried once; the failure persisted.",
          requestId
        ),
        requestId,
      };
    }

    try {
      const data: unknown = JSON.parse(bodyText);
      return { kind: "ok", retryable: false, resolution: "", data, requestId };
    } catch {
      return {
        kind: "bad_success_body",
        retryable: true,
        maxRetries: 1,
        resolution: withRequestId(
          "Ollama API returned 200 with an unparseable body (possible usage limit — check /api/usage). Retried once; the failure persisted.",
          requestId
        ),
        requestId,
      };
    }
  }

  const bodyError = readErrorString(bodyText);
  const detail = bodyError ? `: ${bodyError}` : "";

  if (status === 401) {
    return {
      kind: "auth_failed",
      retryable: false,
      resolution: withRequestId(
        `Ollama auth failed (401) — OLLAMA_API_KEY is invalid or revoked; regenerate at ${OLLAMA_KEYS_URL}`,
        requestId
      ),
      requestId,
    };
  }

  if (status === 403) {
    return {
      kind: "forbidden",
      retryable: false,
      resolution: withRequestId(
        "Ollama account suspended or cloud-backed web search disabled (403).",
        requestId
      ),
      requestId,
    };
  }

  if (status === 402) {
    return {
      kind: "payment_required",
      retryable: false,
      resolution: withRequestId(
        "Ollama plan/credits exhausted (402) — add usage credits or upgrade.",
        requestId
      ),
      requestId,
    };
  }

  if (endpoint === "/web_fetch" && bodyError === "not found") {
    return {
      kind: "target_unfetchable",
      retryable: false,
      resolution: withRequestId(
        `Target page could not be fetched (blocked or removed upstream) — this does not mean the URL is invalid: ${options.targetUrl ?? "(url unavailable)"}`,
        requestId
      ),
      requestId,
    };
  }

  if (status === 429) {
    return {
      kind: "rate_limited",
      retryable: true,
      resolution: withRequestId(
        "Ollama API rate limited (429) — Free tier allows one concurrent request; retry later or raise limits on your plan.",
        requestId
      ),
      requestId,
    };
  }

  if (status === 0 || TRANSIENT_STATUSES.has(status)) {
    return {
      kind: "transient",
      retryable: true,
      resolution: withRequestId(
        status === 0
          ? `Ollama API request failed before a response (${bodyError ?? "network error or timeout"}).`
          : `Ollama API transient failure (HTTP ${status})${detail}`,
        requestId
      ),
      requestId,
    };
  }

  return {
    kind: "client_error",
    retryable: false,
    resolution: withRequestId(
      `Ollama API rejected the request (HTTP ${status})${detail}`,
      requestId
    ),
    requestId,
  };
}

// ---------------------------------------------------------------------------
// Retry delay
// ---------------------------------------------------------------------------

function clampDelay(ms: number): number {
  return Math.min(Math.max(0, ms), MAX_RETRY_DELAY_MS);
}

export function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null
): number {
  const header = retryAfterHeader?.trim();
  if (header) {
    if (/^\d+$/.test(header)) {
      return clampDelay(Number(header) * 1000);
    }
    const timestamp = Date.parse(header);
    if (!Number.isNaN(timestamp)) {
      return clampDelay(timestamp - Date.now());
    }
  }
  const window = Math.min(MAX_RETRY_DELAY_MS, JITTER_BASE_MS * 2 ** attempt);
  return Math.random() * window;
}
