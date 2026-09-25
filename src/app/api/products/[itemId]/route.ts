import "server-only";

import { NextResponse } from "next/server";

import { createPersistenceClient } from "@/lib/persistence/client";
import {
  productDetailJsonError,
  productDetailProvidersReady,
  readProductDetailBody,
  requireProductDetailProviders,
  resolveProductDetailDestination,
  validateProductDetailRefreshBody,
  validateProductDetailRequest,
} from "@/lib/product-detail/product-detail-http";
import {
  PRODUCT_DETAIL_HISTORY_LIMIT,
  readProductDetail,
  refreshProductDetail,
} from "@/lib/product-detail/product-detail-service";
import { createWatchlistService } from "@/lib/watchlist/watchlist-ports";
import type {
  ProductDetailErrorCode,
  ProductDetailRefreshSuccessResponse,
  ProductDetailSuccessResponse,
} from "@/types/product-detail";

/**
 * Product Detail boundary — the opportunity intelligence for one listing
 * (docs/ARCHITECTURE.md §18).
 *
 *   GET  /api/products/{itemId}?q=<query>&supplierProductId=<id>&destinationCountry=DE
 *   POST /api/products/{itemId}?q=<query>&supplierProductId=<id>   { "destinationCountry": "DE" }
 *
 * GET is persisted-first: no eBay, CJ, freight or scoring call is made, so a
 * normal page load costs no upstream budget. Whatever is already stored is what
 * comes back; whatever is not stored is reported as absent rather than invented.
 *
 * POST is the only way this page gets fresh numbers. It replays the search that
 * surfaced the listing and re-proves the persisted pairing through the matcher's
 * own candidates, using the Watchlist's ports verbatim — same engines, same
 * order, same upstream budget (1 eBay search, reused as competition evidence,
 * plus ≤6 CJ calls). Nothing is substituted; nothing is removed.
 */

// Reads are persisted; refreshes must reflect fresh upstream round-trips.
export const dynamic = "force-dynamic";

/**
 * Maps a refresh outcome onto an honest status. Verdict and no-verdict outcomes
 * alike are `200`, because the pairing is untouched and the page can still
 * render last-known data beside the reason; `item-not-found` is `404` — the
 * listing is gone from the replayed window, not merely unresolvable.
 */
