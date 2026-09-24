import "server-only";

import type { EbayConfig } from "./config";
import { EbayApiError, EbayAuthError } from "./errors";
import {
  getEbayApplicationAccessToken,
  invalidateEbayAccessToken,
} from "./oauth";
import type {
  EbayApiWarning,
  EbaySellerSearchPagedCollection,
  EbaySellerSort,
} from "./types";

/**
 * Seller-scoped search against the official eBay Browse API:
 *
 *   GET {baseUrl}/buy/browse/v1/item_summary/search
 *       ?q=<context>&filter=sellers:{<handle>}&limit=<n>&offset=<n>&sort=newlyListed
 *
 * The `sellers` filter requires braces around the handle and must be paired with
 * a search context (a `q`, `category_ids`, `gtin` or `epid`); without one eBay
 * answers HTTP 400. Both facts were established against the live production API
 * before this module was written, as was the failure mode that makes `warnings`
 * unignorable (see `EbaySellerSearchPagedCollection`).
 *
 * Shares the plain search's resilience policy: explicit timeout, bounded
 * exponential backoff with jitter on transient failures, exactly one
 * re-authentication on a stale-token 401, no retry for other 4xx, and malformed
 * JSON rejected rather than treated as "no results".
 */

const SELLER_SEARCH_PATH = "/buy/browse/v1/item_summary/search";
const SELLER_SEARCH_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 4_000;

export interface EbaySellerSearchOptions {
  /** The search context that scopes which of a seller's listings are enumerable. */
  readonly query: string;
  /** The normalized seller handle the filter is scoped to. */
  readonly sellerHandle: string;
  readonly limit: number;
  readonly offset: number;
  readonly sort?: EbaySellerSort;
}

/**
 * Calls the seller-scoped Browse API search with bounded retries.
 *
 * Throws only on a genuinely unusable response; a seller with no matching
 * listings resolves to an empty collection, which is a verdict, not an error.
 */
export async function searchEbaySellerListings(
  config: EbayConfig,
  options: EbaySellerSearchOptions,
): Promise<EbaySellerSearchPagedCollection> {
  const params = new URLSearchParams({
    q: options.query,
    limit: String(options.limit),
    offset: String(options.offset),
    filter: `sellers:{${options.sellerHandle}}`,
  });
  if (options.sort !== undefined) {
    params.set("sort", options.sort);
  }

  const url = `${config.baseUrl}${SELLER_SEARCH_PATH}?${params.toString()}`;

  let attempt = 0;
  // Guards the stale-token recovery so one search re-authenticates at most once.
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
        signal: AbortSignal.timeout(SELLER_SEARCH_TIMEOUT_MS),
      });
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleepWithBackoff(attempt, null);
        attempt += 1;
        continue;
      }
      // Timeouts and network failures collapse to one retryable error.
      throw new EbayApiError("eBay seller search did not complete.", {
        retryable: false,
      });
    }

    // A cached token eBay considers stale: drop it, mint a fresh one, retry once.
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
      // Non-retryable client-side rejection; the upstream body is never forwarded.
      throw new EbayApiError(
        `eBay rejected the seller search request (HTTP ${response.status}).`,
        { status: response.status, retryable: false },
      );
    }

    const payload = await readJsonSafe(response);
    if (payload === null) {
      throw new EbayApiError("eBay returned a malformed seller search response.", {
        retryable: false,
      });
    }
    return payload;
  }
}

/**
 * True when eBay's warnings object to the seller filter itself — the signal that
 * the response may be an *unfiltered* result set rather than the seller's.
 */
export function sellerFilterRejected(
  collection: EbaySellerSearchPagedCollection,
): boolean {
  return sellerFilterWarnings(collection).length > 0;
}

/** The warning messages that concern the seller filter specifically. */
export function sellerFilterWarnings(
  collection: EbaySellerSearchPagedCollection,
): string[] {
  if (!Array.isArray(collection.warnings)) return [];
  return collection.warnings
    .filter((warning: EbayApiWarning) => {
      const field = warning.parameters?.find(
        (parameter) => parameter.name === "fieldName",
      );
      return (
        warning.message?.toLowerCase().includes("seller") ??
        field?.value === "sellers"
      );
    })
    .map((warning) => warning.message ?? "Unspecified eBay seller filter warning.")
    .filter((message) => message.length > 0);
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
  // Cap even an explicit Retry-After so one slow upstream cannot stall a call
  // far beyond its own budget.
  return Math.min(seconds * 1000, BACKOFF_MAX_MS);
}

async function readJsonSafe(
  response: Response,
): Promise<EbaySellerSearchPagedCollection | null> {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as EbaySellerSearchPagedCollection;
  } catch {
    return null;
  }
}