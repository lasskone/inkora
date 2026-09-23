import "server-only";

import { NextResponse } from "next/server";

import { CjAdapter } from "@/lib/cj/cj-adapter";
import { requireCjConfig } from "@/lib/cj/config";
import { EbayAdapter } from "@/lib/ebay/ebay-adapter";
import { resolveEbayConfig } from "@/lib/ebay/config";
import { computeCandidateEconomics } from "@/lib/economics/economics-service";
import { resolveShippingBaseline } from "@/lib/economics/config";
import { ProductMatcher } from "@/lib/matcher/matcher";
import { mapEbayError } from "@/lib/products/upstream-errors";
import { persistEvaluation } from "@/lib/persistence/persistence-service";
import {
  persistOpportunityAssessment,
  readOpportunityEvidence,
} from "@/lib/persistence/opportunity-persistence";
import {
  runOpportunityScan,
  ScanPipelineError,
  type ScanPipelineErrorCode,
} from "@/lib/scanner/scanner";
import { SCANNER_MATCH_MAX_RESULTS } from "@/lib/scanner/limits";
import type {
  ScanDestination,
  ScanMode,
  ScanRequest,
  ScannerPorts,
} from "@/lib/scanner/types";
import type {
  ScannerErrorCode,
  ScannerErrorResponse,
  ScannerSuccessResponse,
} from "@/types/scanner";
import type { OpportunityLimits } from "@/lib/opportunity/types";
import type { OpportunityPersistenceReport } from "@/types/opportunity";

/**
 * Server-side Opportunity Scanner boundary.
 *
 *   POST /api/scanner/scan
 *
 * ```json
 * { "query": "wireless earbuds", "mode": "manual", "itemIds": ["v1|…|0"] }
 * { "query": "wireless earbuds", "mode": "batch", "limit": 6 }
 * ```
 *
 * The browser identifies eBay listings it has already seen (or asks for a
 * server-chosen batch). The server replays the search itself, resolves every id
 * against its *own* window, and deep-evaluates a bounded batch through the
 * Product Matcher, the Economics Engine, and the Opportunity Engine — then
 * returns the verdicts, ranked deterministically, with every failure reported
 * item by item. The browser never posts a product object, a price, or a
 * candidate; only opaque ids and a query (docs/ARCHITECTURE.md §15).
 *
 * Upstream budget per request (docs/API_INTEGRATIONS.md §3, §4): 1 eBay search,
 * reused as every item's competition evidence, plus ≤6 CJ calls per evaluated
 * listing, at bounded concurrency — so a full batch is 1 eBay + ≤36 CJ calls.
 */

// Assessments must always reflect fresh upstream round-trips.
export const dynamic = "force-dynamic";

/** Bounded request body: a scan request is a handful of ids, never a payload. */
const MAX_BODY_BYTES = 8_192;

/** History bounds, identical to the opportunity route's so a scan and a single
 * assessment read the same amount of context. */
const HISTORY_LIMITS: OpportunityLimits = {
  maxPriorAssessments: 3,
  maxPriceObservations: 10,
  maxCompetitionSample: 20,
};

