import "server-only";

import { NextResponse } from "next/server";

import { CjAdapter } from "@/lib/cj/cj-adapter";
import { requireCjConfig } from "@/lib/cj/config";
import {
  CjApiError,
  CjAuthError,
  CjConfigError,
} from "@/lib/cj/errors";
import { EbayAdapter } from "@/lib/ebay/ebay-adapter";
import {
  EbayApiError,
  EbayAuthError,
  EbayConfigError,
} from "@/lib/ebay/errors";
import { resolveEbayConfig } from "@/lib/ebay/config";
import { computeCandidateEconomics } from "@/lib/economics/economics-service";
import { resolveShippingBaseline } from "@/lib/economics/config";
import { ProductMatcher } from "@/lib/matcher/matcher";
import type {
  MarketplaceProduct,
  MarketplaceSearchRequest,
} from "@/lib/marketplace/types";
import type { MatchCandidate } from "@/lib/matcher/types";
import type {
  EconomicsErrorCode,
  EconomicsErrorResponse,
  EconomicsSuccessResponse,
} from "@/types/economics";

/**
 * Server-side economics boundary.
 *
 *   GET /api/products/economics?itemId=<ebayItemId>&q=<query>&supplierProductId=<cjPid>
 *
 * The browser never posts economics inputs. It identifies an eBay listing it has
 * already seen and *one* matcher candidate it selected; the server re-resolves
 * the listing through the eBay adapter, re-runs the bounded matcher to prove the
 * supplier product really is a candidate for it, then computes economics from
 * authoritative upstream values only. Responses contain the economics result and
 * never credentials, tokens, or raw upstream payloads.
 *
 * One user request produces a bounded, documented set of upstream calls:
 * 1 eBay search (re-resolve) + ≤3 CJ searches (matcher) + 1 CJ variant query +
 * 1–2 CJ freight calculations. Economics are never computed for every candidate.
 */

// Economics must always reflect fresh upstream round-trips.
export const dynamic = "force-dynamic";

const MIN_QUERY_LENGTH = 1;
const MAX_QUERY_LENGTH = 100;

/**
 * eBay item ids are opaque composite strings (e.g. `v1|265983500898|0`); the id
 * is only ever compared for equality against ids the server resolved, never
 * interpolated into a URL or upstream query.
 */
const ITEM_ID_PATTERN = /^[A-Za-z0-9|._-]{1,60}$/;

/** CJ product ids are opaque keys handled exactly like eBay item ids. */
const SUPPLIER_PRODUCT_ID_PATTERN = /^[A-Za-z0-9|._-]{1,100}$/;

const DESTINATION_PATTERN = /^[A-Za-z]{2}$/;

/**
 * Matches the Product Scanner's default page size, so the re-resolve replays the
 * *same* search the user ran (eBay reorders results across page sizes — see the
 * matcher route and docs/ARCHITECTURE.md §8.3).
 */
const EBAY_RESOLVE_LIMIT = 24;

interface MappedError {
  status: number;
  code: EconomicsErrorCode;
  message: string;
  detail?: string;
}


