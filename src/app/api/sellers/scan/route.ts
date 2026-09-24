import "server-only";

import { EbayAdapter } from "@/lib/ebay/ebay-adapter";
import { EbayConfigError } from "@/lib/ebay/errors";
import { resolveEbayConfig } from "@/lib/ebay/config";
import {
  readScanRequest,
  resolveEbayConfigSafe,
  scanOutcomeResponse,
  sellerJsonError,
} from "@/lib/sellers/seller-http";
import { scanSeller, type SellerScanPorts } from "@/lib/sellers/seller-scanner";
import type { SellerScanErrorCode } from "@/types/sellers";

/**
 * Server-side Seller Scanner boundary.
 *
 *   POST /api/sellers/scan
 *     { "username": "<ebay seller>", "query": "<search context>",
 *       "limit"?, "offset"?, "recentLimit"?, "overlapAnalyses"?, "overlapWindow"? }
 *
 * The browser names a seller and a search context — never a product object, a
 * price or evidence of its own. The server scopes the marketplace to that
 * seller, composes the deterministic analysis, and returns the provider-
 * independent result. Every bound is enforced here; the values the browser
 * renders are echoed back by the scanner's `meta` after being clamped.
 *
 * One scan costs 2 + ≤ `overlapAnalyses` marketplace searches plus bounded
 * database writes. Opportunity evaluation is deliberately *not* part of a scan:
 * it stays a separate user action through the existing pipeline
 * (docs/ARCHITECTURE.md §9, §15, §17).
 *
 * The response never contains credentials, tokens, raw upstream payloads or
 * marketplace error bodies — only the boundary's fixed error vocabulary.
 */

// A scan always reflects fresh upstream round-trips.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();

  if (!resolveEbayConfigSafe()) {
    return sellerJsonError(
      503,
      "EBAY_NOT_CONFIGURED",
      "eBay is not configured on this server, so seller scans are unavailable.",
      timestamp,
      "Set EBAY_ENV, EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (see .env.example).",
    );
  }

  const parsed = await readScanRequest(request, timestamp);
  if (parsed instanceof Response) {
    return parsed;
  }

  const ports: SellerScanPorts = {
    sellerListings: new EbayAdapter(),
    discovery: new EbayAdapter(),
  };

  try {
    const environment = resolveEbayConfig()?.environment ?? "unknown";
    const outcome = await scanSeller({ ports, request: parsed, environment });
    return scanOutcomeResponse(outcome, timestamp);
  } catch (error) {
    return unexpectedError(error, timestamp);
  }
}

/** Maps an unexpected thrown error to a safe 500 with no secret material. */
function unexpectedError(error: unknown, timestamp: string): Response {
  if (error instanceof EbayConfigError) {
    return sellerJsonError(
      503,
      "EBAY_NOT_CONFIGURED",
      "eBay is not configured on this server, so seller scans are unavailable.",
      timestamp,
    );
  }

  const message =
    error !== null &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "The seller scan could not be completed.";

  console.error("[sellers/scan] unexpected failure:", message);

  return sellerJsonError(
    500,
    "INTERNAL_ERROR" satisfies SellerScanErrorCode,
    "The seller scan failed unexpectedly. Please try again.",
    timestamp,
  );
}
