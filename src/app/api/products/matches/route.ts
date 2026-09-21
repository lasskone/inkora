import "server-only";

import { NextResponse } from "next/server";

import { CjAdapter, classifyUsWarehouseInventory } from "@/lib/cj/cj-adapter";
import { requireCjConfig } from "@/lib/cj/config";
import { queryCjInventoryBySku } from "@/lib/cj/products-api";
import { EbayAdapter } from "@/lib/ebay/ebay-adapter";
import {
  EbayApiError,
  EbayAuthError,
  EbayConfigError,
} from "@/lib/ebay/errors";
import { resolveEbayConfig } from "@/lib/ebay/config";
import { enrichWithInventory } from "@/lib/matcher/inventory";
import { ProductMatcher } from "@/lib/matcher/matcher";
import type {
  MarketplaceProduct,
  MarketplaceSearchRequest,
} from "@/lib/marketplace/types";
import type {
  ProductMatchErrorCode,
  ProductMatchErrorResponse,
  ProductMatchSuccessResponse,
} from "@/types/product-match";

/**
 * Server-side Product Matcher boundary.
 *
 *   GET /api/products/matches?itemId=<ebayItemId>&q=<query>&limit=<n>
 *
 * The browser never posts a raw marketplace object. It identifies an eBay
 * listing it has already seen (itemId, plus the query that surfaced it) and the
 * server re-resolves the normalized `MarketplaceProduct` itself through the
 * existing eBay adapter. The matcher then runs bounded, real CJ candidate
 * discovery against the resolved product. Responses contain only normalized
 * models plus Inkora-derived confidence — never credentials, tokens, or raw
 * upstream payloads.
 */

// Candidate discovery must always reflect fresh upstream round-trips.
export const dynamic = "force-dynamic";

const MIN_QUERY_LENGTH = 1;
const MAX_QUERY_LENGTH = 100;

const MIN_LIMIT = 1;
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 8;

/**
 * eBay item ids are opaque composite strings (the Browse API returns ids such
 * as `v1|265983500898|0`). The route never treats the id as anything but a
 * lookup key: it is compared for equality against ids the server itself
 * resolved, and is never interpolated into a URL or upstream query. The pattern
 * therefore only bounds its shape, not its meaning.
 */
const ITEM_ID_PATTERN = /^[A-Za-z0-9|._-]{1,60}$/;

/**
 * How many eBay results to scan while re-resolving one listing. This mirrors
 * the page size the Product Scanner itself requests (its default limit), so the
 * server re-runs the *same* search the user ran: eBay's ordering can differ
 * between requests with different page sizes, so matching the parameters keeps
 * the clicked listing inside the resolve window. One eBay call per match
 * request — bounded and page-sized, no fan-out.
 */
const EBAY_RESOLVE_LIMIT = 24;

interface MappedError {
  status: number;
  code: ProductMatchErrorCode;
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
    return jsonError(
      400,
      "INVALID_ITEM_ID",
      "A valid eBay item id is required.",
      timestamp,
    );
  }

  const rawQuery = url.searchParams.get("q");
  const query = rawQuery?.trim() ?? "";
  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
    return jsonError(
      400,
      "INVALID_QUERY",
      `A search query of ${MIN_QUERY_LENGTH}–${MAX_QUERY_LENGTH} characters is required.`,
      timestamp,
    );
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit === null) {
    return jsonError(
      400,
      "INVALID_LIMIT",
      "`limit` must be an integer between 1 and 20.",
      timestamp,
    );
  }

  // --- Configuration gates ---------------------------------------------------
  const ebayConfig = resolveEbayConfig();
  if (ebayConfig === null) {
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
      "CJdropshipping supplier search is not configured on this server.",
      timestamp,
      "Set CJ_API_KEY in .env.local.",
    );
  }

  // --- Resolve the marketplace product server-side --------------------------
  const searchRequest: MarketplaceSearchRequest = {
    query,
    limit: EBAY_RESOLVE_LIMIT,
  };

  let marketplaceProduct: MarketplaceProduct;
  try {
    const result = await new EbayAdapter().search(searchRequest);
    const resolved = result.products.find(
      (product) => product.externalId === itemId,
    );
    if (!resolved) {
      return jsonError(
        404,
        "ITEM_NOT_RESOLVED",
        "That eBay listing is no longer part of the search results for this query.",
        timestamp,
        "Re-run the marketplace search and request supplier candidates again.",
      );
    }
    marketplaceProduct = resolved;
  } catch (error) {
    const mapped = mapEbayError(error);
    return jsonError(
      mapped.status,
      mapped.code,
      mapped.message,
      timestamp,
      mapped.detail,
    );
  }

  // --- Candidate discovery and ranking --------------------------------------
  const matcher = new ProductMatcher(new CjAdapter(), { maxResults: limit });
  const matchResult = await matcher.findCandidates(marketplaceProduct);

  // Inventory is enriched only for the top-ranked candidates after text
  // ranking, bounded by the matcher's limit — never one call per candidate.
  const cjConfig = requireCjConfig();
  const candidates = await enrichWithInventory(
    matchResult.candidates,
    async (sku) => {
      const rows = await queryCjInventoryBySku(cjConfig, sku);
      return classifyUsWarehouseInventory(rows).status;
    },
    matchResult.limits.maxInventoryLookups,
  );

  const body: ProductMatchSuccessResponse = {
    ...matchResult,
    candidates,
    status: "ok",
    timestamp,
  };

  return NextResponse.json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * CJ configuration gate that returns rather than throws, so the route answers
 * with a clean 503 instead of crashing when the supplier is not configured.
 */
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
    "[products/matches] unexpected eBay failure:",
    error instanceof Error ? error.name : typeof error,
  );
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred while resolving the eBay listing.",
  };
}

function parseLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return DEFAULT_LIMIT;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed)) return null;
  return Math.min(Math.max(parsed, MIN_LIMIT), MAX_LIMIT);
}

function jsonError(
  status: number,
  code: ProductMatchErrorCode,
  message: string,
  timestamp: string,
  detail?: string,
): Response {
  const body: ProductMatchErrorResponse = {
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
