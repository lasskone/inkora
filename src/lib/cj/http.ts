import "server-only";

import { CJ_TOKEN_HEADER, type CjConfig } from "./config";
import { CjApiError, CjAuthError } from "./errors";
import { getCjAccessToken, invalidateCjAccessToken } from "./oauth";
import type { CjEnvelope } from "./types";

/**
 * Shared authenticated transport for the CJ API 2.0 gateway.
 *
 * One place owns the request/retry/envelope discipline so every CJ endpoint
 * Inkora calls — search, inventory, variant detail, freight — behaves
 * identically: explicit timeout, exponential backoff with jitter for transient
 * failures, a single re-authentication on a rejected token, and CJ's logical
 * failures (HTTP 200 + `result: false`) surfaced as errors carrying CJ's stable
 * numeric `code`. Malformed JSON is an error, never silent "no results".
 *
 * Nothing here logs or returns a credential or token (see
 * docs/API_INTEGRATIONS.md §1 and §3.5).
 */

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 4_000;

/** Authenticated GET returning the envelope's `data` (or `{}` when absent). */
export async function cjGet<T>(config: CjConfig, url: string): Promise<T> {
  void config;
  return requestWithRetry<T>(url, { method: "GET" });
}

/** Authenticated POST with a JSON body, returning the envelope's `data`. */
export async function cjPost<T>(
  config: CjConfig,
  path: string,
  body: unknown,
): Promise<T> {
  void config;
  return requestWithRetry<T>(`${config.baseUrl}${path}`, {
    method: "POST",
    body,
  });
}

async function requestWithRetry<T>(
  url: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  let attempt = 0;
  // Guards stale-token recovery so one call re-authenticates at most once.
  let reauthenticated = false;

  while (true) {
    const accessToken = await getCjAccessToken();

    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers: {
          [CJ_TOKEN_HEADER]: accessToken,
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleepWithBackoff(attempt, null);
        attempt += 1;
        continue;
      }
      throw new CjApiError("CJ request did not complete.", { retryable: false });
    }

    // A cached token CJ considers stale: drop it, re-authenticate, retry once.
    if (response.status === 401 && !reauthenticated) {
      invalidateCjAccessToken();
      reauthenticated = true;
      continue;
    }
    if (response.status === 401) {
      throw new CjAuthError(
        "CJ rejected the access token after re-authentication.",
      );
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        await sleepWithBackoff(attempt, response.headers.get("Retry-After"));
        attempt += 1;
        continue;
      }
      throw new CjApiError(
        response.status === 429
          ? "CJ rate limit reached for this application."
          : `CJ returned an upstream error (HTTP ${response.status}).`,
        { status: response.status, retryable: true },
      );
    }

    if (!response.ok) {
      // Non-retryable client-side rejection. The upstream body is deliberately
      // not forwarded anywhere.
      throw new CjApiError(`CJ rejected the request (HTTP ${response.status}).`, {
        status: response.status,
        retryable: false,
      });
    }

    const envelope = await readJsonSafe<CjEnvelope<T>>(response);
    if (envelope === null) {
      throw new CjApiError("CJ returned a malformed response.", {
        retryable: false,
      });
    }

    // CJ answers HTTP 200 with `result: false` for logical failures.
    if (envelope.result === false) {
      throw new CjApiError(
        `CJ rejected the request${typeof envelope.code === "number" ? ` (code: ${envelope.code})` : ""}.`,
        {
          status: 200,
          cjCode: typeof envelope.code === "number" ? envelope.code : undefined,
          retryable: false,
        },
      );
    }

    if (envelope.pointsInfo && typeof envelope.pointsInfo.remaining === "number") {
      // A quota counter is a safe, secret-free operational signal.
      console.debug(`[cj] call quota remaining: ${envelope.pointsInfo.remaining}`);
    }

    return (envelope.data as T) ?? ({} as T);
  }
}

async function sleepWithBackoff(
  attempt: number,
  retryAfter: string | null,
): Promise<void> {
  const retryAfterMs = parseRetryAfter(retryAfter);
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  const jitter = Math.random() * (BACKOFF_BASE_MS / 2);
  const delay = retryAfterMs ?? Math.min(exponential + jitter, BACKOFF_MAX_MS);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function parseRetryAfter(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const seconds = Number(retryAfter.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // Cap even an explicit Retry-After, so one slow upstream cannot stall a
  // request far beyond the call's own budget.
  return Math.min(seconds * 1000, BACKOFF_MAX_MS);
}

async function readJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    if (text.length === 0) return null;
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as T;
  } catch {
    return null;
  }
}