export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  const url = new URL(request.url);

  // --- Input validation -----------------------------------------------------
  const rawItemId = url.searchParams.get("itemId");
  const itemId = rawItemId?.trim() ?? "";
  if (!ITEM_ID_PATTERN.test(itemId)) {
    return jsonError(400, "INVALID_ITEM_ID", "A valid eBay item id is required.", timestamp);
  }

  const rawQuery = url.searchParams.get("q");
  const query = rawQuery?.trim() ?? "";
  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
    return jsonError(
      400,
      "INVALID_QUERY",
      "The search term that surfaced this listing is required (1–100 characters).",
      timestamp,
    );
  }

  const rawSupplierProductId = url.searchParams.get("supplierProductId");
  const supplierProductId = rawSupplierProductId?.trim() ?? "";
  if (!SUPPLIER_PRODUCT_ID_PATTERN.test(supplierProductId)) {
    return jsonError(
      400,
      "INVALID_SUPPLIER_PRODUCT_ID",
      "A valid supplier product id is required.",
      timestamp,
    );
  }

  const rawDestination = url.searchParams.get("destinationCountry");
  const destinationOverride = rawDestination?.trim().toUpperCase() ?? "";
  if (destinationOverride !== "" && !DESTINATION_PATTERN.test(destinationOverride)) {
    return jsonError(
      400,
      "INVALID_DESTINATION",
      "A destination country, when provided, must be a two-letter country code.",
      timestamp,
    );
  }

  // --- Configuration gates --------------------------------------------------
  if (resolveEbayConfigSafe() === null) {
    return jsonError(
      503,
      "EBAY_NOT_CONFIGURED",
      "eBay marketplace search is not configured on this server.",
      timestamp,
      "Set EBAY_ENV, EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env.local.",
    );
  }

  if (requireCjConfigSafe() === null) {
    return jsonError(
      503,
      "CJ_NOT_CONFIGURED",
      "CJdropshipping is not configured on this server, so supplier economics cannot be computed.",
      timestamp,
      "Set CJ_API_KEY in .env.local.",
    );
  }

  // --- Re-resolve the eBay listing -----------------------------------------
  const marketplaceProduct = await resolveMarketplaceProduct(itemId, query, timestamp);
  if (marketplaceProduct instanceof Response) {
    return marketplaceProduct;
  }

  // --- Prove the supplier product is a matcher candidate for this listing ---
  const candidate = await resolveCandidate(marketplaceProduct, supplierProductId, timestamp);
  if (candidate instanceof Response) {
    return candidate;
  }

  // --- Economics -----------------------------------------------------------
  const baseline = resolveShippingBaseline();
  const destination = {
    countryCode: destinationOverride || baseline.countryCode,
    postalCode: baseline.postalCode,
    label:
      destinationOverride && destinationOverride !== baseline.countryCode
        ? `requested destination ${destinationOverride}`
        : baseline.label,
  };

  try {
    const outcome = await computeCandidateEconomics({ candidate, destination });

    const body: EconomicsSuccessResponse = {
      status: "ok",
      economics: outcome.result,
      matchConfidence: outcome.matchConfidence,
      matchConfidenceBand: outcome.matchConfidenceBand,
      timestamp,
    };

    return NextResponse.json(body, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const mapped = mapCjError(error);
    if (mapped !== null) {
      return jsonError(mapped.status, mapped.code, mapped.message, timestamp, mapped.detail);
    }

    console.error(
      "[products/economics] unexpected failure:",
      error instanceof Error ? error.name : typeof error,
    );
    return jsonError(
      500,
      "INTERNAL_ERROR",
      "An unexpected error occurred while computing economics.",
      timestamp,
    );
  }
}

/**
 * Replays the scanner's own search and locates the item id in that window. An
 * id that scrolled out of the window is reported rather than matched blindly.
 */
async function resolveMarketplaceProduct(
  itemId: string,
  query: string,
  timestamp: string,
): Promise<MarketplaceProduct | Response> {
  try {
    const searchRequest: MarketplaceSearchRequest = {
      query,
      limit: EBAY_RESOLVE_LIMIT,
      offset: 0,
    };
    const result = await new EbayAdapter().search(searchRequest);

    const product = result.products.find(
      (candidate) => candidate.externalId === itemId,
    );
    if (!product) {
      return jsonError(
        404,
        "ITEM_NOT_RESOLVED",
        "This listing is no longer in the current search results.",
        timestamp,
      );
    }
    return product;
  } catch (error) {
    const mapped = mapEbayError(error);
    return jsonError(mapped.status, mapped.code, mapped.message, timestamp, mapped.detail);
  }
}

/**
 * Re-runs the bounded matcher and locates the requested supplier product among
 * its candidates. This is what guarantees economics are only ever produced for a
 * genuine matcher candidate — the supplier id is never trusted on its own.
 */
async function resolveCandidate(
  marketplaceProduct: MarketplaceProduct,
  supplierProductId: string,
  timestamp: string,
): Promise<MatchCandidate | Response> {
  try {
    const matcher = new ProductMatcher(new CjAdapter(), { maxResults: 10 });
    const matchResult = await matcher.findCandidates(marketplaceProduct);

    const candidate = matchResult.candidates.find(
      (entry) => entry.supplierProduct.externalId === supplierProductId,
    );
    if (!candidate) {
      return jsonError(
        404,
        "CANDIDATE_NOT_FOUND",
        "That supplier product is not a matcher candidate for this listing, so its economics cannot be evaluated.",
        timestamp,
      );
    }
    return candidate;
  } catch (error) {
    const mapped = mapCjError(error);
    if (mapped !== null) {
      return jsonError(mapped.status, mapped.code, mapped.message, timestamp, mapped.detail);
    }

    console.error(
      "[products/economics] unexpected matcher failure:",
      error instanceof Error ? error.name : typeof error,
    );
    return jsonError(
      500,
      "INTERNAL_ERROR",
      "An unexpected error occurred while re-running the Product Matcher.",
      timestamp,
    );
  }
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

function mapEbayError(error: unknown): MappedError {
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
    "[products/economics] unexpected eBay failure:",
    error instanceof Error ? error.name : typeof error,
  );
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred while resolving the eBay listing.",
  };
}

function mapCjError(error: unknown): MappedError | null {
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

function jsonError(
  status: number,
  code: EconomicsErrorCode,
  message: string,
  timestamp: string,
  detail?: string,
): Response {
  const body: EconomicsErrorResponse = {
    status: "error",
    error: message,
    code,
    timestamp,
    ...(detail ? { detail } : {}),
  };
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