export async function POST(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();

  // --- Configuration gates ---------------------------------------------------
  // Checked before any body is read: without both providers there is nothing to
  // scan, and the client gets the names of the variables it needs.
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
      "CJdropshipping is not configured on this server, so no opportunity can be assessed.",
      timestamp,
      "Set CJ_API_KEY in .env.local.",
    );
  }

  // --- Body ------------------------------------------------------------------
  const body = await readJsonObject(request, timestamp);
  if (body instanceof Response) {
    return body;
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  const mode: ScanMode | undefined =
    body.mode === "manual" || body.mode === "batch" ? body.mode : undefined;
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds : undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const destinationCountry =
    typeof body.destinationCountry === "string"
      ? body.destinationCountry.trim().toUpperCase()
      : undefined;

  const scanRequest: ScanRequest = {
    query,
    mode: mode ?? "batch",
    ...(itemIds !== undefined ? { itemIds: itemIds.map(String) } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(destinationCountry !== undefined ? { destinationCountry } : {}),
  };

  // A `manual` request without ids is a client bug, not a defaultable input.
  if (scanRequest.mode === "manual" && (scanRequest.itemIds?.length ?? 0) === 0) {
    return jsonError(
      400,
      "ITEMS_REQUIRED",
      "A manual scan needs at least one eBay item id selected from the results.",
      timestamp,
    );
  }

  const baseline = resolveShippingBaseline();
  const destination: ScanDestination = {
    countryCode: destinationCountry || baseline.countryCode,
    postalCode: baseline.postalCode,
    label:
      destinationCountry && destinationCountry !== baseline.countryCode
        ? `requested destination ${destinationCountry}`
        : baseline.label,
  };

  // --- Ports -----------------------------------------------------------------
  // Every external capability the scanner needs, constructed here so the
  // scanner stays testable with fakes and the call budget stays visible in one
  // place (docs/ARCHITECTURE.md §15.2).
  const ports: ScannerPorts = {
    searchMarketplace: (searchRequest) => new EbayAdapter().search(searchRequest),
    matchCandidates: (product) =>
      new ProductMatcher(new CjAdapter(), {
        maxResults: SCANNER_MATCH_MAX_RESULTS,
      }).findCandidates(product),
    computeEconomics: (economicsRequest) =>
      computeCandidateEconomics({
        candidate: economicsRequest.candidate,
        destination: economicsRequest.destination,
      }),
    readEvidence: (params) =>
      readOpportunityEvidence({ ...params, limits: HISTORY_LIMITS }),
    persistEvaluation: async (params) => {
      const result = await persistEvaluation({
        marketplaceProduct: params.marketplaceProduct,
        supplierProduct: params.candidate.supplierProduct,
        candidate: params.candidate,
        selectedVariant: params.selectedVariant,
        economics: params.economics,
      });
      return result.status === "ok" ? result.records : null;
    },
    persistAssessment: async (params) => {
      const result = await persistOpportunityAssessment(params);
      return mapPersistenceReport(result);
    },
  };

  try {
    const result = await runOpportunityScan({
      request: scanRequest,
      ports,
      destination,
      now: timestamp,
    });

    const response: ScannerSuccessResponse = { ...result, timestamp };
    return NextResponse.json(response, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return mapPipelineError(error, timestamp);
  }
}


/**
 * Reads and validates the request body as a plain object. Returns the parsed
 * object, or an already-built error response the route returns verbatim.
 */
async function readJsonObject(
  request: Request,
  timestamp: string,
): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonError(
      400,
      "MALFORMED_BODY",
      "Send a JSON body with Content-Type: application/json.",
      timestamp,
    );
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonError(400, "MALFORMED_BODY", "The request body could not be read.", timestamp);
  }

  if (text.length > MAX_BODY_BYTES) {
    return jsonError(
      413,
      "MALFORMED_BODY",
      "The request body is larger than this endpoint accepts.",
      timestamp,
    );
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonError(400, "MALFORMED_BODY", "The body must be a JSON object.", timestamp);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return jsonError(400, "MALFORMED_BODY", "The request body is not valid JSON.", timestamp);
  }
}

/** Translates a whole-pipeline failure into a safe HTTP response. */
function mapPipelineError(error: unknown, timestamp: string): Response {
  if (error instanceof ScanPipelineError) {
    const mapped = PIPELINE_ERROR_TO_HTTP[error.code] ?? {
      status: 500,
      message: "The scan could not run. Please try again.",
    };
    return jsonError(mapped.status, error.code, mapped.message, timestamp);
  }

  // A marketplace failure from the discovery window is the one upstream error
  // that can reach this far; it is mapped exactly as the other routes map it.
  const mapped = mapEbayError(error);
  console.error(
    "[scanner] unexpected pipeline failure:",
    error instanceof Error ? error.name : typeof error,
  );
  return jsonError(mapped.status, mapped.code, mapped.message, timestamp);
}

/** HTTP status + message per pipeline error code; codes travel to the client. */
const PIPELINE_ERROR_TO_HTTP: Record<
  ScanPipelineErrorCode,
  { status: number; message: string }
> = {
  INVALID_QUERY: {
    status: 400,
    message: "A search query of 1–100 characters is required.",
  },
  INVALID_MODE: { status: 400, message: 'Scan mode must be either "manual" or "batch".' },
  ITEMS_REQUIRED: {
    status: 400,
    message: "Select at least one listing from the results to scan it.",
  },
  INVALID_ITEM_ID: {
    status: 400,
    message: "One of the selected listings could not be identified.",
  },
  TOO_MANY_ITEMS: {
    status: 400,
    message: "Too many listings were selected for one scan.",
  },
  ITEM_NOT_RESOLVED: {
    status: 404,
    message: "None of the selected listings are still in the current search results.",
  },
  INVALID_DESTINATION: {
    status: 400,
    message: "The destination country code must be two letters (ISO 3166-1 alpha-2).",
  },
  DISCOVERY_FAILED: {
    status: 502,
    message: "The marketplace search backing this scan could not be completed.",
  },
};

/**
 * Converts the persistence layer's own result into the boundary's report shape,
 * so the scanner never re-announces a write that did not happen.
 */
function mapPersistenceReport(
  result: Awaited<ReturnType<typeof persistOpportunityAssessment>>,
): OpportunityPersistenceReport | undefined {
  switch (result.status) {
    case "ok":
      return { status: "ok", inserted: result.inserted };
    case "disabled":
      return { status: "disabled" };
    case "failed":
      console.error("[scanner] assessment persistence failed:", result.message);
      return { status: "failed", message: result.message };
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

function jsonError(
  status: number,
  code: ScannerErrorCode,
  message: string,
  timestamp: string,
  detail?: string,
): Response {
  const body: ScannerErrorResponse = {
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

