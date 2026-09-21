import "server-only";

import type { EbayConfig } from "./config";
import { EbayApiError, EbayAuthError } from "./errors";
import {
  getEbayApplicationAccessToken,
  invalidateEbayAccessToken,
} from "./oauth";
import type { EbaySearchPagedCollection } from "./types";

/**
 * Minimal client for the official eBay Browse API search method:
 *
 *   GET {baseUrl}/buy/browse/v1/item_summary/search
 *
 * This layer talks raw HTTP and returns the raw (typed-subset) collection. It
 * performs **no** normalization — mapping into Inkora's model is the adapter's
 * responsibility, so eBay specifics stay behind this boundary.
 */

const SEARCH_PATH = "/buy/browse/v1/item_summary/search";
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 4_000;

export interface EbaySearchOptions {
  readonly query: string;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Calls the official Browse API `item_summary/search` with bounded retries.
 *
 * Resilience policy (proportionate, per docs/API_INTEGRATIONS.md §1):
 * - explicit per-request timeout, so a hung upstream never stalls a request;
 * - exponential backoff with jitter for transient failures (network errors,
 *   HTTP 429, HTTP 5xx), honoring `Retry-After` when eBay sends it;
 * - a stale cached token triggers exactly one re-authentication on HTTP 401;
 * - HTTP 4xx (other than 401/429) is not retried;
 * - malformed JSON is rejected rather than silently treated as "no results".
 */
export async function searchEbayItemSummaries(
  config: EbayConfig,
  options: EbaySearchOptions,
): Promise<EbaySearchPagedCollection> {
  const params = new URLSearchParams({
    q: options.query,
    limit: String(options.limit),
    offset: String(options.offset),
  });
  const url = `${config.baseUrl}${SEARCH_PATH}?${params.toString()}`;

  let attempt = 0;
  // Guards the stale-token recovery so a single search re-authenticates at most
  // once before failing.
  let reauthenticated = false;

  while (true) {
    const accessToken = await getEbayApplicationAccessToken();

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "X-EBAY-C-MARKETPLACE-ID": config.marketplaceId,
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleepWithBackoff(attempt, null);
        attempt += 1;
        continue;
      }
      // Timeouts and network failures collapse to a single retryable error.
      throw new EbayApiError("eBay search request did not complete.", {
        retryable: false,
      });
    }

    // A cached token that eBay considers stale: drop it, mint a fresh one, and
    // retry the search exactly once.
    if (response.status === 401 && !reauthenticated) {
      invalidateEbayAccessToken();
      reauthenticated = true;
      continue;
    }

    if (response.status === 401) {
      throw new EbayAuthError(
        "eBay rejected the application access token after re-authentication.",
      );
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        await sleepWithBackoff(attempt, response.headers.get("Retry-After"));
        attempt += 1;
        continue;
      }
      throw new EbayApiError(
        response.status === 429
          ? "eBay rate limit reached for this application."
          : `eBay returned an upstream error (HTTP ${response.status}).`,
        { status: response.status, retryable: true },
      );
    }

    if (!response.ok) {
      // Non-retryable client-side rejection. The upstream body is deliberately
      // not forwarded anywhere.
      throw new EbayApiError(
        `eBay rejected the search request (HTTP ${response.status}).`,
        { status: response.status, retryable: false },
      );
    }

    const payload = await readJsonSafe(response);
    if (payload === null) {
      throw new EbayApiError("eBay returned a malformed search response.", {
        retryable: false,
      });
    }
    return payload;
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

async function readJsonSafe(
  response: Response,
): Promise<EbaySearchPagedCollection | null> {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as EbaySearchPagedCollection;
  } catch {
    return null;
  }
}
