/**
 * Shared HTTP-boundary helpers for the Seller Scanner route
 * (docs/ARCHITECTURE.md §17, docs/API_INTEGRATIONS.md §2).
 *
 * The route validates once here, reports errors one way here, and gates on
 * configuration here, so those rules live in one place and are pinned by unit
 * tests rather than re-implemented per endpoint. As elsewhere in the codebase, a
 * request naming an unusable value is rejected with the reason; nothing is
 * silently coerced into a default that could hide a client bug — except the
 * documented pagination and budget bounds, which are clamped and echoed back so
 * the UI renders exactly what the server applied.
 *
 * Responses are built with the standard Web `Response` rather than
 * `NextResponse`: `NextResponse.json` is `Response.json` under the hood, and
 * using the platform primitive keeps this module free of a framework import
 * that Node's own runner cannot resolve — so the contract stays unit-testable
 * with no database, no network and no bundler.
 */

import { resolveEbayConfig } from "@/lib/ebay/config";

import { normalizeSellerHandle } from "./normalize";
import type { SellerScanOutcome, SellerScanRequest } from "./seller-scanner";
import type {
  SellerScanErrorCode,
  SellerScanErrorResponse,
  SellerScanSuccessResponse,
} from "@/types/sellers";

/** A scan request body is a handful of ids, a query and bounds — never a payload. */
export const MAX_BODY_BYTES = 8_192;

/** Mirrors the marketplace search route's query bound. */
const QUERY_MAX_LENGTH = 100;
const QUERY_MIN_LENGTH = 1;

/**
 * Builds the boundary's error body. `detail` names an environment variable only
 * (those are public in `.env.example`) — never a value, never a token.
 */
export function sellerJsonError(
  status: number,
  code: SellerScanErrorCode,
  message: string,
  timestamp: string,
  detail?: string,
): Response {
  const body: SellerScanErrorResponse = {
    status: "error",
    error: message,
    code,
    timestamp,
    ...(detail !== undefined && detail.length > 0 ? { detail } : {}),
  };
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Maps a scan outcome to its HTTP response. A scan that produced evidence is a
 * 200 even when some components degraded; only the typed error outcomes become
 * non-2xx.
 */
export function scanOutcomeResponse(
  outcome: SellerScanOutcome,
  timestamp: string,
): Response {
  switch (outcome.status) {
    case "ok": {
      const body: SellerScanSuccessResponse = {
        status: "ok",
        scan: outcome.scan,
        timestamp,
      };
      return Response.json(body, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }
    case "seller-not-found":
      return sellerJsonError(404, "SELLER_NOT_FOUND", outcome.message, timestamp);
    case "upstream-error":
      return sellerJsonError(
        outcome.retryable ? 503 : 502,
        outcome.retryable ? "UPSTREAM_ERROR" : "EBAY_UPSTREAM_ERROR",
        outcome.message,
        timestamp,
      );
  }
}

/** eBay configuration gate that returns instead of throwing. */

/**
 * Reads and validates a scan request body.
 *
 * Returns the validated request, or an already-built error response the route
 * returns verbatim. Bounds are clamped (and echoed by the scanner's `meta`),
 * while a missing or unusable seller or context is rejected outright.
 */
export async function readScanRequest(
  request: Request,
  timestamp: string,
): Promise<SellerScanRequest | Response> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return sellerJsonError(
      400,
      "INVALID_QUERY",
      "The request body could not be read.",
      timestamp,
    );
  }

  if (text.length > MAX_BODY_BYTES) {
    return sellerJsonError(
      400,
      "INVALID_QUERY",
      "The request body is larger than this boundary accepts.",
      timestamp,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return sellerJsonError(
      400,
      "INVALID_QUERY",
      "The request body is not valid JSON.",
      timestamp,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return sellerJsonError(
      400,
      "INVALID_QUERY",
      "The request body must be an object.",
      timestamp,
    );
  }

  const body = parsed as Record<string, unknown>;

  const username = body["username"];
  if (typeof username !== "string" || username.trim().length === 0) {
    return sellerJsonError(
      400,
      "INVALID_SELLER",
      "A seller identifier is required.",
      timestamp,
    );
  }
  const normalized = normalizeSellerHandle(username);
  if (normalized === null) {
    return sellerJsonError(
      400,
      "INVALID_SELLER",
      "The seller identifier is not a usable handle.",
      timestamp,
    );
  }

  const query = body["query"];
  if (typeof query !== "string") {
    return sellerJsonError(
      400,
      "INVALID_QUERY",
      "A search context is required to scope a seller's listings.",
      timestamp,
    );
  }
  const trimmedQuery = query.trim();
  if (
    trimmedQuery.length < QUERY_MIN_LENGTH ||
    trimmedQuery.length > QUERY_MAX_LENGTH
  ) {
    return sellerJsonError(
      400,
      "INVALID_QUERY",
      `The search context must be ${QUERY_MIN_LENGTH}–${QUERY_MAX_LENGTH} characters.`,
      timestamp,
    );
  }

  // Optional bounds accumulate here and are spread into the request once, so
  // the request itself stays readonly after construction.
  const optional: {
    limit?: number;
    offset?: number;
    recentLimit?: number;
    overlapAnalyses?: number;
    overlapWindow?: number;
  } = {};

  const numericError = assignOptionalNumber(body, "limit", "sample limit");
  if (numericError !== null) return sellerJsonError(400, "INVALID_QUERY", numericError, timestamp);
  if (typeof body["limit"] === "number") optional.limit = body["limit"];

  const offsetError = assignOptionalNumber(body, "offset", "offset");
  if (offsetError !== null) return sellerJsonError(400, "INVALID_QUERY", offsetError, timestamp);
  if (typeof body["offset"] === "number") optional.offset = body["offset"];

  const recentError = assignOptionalNumber(body, "recentLimit", "recent-listings limit");
  if (recentError !== null) return sellerJsonError(400, "INVALID_QUERY", recentError, timestamp);
  if (typeof body["recentLimit"] === "number") optional.recentLimit = body["recentLimit"];

  const overlapError = assignOptionalNumber(body, "overlapAnalyses", "overlap analysis count");
  if (overlapError !== null) return sellerJsonError(400, "INVALID_QUERY", overlapError, timestamp);
  if (typeof body["overlapAnalyses"] === "number") {
    optional.overlapAnalyses = body["overlapAnalyses"];
  }

  const windowError = assignOptionalNumber(body, "overlapWindow", "overlap window");
  if (windowError !== null) return sellerJsonError(400, "INVALID_QUERY", windowError, timestamp);
  if (typeof body["overlapWindow"] === "number") {
    optional.overlapWindow = body["overlapWindow"];
  }

  return { username: normalized, query: trimmedQuery, ...optional };
}

/**
 * Validates that an optional numeric bound is either absent or a finite number.
 * Returns `null` when acceptable, or the reason it was rejected.
 */
function assignOptionalNumber(
  body: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `The ${label} must be a number.`;
  }
  if (key === "overlapAnalyses" && value < 0) {
    return `The ${label} must be a non-negative number.`;
  }
  return null;
}

export function resolveEbayConfigSafe(): boolean {
  try {
    return resolveEbayConfig() !== null;
  } catch {
    return false;
  }
}
