import "server-only";

import { NextResponse } from "next/server";

import {
  clampLimit,
  readMarketplaceProductHistory,
  type HistoryReadResult,
} from "@/lib/persistence/history-reader";
import type { MarketplaceId } from "@/lib/marketplace/types";
import type {
  ProductHistoryErrorCode,
  ProductHistoryErrorResponse,
  ProductHistorySuccessResponse,
} from "@/types/product-history";

/**
 * Server-side historical read boundary.
 *
 *   GET /api/products/history?itemId=<ebayItemId>&limit=<1..50>
 *
 * Returns persisted *observations* for one eBay listing: marketplace snapshots,
 * match observations and economics observations, each with its own observation
 * timestamp. Every entry is explicitly historical — none of them is a statement
 * about the listing's current price or stock (docs/ARCHITECTURE.md §14,
 * docs/DATABASE.md §8).
 *
 * The browser identifies the listing by the same opaque item id the economics
 * route resolved; the server looks it up by stable provider identity. Reads are
 * bounded (hard ceiling, most-recent-first) and the applied limit is echoed
 * back. No request body, no cookies, no secrets, no raw upstream payloads, and
 * never a write path.
 */

// History must always reflect what is actually stored, never a cached response.
export const dynamic = "force-dynamic";

/**
 * The only marketplace with an adapter today; the lookup is scoped to it so a
 * future marketplace's item id can never collide (docs/ARCHITECTURE.md §4).
 */
const MARKETPLACE: MarketplaceId = "ebay";

/**
 * eBay item ids are opaque composite strings (e.g. `v1|265983500898|0`). Like
 * the matcher and economics routes, the id is only ever compared for equality
 * against a stored identity — never interpolated into a URL or upstream query.
 */
const ITEM_ID_PATTERN = /^[A-Za-z0-9|._-]{1,60}$/;

interface MappedError {
  status: number;
  code: ProductHistoryErrorCode;
  message: string;
}

export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  const url = new URL(request.url);

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

  const limit = clampLimit(safeNumber(url.searchParams.get("limit")));

  const result = await readMarketplaceProductHistory({
    marketplace: MARKETPLACE,
    externalId: itemId,
    limit,
  });

  return toResponse(result, limit, timestamp);
}

/** Parses the optional limit without letting a malformed value become NaN. */
function safeNumber(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toResponse(
  result: HistoryReadResult,
  limit: number,
  timestamp: string,
): Response {
  if (result.status === "ok") {
    const body: ProductHistorySuccessResponse = {
      status: "ok",
      history: result.history,
      limit,
      timestamp,
    };
    return NextResponse.json(body, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const mapped = mapReadStatus(result);
  return jsonError(mapped.status, mapped.code, mapped.message, timestamp);
}

function mapReadStatus(
  result: Exclude<HistoryReadResult, { status: "ok" }>,
): MappedError {
  switch (result.status) {
    case "disabled":
      return {
        status: 503,
        code: "HISTORY_NOT_CONFIGURED",
        message:
          "Historical observations are not enabled in this deployment; nothing has been persisted.",
      };

    case "not_found":
      return {
        status: 404,
        code: "NO_OBSERVATIONS",
        message:
          "No persisted observations exist for that listing yet. Observations are recorded when economics are evaluated.",
      };

    case "error":
      return {
        status: 503,
        code: "HISTORY_UNAVAILABLE",
        message: result.message,
      };
  }
}

function jsonError(
  status: number,
  code: ProductHistoryErrorCode,
  message: string,
  timestamp: string,
): Response {
  const body: ProductHistoryErrorResponse = {
    status: "error",
    error: message,
    code,
    timestamp,
  };
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
