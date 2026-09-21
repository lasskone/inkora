import "server-only";

import { CJ_TOKEN_HEADER, type CjConfig } from "./config";
import { CjApiError, CjAuthError } from "./errors";
import { getCjAccessToken, invalidateCjAccessToken } from "./oauth";
import type {
  CjEnvelope,
  CjProductListData,
  CjVariantInventory,
  CjWarehouseInventory,
} from "./types";

/**
 * Minimal client for the subset of the official CJ API 2.0 this slice needs.
 *
 *   GET /v1/product/listV2           — keyword product search (Elasticsearch)
 *   GET /v1/product/stock/queryBySku — inventory by SKU, per warehouse
 *
 * This layer talks raw HTTP and returns the raw (typed-subset) payload. It
 * performs **no** normalization — mapping into Inkora's model is the adapter's
 * responsibility, so CJ specifics stay behind this boundary.
 */

const SEARCH_PATH = "/v1/product/listV2";
const INVENTORY_BY_SKU_PATH = "/v1/product/stock/queryBySku";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 4_000;

/** CJ's published page-size ceiling for listV2. */
export const CJ_MAX_PAGE_SIZE = 100;

export interface CjSearchOptions {
  readonly query: string;
  /** CJ `page` is 1-based. */
  readonly page: number;
  readonly size: number;
}

/**
 * Calls the official CJ product search with bounded retries.
 *
 * Resilience policy (proportionate, per docs/API_INTEGRATIONS.md §1):
 * - explicit per-request timeout, so a hung upstream never stalls a request;
 * - exponential backoff with jitter for transient failures (network errors,
 *   HTTP 429, HTTP 5xx), honoring `Retry-After` when CJ sends it;
 * - a rejected/aged cached token triggers exactly one re-authentication;
 * - CJ reports logical failures as HTTP 200 + `result: false`; those are
 *   surfaced as non-retryable errors carrying CJ's numeric `code`;
 * - malformed JSON is rejected rather than silently treated as "no results".
 */
export async function searchCjProducts(
  config: CjConfig,
  options: CjSearchOptions,
): Promise<CjProductListData> {
  const params = new URLSearchParams({
    keyWord: options.query,
    page: String(options.page),
    size: String(options.size),
  });
  const url = `${config.baseUrl}${SEARCH_PATH}?${params.toString()}`;

  return requestWithRetry<CjProductListData>(config, url);
}

/**
 * Queries per-warehouse inventory for a single SKU — the narrow, additional
 * official endpoint used to establish warehouse country (incl. US stock) for a
 * selected product. See docs/API_INTEGRATIONS.md §3.
 */
export async function queryCjInventoryBySku(
  config: CjConfig,
  sku: string,
): Promise<CjWarehouseInventory[]> {
  const url = `${config.baseUrl}${INVENTORY_BY_SKU_PATH}?${new URLSearchParams({ sku }).toString()}`;
  const data = await requestWithRetry<unknown>(config, url);
  return extractWarehouseRows(data);
}

async function requestWithRetry<T>(config: CjConfig, url: string): Promise<T> {
  let attempt = 0;
  // Guards stale-token recovery so one call re-authenticates at most once.
  let reauthenticated = false;

  while (true) {
    const accessToken = await getCjAccessToken();

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          [CJ_TOKEN_HEADER]: accessToken,
          Accept: "application/json",
        },
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

/**
 * CJ's inventory endpoints answer with one of several documented shapes
 * depending on the endpoint and version — a bare array of warehouse rows, an
 * object of `inventories`, or variant-grouped `variantInventories`. All are
 * accepted here; an unrecognized shape yields an empty array, which the caller
 * honestly reports as inventory UNKNOWN rather than guessing a quantity.
 */
function extractWarehouseRows(data: unknown): CjWarehouseInventory[] {
  if (Array.isArray(data)) {
    return data.filter((row): row is CjWarehouseInventory => isObjectRow(row));
  }

  if (data !== null && typeof data === "object") {
    const value = data as Record<string, unknown>;

    if (Array.isArray(value.inventories)) {
      return value.inventories.filter(
        (row): row is CjWarehouseInventory => isObjectRow(row),
      );
    }

    if (Array.isArray(value.variantInventories)) {
      return (value.variantInventories as CjVariantInventory[])
        .flatMap((variant) =>
          Array.isArray(variant.inventory) ? variant.inventory : [],
        )
        .filter((row): row is CjWarehouseInventory => isObjectRow(row));
    }
  }

  return [];
}

function isObjectRow(value: unknown): boolean {
  return value !== null && typeof value === "object";
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
