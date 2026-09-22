import { CjApiError, CjAuthError, CjConfigError } from "@/lib/cj/errors";
import { EbayApiError, EbayAuthError, EbayConfigError } from "@/lib/ebay/errors";

/**
 * Shared eBay/CJ failure → HTTP mapping for the product-intelligence routes
 * (docs/ARCHITECTURE.md §8.3).
 *
 * Every route that re-resolves a listing and re-runs the matcher can fail in
 * the same upstream ways, and must report them in the same words, so the
 * mapping lives next to the shared resolution flow instead of being copied
 * into each route. Route-local codes (validation, resolution outcomes) extend
 * `UpstreamErrorCode`; nothing here is route-specific.
 */

/**
 * Failure codes both upstreams can produce, plus the catch-all. A route's own
 * error vocabulary is this union plus its route-specific codes, which keeps
 * `jsonError` typed per route while the mapping stays shared.
 */
export type UpstreamErrorCode =
  | "EBAY_NOT_CONFIGURED"
  | "EBAY_AUTH_FAILED"
  | "EBAY_UPSTREAM_ERROR"
  | "EBAY_RATE_LIMITED"
  | "CJ_NOT_CONFIGURED"
  | "CJ_AUTH_FAILED"
  | "CJ_UPSTREAM_ERROR"
  | "CJ_RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface MappedUpstreamError {
  status: number;
  code: UpstreamErrorCode;
  message: string;
  detail?: string;
}

/**
 * Maps an eBay failure to an honest, secret-free HTTP response. eBay failures
 * are always fatal to a request: nothing can be assessed without the listing.
 */
export function mapEbayError(error: unknown): MappedUpstreamError {
  if (error instanceof EbayConfigError) {
    return {
      status: 503,
      code: "EBAY_NOT_CONFIGURED",
      message: "eBay marketplace search is not configured on this server.",
      detail: "Set EBAY_ENV, EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env.local.",
    };
  }

  if (error instanceof EbayAuthError) {
    return {
      status: 502,
      code: "EBAY_AUTH_FAILED",
      message:
        "The server could not authenticate with eBay while resolving that listing.",
      detail: error.code
        ? `eBay rejected the credentials (upstream code: ${error.code}). Verify the App ID and Cert ID in .env.local belong to the same approved keyset.`
        : "Verify the App ID and Cert ID in .env.local belong to the same approved keyset.",
    };
  }

  if (error instanceof EbayApiError) {
    if (error.status === 429) {
      return {
        status: 429,
        code: "EBAY_RATE_LIMITED",
        message: "eBay is rate-limiting this application. Wait a moment, then retry.",
      };
    }
    return {
      status: 502,
      code: "EBAY_UPSTREAM_ERROR",
      message: error.message,
    };
  }

  console.error(
    "[upstream-errors] unexpected eBay failure:",
    error instanceof Error ? error.name : typeof error,
  );
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred while resolving the eBay listing.",
  };
}

/**
 * Maps a CJdropshipping failure to an HTTP response, or `null` when the error
 * is not a CJ error at all and the caller must classify it itself.
 */
export function mapCjError(error: unknown): MappedUpstreamError | null {
  if (error instanceof CjConfigError) {
    return {
      status: 503,
      code: "CJ_NOT_CONFIGURED",
      message:
        "CJdropshipping is not configured on this server, so supplier economics cannot be computed.",
      detail: "Set CJ_API_KEY in .env.local.",
    };
  }

  if (error instanceof CjAuthError) {
    return {
      status: 502,
      code: "CJ_AUTH_FAILED",
      message:
        "The server could not authenticate with CJdropshipping while quoting this candidate.",
      detail:
        typeof error.code === "number"
          ? `CJ rejected the API key (upstream code: ${error.code}). Verify CJ_API_KEY in .env.local is a valid API key for an active CJdropshipping account.`
          : "Verify CJ_API_KEY in .env.local is a valid API key for an active CJdropshipping account.",
    };
  }

  if (error instanceof CjApiError) {
    if (error.status === 429) {
      return {
        status: 429,
        code: "CJ_RATE_LIMITED",
        message:
          "CJdropshipping is rate-limiting this application. Wait a moment, then retry.",
      };
    }
    return {
      status: 502,
      code: "CJ_UPSTREAM_ERROR",
      message: error.message,
    };
  }

  return null;
}
