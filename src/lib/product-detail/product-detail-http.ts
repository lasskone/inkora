/**
 * Shared HTTP-boundary helpers for the Product Detail routes
 * (docs/ARCHITECTURE.md §18.3).
 *
 * Everything here answers a `Response` or reads the server's own configuration,
 * so — like `src/lib/watchlist/watchlist-http.ts` — this module is marked
 * `server-only`: it must never reach the browser bundle. The pure request
 * validation it used to hold now lives in `./product-detail-validation`, which
 * is client-safe, so the page's link builders and the route accept exactly the
 * same strings.
 *
 * Responses are built with the standard Web `Response` rather than
 * `NextResponse`: `NextResponse.json` is `Response.json` under the hood, and
 * using the platform primitive keeps this module free of a framework import
 * that Node's own runner cannot resolve.
 */

import "server-only";

import { requireCjConfig } from "@/lib/cj/config";
import { resolveShippingBaseline } from "@/lib/economics/config";
import { resolveEbayConfig } from "@/lib/ebay/config";
import type { ScanDestination } from "@/lib/scanner/types";
import type {
  ProductDetailErrorCode,
  ProductDetailErrorResponse,
} from "@/types/product-detail";

export {
  DESTINATION_PATTERN,
  ITEM_ID_PATTERN,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  SUPPLIER_PRODUCT_ID_PATTERN,
  validateProductDetailRefreshBody,
  validateProductDetailRequest,
  type ProductDetailRequest,
  type ValidationResult,
} from "./product-detail-validation";

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

/** A refresh body is tiny; anything larger is refused rather than parsed. */
export const MAX_PRODUCT_DETAIL_BODY_BYTES = 8_192;

/**
 * Builds one error response. `detail` carries variable *names* only (they are
 * public in `.env.example`) — never a value — so a misconfigured server never
 * leaks its secrets into a response body.
 */
export function productDetailJsonError(
  status: number,
  code: ProductDetailErrorCode,
  message: string,
  timestamp: string,
  detail?: string,
): Response {
  const body: ProductDetailErrorResponse = {
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
 * Reads a refresh body as a plain object, or returns an already-built error
 * response the route answers verbatim. An absent or empty body is `{}`, so a
 * refresh stays usable without a payload — the ids come from the path and query.
 */
export async function readProductDetailBody(
  request: Request,
  timestamp: string,
): Promise<Record<string, unknown> | Response> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return productDetailJsonError(
      400,
      "MALFORMED_BODY",
      "The request body could not be read.",
      timestamp,
    );
  }

  if (text.trim().length === 0) {
    return {};
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return productDetailJsonError(
      400,
      "MALFORMED_BODY",
      "Send a JSON body with Content-Type: application/json.",
      timestamp,
    );
  }

  if (text.length > MAX_PRODUCT_DETAIL_BODY_BYTES) {
    return productDetailJsonError(
      413,
      "MALFORMED_BODY",
      "The request body is larger than this endpoint accepts.",
      timestamp,
    );
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return productDetailJsonError(
        400,
        "MALFORMED_BODY",
        "The body must be a JSON object.",
        timestamp,
      );
    }
    return parsed as Record<string, unknown>;
  } catch {
    return productDetailJsonError(400, "MALFORMED_BODY", "The body is not valid JSON.", timestamp);
  }
}

/**
 * Refuses the request up front when a provider the pipeline needs is not
 * configured, naming the variables to set. Returns `null` when both are ready.
 */
export function requireProductDetailProviders(timestamp: string): Response | null {
  if (!productDetailProvidersReady()) {
    if (resolveEbayConfigSafe() === null) {
      return productDetailJsonError(
        503,
        "EBAY_NOT_CONFIGURED",
        "eBay marketplace search is not configured on this server.",
        timestamp,
        "Set EBAY_ENV, EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env.local.",
      );
    }
    return productDetailJsonError(
      503,
      "CJ_NOT_CONFIGURED",
      "CJdropshipping is not configured on this server, so no opportunity can be assessed.",
      timestamp,
      "Set CJ_API_KEY in .env.local.",
    );
  }
  return null;
}

/**
 * Whether a deliberate refresh can run on this server. Reported by the read
 * route so the page can render the control honestly — absent when the server
 * has not been configured for a live re-evaluation (docs/ARCHITECTURE.md §18.3).
 */
export function productDetailProvidersReady(): boolean {
  return resolveEbayConfigSafe() !== null && requireCjConfigSafe() !== null;
}

/**
 * The destination economics are quoted against, mirroring the scanner and
 * watchlist routes: the server's configured baseline, possibly overridden by a
 * two-letter country. The override is already validated by
 * `validateProductDetailRequest` before this runs (docs/ARCHITECTURE.md §16.2).
 */
export function resolveProductDetailDestination(override: string | null): ScanDestination {
  const baseline = resolveShippingBaseline();
  if (override === null || override === baseline.countryCode) {
    return baseline;
  }
  return {
    countryCode: override,
    postalCode: baseline.postalCode,
    label: `requested destination ${override}`,
  };
}

/** eBay configuration gate that returns instead of throwing. */
function resolveEbayConfigSafe() {
  try {
    return resolveEbayConfig();
  } catch {
    return null;
  }
}

/** CJ configuration gate that returns instead of throwing. */
function requireCjConfigSafe() {
  try {
    return requireCjConfig();
  } catch {
    return null;
  }
}

