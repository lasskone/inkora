import "server-only";

import { NextResponse } from "next/server";

import { EbayAdapter } from "@/lib/ebay/ebay-adapter";
import {
  EbayApiError,
  EbayAuthError,
  EbayConfigError,
} from "@/lib/ebay/errors";
import { resolveEbayConfig } from "@/lib/ebay/config";
import type {
  MarketplaceSearchErrorCode,
  MarketplaceSearchErrorResponse,
  MarketplaceSearchSuccessResponse,
} from "@/types/marketplace-search";

/**
 * Server-side marketplace search boundary.
 *
 *   GET /api/marketplaces/ebay/search?q=<query>&limit=<n>&offset=<n>
 *
 * The browser never calls eBay directly: this route is the only path from the
 * UI to the marketplace adapter. It validates input, bounds the request, and
 * translates every failure into a safe, generic HTTP response. Responses never
 * contain credentials, access tokens, or raw eBay error payloads.
 */

// Live marketplace data must always reflect a fresh round-trip.
export const dynamic = "force-dynamic";

const MIN_QUERY_LENGTH = 1;
const MAX_QUERY_LENGTH = 100;

const DEFAULT_LIMIT = 24;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

interface MappedError {
  status: number;
  code: MarketplaceSearchErrorCode;
  message: string;
  detail?: string;
}

export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  const url = new URL(request.url);

  // --- Input validation -----------------------------------------------------
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
      "`limit` must be an integer between 1 and 50.",
      timestamp,
    );
  }

  const offset = parseOffset(url.searchParams.get("offset"));

  // --- Configuration gate ---------------------------------------------------
  const config = resolveEbayConfig();
  if (config === null) {
    return jsonError(
      503,
      "EBAY_NOT_CONFIGURED",
      "eBay marketplace search is not configured on this server.",
      timestamp,
      "Set EBAY_ENV, EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env.local (variable names only are public in .env.example); restart the server afterwards.",
    );
  }

  // --- Adapter call ---------------------------------------------------------
  try {
    const adapter = new EbayAdapter();
    const result = await adapter.search({ query, limit, offset });

    const body: MarketplaceSearchSuccessResponse = {
      status: "ok",
      marketplace: "ebay",
      environment: config.environment,
      query: result.query,
      limit: result.limit,
      offset: result.offset,
      total: result.total,
      count: result.count,
      products: result.products,
      timestamp,
    };

    return NextResponse.json(body, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const mapped = mapError(error);
    return jsonError(
      mapped.status,
      mapped.code,
      mapped.message,
      timestamp,
      mapped.detail,
    );
  }
}

function mapError(error: unknown): MappedError {
  if (error instanceof EbayConfigError) {
    return {
      status: 503,
      code: "EBAY_NOT_CONFIGURED",
      message: "eBay marketplace search is not configured on this server.",
      detail:
        "Set EBAY_ENV, EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env.local.",
    };
  }

  if (error instanceof EbayAuthError) {
    return {
      status: 502,
      code: "EBAY_AUTH_FAILED",
      message:
        "The server could not authenticate with eBay. Check that the eBay credentials are valid and that the keyset is approved for the configured environment.",
    };
  }

  if (error instanceof EbayApiError) {
    if (error.status === 429) {
      return {
        status: 429,
        code: "EBAY_RATE_LIMITED",
        message:
          "eBay is rate-limiting this application. Wait a moment, then retry.",
      };
    }
    return {
      status: 502,
      code: "EBAY_UPSTREAM_ERROR",
      message: error.message,
    };
  }

  // Unexpected failure: log a safe identifier only (no stack, no props that
  // could carry environment values), and return a generic message.
  console.error(
    "[marketplaces/ebay/search] unexpected failure:",
    error instanceof Error ? error.name : typeof error,
  );
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred while searching eBay.",
  };
}

function parseLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return DEFAULT_LIMIT;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed)) return null;
  return Math.min(Math.max(parsed, MIN_LIMIT), MAX_LIMIT);
}

function parseOffset(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 0;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 9_999);
}

function jsonError(
  status: number,
  code: MarketplaceSearchErrorCode,
  message: string,
  timestamp: string,
  detail?: string,
): Response {
  const body: MarketplaceSearchErrorResponse = {
    status: "error",
    marketplace: "ebay",
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