function refreshHttpStatus(outcome: string): number {
  switch (outcome) {
    case "evaluated":
    case "no-candidates":
    case "economics-unavailable":
    case "candidate-not-resolved":
    case "upstream-error":
      return 200;
    case "not-observed":
    case "item-not-found":
      return 404;
    default:
      return 500;
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  const timestamp = new Date().toISOString();
  const { itemId: rawItemId } = await context.params;

  const url = new URL(request.url);
  const validation = validateProductDetailRequest({
    itemId: rawItemId,
    // `q` is the name the product and seller scanners already carry in their links.
    query: url.searchParams.get("q") ?? url.searchParams.get("query"),
    supplierProductId: url.searchParams.get("supplierProductId"),
    destinationCountry: url.searchParams.get("destinationCountry"),
  });
  if (validation.status === "invalid") {
    return productDetailJsonError(400, validation.code, validation.message, timestamp);
  }

  const persistence = createPersistenceClient();
  if (persistence === null) {
    return productDetailJsonError(
      503,
      "PERSISTENCE_NOT_CONFIGURED",
      "Persistence is not configured on this server, so nothing has been observed.",
      timestamp,
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }

  const result = await readProductDetail({
    itemId: validation.request.itemId,
    query: validation.request.query,
    supplierProductId: validation.request.supplierProductId,
    options: { persistence, now: timestamp },
  });

  if (result.status === "disabled") {
    return productDetailJsonError(
      503,
      "PERSISTENCE_NOT_CONFIGURED",
      "Persistence is unavailable, so nothing has been observed.",
      timestamp,
    );
  }

  if (result.status === "not-observed") {
    const response: ProductDetailSuccessResponse = {
      status: "ok",
      outcome: "not-observed",
      historyLimit: PRODUCT_DETAIL_HISTORY_LIMIT,
      refreshAvailable: productDetailProvidersReady(),
      timestamp,
    };
    return NextResponse.json(response, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const response: ProductDetailSuccessResponse = {
    status: "ok",
    outcome: "ok",
    detail: result.detail,
    historyLimit: PRODUCT_DETAIL_HISTORY_LIMIT,
    refreshAvailable: productDetailProvidersReady(),
    timestamp,
  };
  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}


export async function POST(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  const timestamp = new Date().toISOString();
  const { itemId: rawItemId } = await context.params;

  const watchlist = createWatchlistService();
  if (watchlist === null) {
    return productDetailJsonError(
      503,
      "PERSISTENCE_NOT_CONFIGURED",
      "Persistence is not configured on this server, so nothing can be re-evaluated.",
      timestamp,
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }

  // A refresh needs both providers: eBay to replay the search, CJ to re-prove
  // the candidate. Refused up front, by variable name.
  const providers = requireProductDetailProviders(timestamp);
  if (providers !== null) {
    return providers;
  }

  const url = new URL(request.url);

  const body = await readProductDetailBody(request, timestamp);
  if (body instanceof Response) {
    return body;
  }

  // Ids and the replay query may come from the path, the query string or the
  // body; the body wins when it carries a usable value. Everything is
  // validated together afterwards, so no source is ever trusted outright.
  const fromBody = validateProductDetailRefreshBody(body);
  const merged = fromBody.status === "valid" ? fromBody.request : null;

  const validation = validateProductDetailRequest({
    itemId: merged !== null ? merged.itemId : rawItemId,
    query:
      merged !== null
        ? merged.query
        : url.searchParams.get("q") ?? url.searchParams.get("query"),
    supplierProductId:
      merged !== null && merged.supplierProductId !== null
        ? merged.supplierProductId
        : url.searchParams.get("supplierProductId"),
    destinationCountry:
      merged !== null && merged.destinationCountry !== null
        ? merged.destinationCountry
        : url.searchParams.get("destinationCountry"),
  });
  if (validation.status === "invalid") {
    const code: ProductDetailErrorCode = validation.code;
    return productDetailJsonError(400, code, validation.message, timestamp);
  }

  const { request: validated } = validation;
  const destination = resolveProductDetailDestination(validated.destinationCountry);

  const result = await refreshProductDetail({
    itemId: validated.itemId,
    query: validated.query,
    supplierProductId: validated.supplierProductId,
    destination,
    options: { watchlist, now: timestamp },
  });

  if (result.outcome === "disabled") {
    return productDetailJsonError(
      503,
      "PERSISTENCE_NOT_CONFIGURED",
      "Persistence is unavailable, so nothing can be re-evaluated.",
      timestamp,
    );
  }

  // There is no `not-observed` refusal on a refresh: an unobserved listing is
  // evaluated and becomes its own first observation, so `evaluated` with
  // `comparison.noPrevious === true` is what an unobserved item answers.

  const response: ProductDetailRefreshSuccessResponse = {
    status: "ok",
    outcome: result.outcome,
    historyLimit: PRODUCT_DETAIL_HISTORY_LIMIT,
    timestamp,
    ...(result.outcome === "evaluated"
      ? {
          assessment: result.assessment,
          comparison: result.comparison,
          persistence: result.persistence,
          detail: result.detail ?? undefined,
        }
      : {}),
    ...(result.outcome === "no-candidates" || result.outcome === "economics-unavailable"
      ? { assessment: result.assessment, detail: result.detail ?? undefined }
      : {}),
    ...(result.outcome === "item-not-found" ||
    result.outcome === "candidate-not-resolved" ||
    result.outcome === "upstream-error"
      ? { detail: result.detail ?? undefined }
      : {}),
  };
  return NextResponse.json(response, {
    status: refreshHttpStatus(result.outcome),
    headers: { "Cache-Control": "no-store" },
  });
}
