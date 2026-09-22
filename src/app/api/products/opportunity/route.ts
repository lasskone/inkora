import "server-only";

import { NextResponse } from "next/server";

import { CjAdapter } from "@/lib/cj/cj-adapter";
import { requireCjConfig } from "@/lib/cj/config";
import { EbayAdapter } from "@/lib/ebay/ebay-adapter";
import { resolveEbayConfig } from "@/lib/ebay/config";
import {
  resolveMarketplaceProduct,
  selectBestCandidate,
  selectCandidate,
} from "@/lib/products/candidate-resolution";
import type { CandidateResolutionPorts } from "@/lib/products/candidate-resolution";
import { mapCjError, mapEbayError } from "@/lib/products/upstream-errors";
import { computeCandidateEconomics } from "@/lib/economics/economics-service";
import { resolveShippingBaseline } from "@/lib/economics/config";
import { ProductMatcher } from "@/lib/matcher/matcher";
import { assessOpportunity } from "@/lib/opportunity/assess";
import type {
  CompetitionEvidence,
  OpportunityAssessment,
  OpportunityLimits,
} from "@/lib/opportunity/types";
import { persistEvaluation } from "@/lib/persistence/persistence-service";
import type { PersistedRecords } from "@/lib/persistence/persistence-service";
import {
  persistOpportunityAssessment,
  readOpportunityEvidence,
} from "@/lib/persistence/opportunity-persistence";
import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { MatchCandidate } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type { SupplierVariant } from "@/lib/supplier/types";
import type {
  OpportunityErrorCode,
  OpportunityErrorResponse,
  OpportunityPersistenceReport,
  OpportunitySuccessResponse,
} from "@/types/opportunity";

/**
 * Server-side Opportunity Engine boundary.
 *
 *   GET /api/products/opportunity?itemId=<ebayItemId>&q=<query>
 *      [&supplierProductId=<cjPid>][&destinationCountry=<ISO 3166-1 alpha-2>]
 *
 * The browser identifies an eBay listing it has already seen; the server
 * re-resolves it and re-runs the bounded matcher exactly as the economics route
 * does, through the *same* injected-port resolution flow, then hands the
 * replayed search window, the candidate, its economics, and the listing's
 * persisted history to the deterministic engine. The response is the engine's
 * assessment — never credentials, tokens, or raw upstream payloads.
 *
 * `supplierProductId` is optional. Given one, the route proves it is a matcher
 * candidate for this listing or refuses; without one it takes the matcher's best
 * candidate, and if the matcher surfaced none it still returns a complete,
 * explainable assessment — one that is hard-capped at `LOW` because nothing was
 * sourced, which is a verdict rather than an error.
 *
 * One user request produces the same bounded upstream budget as the economics
 * route: 1 eBay search (re-resolve, reused verbatim as competition evidence) +
 * ≤3 CJ searches (matcher) + 1 CJ variant query + 1–2 CJ freight calculations.
 * Competition evidence costs zero additional eBay calls (docs/API_INTEGRATIONS.md
 * §3, §4).
 */

// Assessments must always reflect fresh upstream round-trips.
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
 * economics route and docs/ARCHITECTURE.md §8.3).
 */
const EBAY_RESOLVE_LIMIT = 24;

/**
 * How many matcher candidates to rank. The assessment economicses at most one
 * candidate — the best, or the one the caller named — so this bounds discovery,
 * not work.
 */
const OPPORTUNITY_MATCH_MAX_RESULTS = 10;

/**
 * Hard bounds on how much evidence one assessment may consume
 * (docs/API_INTEGRATIONS.md §4). Declared here and passed *into* the engine
 * rather than read inside it, so the route pins exactly how much history any
 * single assessment could have used — the same numbers a unit test pins.
 */
const OPPORTUNITY_LIMITS: OpportunityLimits = {
  maxPriorAssessments: 3,
  maxPriceObservations: 10,
  maxCompetitionSample: 20,
};

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
  if (supplierProductId !== "" && !SUPPLIER_PRODUCT_ID_PATTERN.test(supplierProductId)) {
    return jsonError(
      400,
      "INVALID_SUPPLIER_PRODUCT_ID",
      "A supplier product id, when provided, must be a valid supplier product id.",
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
      "CJdropshipping is not configured on this server, so no opportunity can be assessed.",
      timestamp,
      "Set CJ_API_KEY in .env.local.",
    );
  }

  // --- Re-resolve the eBay listing -----------------------------------------
  // Shared with the economics route (docs/ARCHITECTURE.md §8.3): one replayed
  // eBay search plus one bounded matcher run, with adapters injected so the
  // upstream budget of this request stays visible in one place.
  const ports: CandidateResolutionPorts = {
    searchMarketplace: (searchRequest) => new EbayAdapter().search(searchRequest),
    matchCandidates: (product) =>
      new ProductMatcher(new CjAdapter(), {
        maxResults: OPPORTUNITY_MATCH_MAX_RESULTS,
      }).findCandidates(product),
  };

  const marketplace = await resolveMarketplaceProduct({
    ports,
    itemId,
    query,
    resolveLimit: EBAY_RESOLVE_LIMIT,
  });
  if (marketplace.status === "item-not-found") {
    return jsonError(
      404,
      "ITEM_NOT_RESOLVED",
      "This listing is no longer in the current search results.",
      timestamp,
    );
  }
  if (marketplace.status === "marketplace-error") {
    const mapped = mapEbayError(marketplace.error);
    return jsonError(mapped.status, mapped.code, mapped.message, timestamp, mapped.detail);
  }
  const { product: marketplaceProduct, searchResult } = marketplace;

  // --- Re-run the matcher ---------------------------------------------------
  const selection =
    supplierProductId === ""
      ? await selectBestCandidate(ports, marketplaceProduct)
      : await selectCandidate({ ports, marketplaceProduct, supplierProductId });

  if (selection.status === "supplier-error") {
    const mapped = mapCjError(selection.error);
    if (mapped !== null) {
      return jsonError(mapped.status, mapped.code, mapped.message, timestamp, mapped.detail);
    }
    console.error(
      "[products/opportunity] unexpected matcher failure:",
      selection.error instanceof Error ? selection.error.name : typeof selection.error,
    );
    return jsonError(
      500,
      "INTERNAL_ERROR",
      "An unexpected error occurred while re-running the Product Matcher.",
      timestamp,
    );
  }

  // A requested supplier product that is not a candidate is a refusal, not an
  // assessment: the opportunity this route scores is marketplace × *that*
  // supplier, so it does not exist. The same holds when the caller named a
  // supplier and the matcher surfaced no candidate at all — a named supplier
  // that cannot be matched is a 404, never a verdict.
  if (
    selection.status === "not-a-candidate" ||
    (selection.status === "no-candidates" && supplierProductId !== "")
  ) {
    return jsonError(
      404,
      "CANDIDATE_NOT_FOUND",
      supplierProductId === ""
        ? "The Product Matcher surfaced no candidate for this listing, so no opportunity can be assessed."
        : "This supplier product is not a matcher candidate for this listing, so no opportunity can be assessed.",
      timestamp,
    );
  }

  // With no supplier requested, an empty candidate list is an assessable state:
  // the engine scores a `null` candidate as hard-capped at LOW, which is a
  // verdict about the listing rather than an error.
  const matchResult = selection.matchResult;
  const candidate = selection.status === "selected" ? selection.candidate : null;

  // --- Economics for the candidate -----------------------------------------
  // Economics are an *input* to the score, so a supplier failure here is fatal
  // to the request: the engine accepts `economics: null` for a candidate whose
  // economics could not be computed, but a CJ outage must never be dressed up as
  // a verdict. Mapping it keeps the failure honest and retryable, exactly as the
  // economics route does.
  const baseline = resolveShippingBaseline();
  const destination = {
    countryCode: destinationOverride || baseline.countryCode,
    postalCode: baseline.postalCode,
    label:
      destinationOverride && destinationOverride !== baseline.countryCode
        ? `requested destination ${destinationOverride}`
        : baseline.label,
  };

  let economics: EconomicsResult | null = null;
  let evaluation: PersistedRecords | null = null;
  if (candidate !== null) {
    try {
      const outcome = await computeCandidateEconomics({ candidate, destination });
      economics = outcome.result;

      // Persist the evaluation so the assessment can link to its records and
      // later assessments can read it as history. Best-effort
      // (docs/ARCHITECTURE.md §13): a failure is reported and logged and the
      // assessment is still written — without the supplier linkage, which is
      // the honest shape when no evaluation records exist to link to.
      evaluation = await persistEvaluationSafe({
        marketplaceProduct,
        candidate,
        economics: outcome.result,
        selectedVariant: outcome.selectedVariant,
      });
    } catch (error) {
      const mapped = mapCjError(error);
      if (mapped !== null) {
        return jsonError(mapped.status, mapped.code, mapped.message, timestamp, mapped.detail);
      }

      console.error(
        "[products/opportunity] unexpected failure:",
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

  // --- Read the history the engine is allowed to see -----------------------
  // Deliberately read *before* the assessment is persisted: history is what the
  // verdict is based on, so a fresh assessment must never count itself as its
  // own prior. `null` means never observed yet — a normal first assessment.
  const history = await readOpportunityEvidence({
    marketplace: marketplaceProduct.marketplace,
    marketplaceExternalId: marketplaceProduct.externalId,
    supplierExternalId: candidate?.supplierProduct.externalId ?? null,
    limits: OPPORTUNITY_LIMITS,
  });

  // --- Assess ---------------------------------------------------------------
  // The replayed search window *is* the competition evidence — verbatim, with
  // no second eBay call. The engine derives competition from it and records the
  // query, because a result count without its query is not a comparable number.
  const competition: CompetitionEvidence = {
    query: searchResult.query,
    searchResult,
  };

  const assessment = assessOpportunity({
    marketplaceProduct,
    candidate,
    economics,
    supplierQueries: matchResult.queries.map((queryOutcome) => queryOutcome.query),
    supplierCandidateCount: matchResult.candidates.length,
    competition,
    history,
    now: timestamp,
    limits: OPPORTUNITY_LIMITS,
  });

  // --- Persist the assessment as history ------------------------------------
  const persistence = await persistAssessmentSafe({
    assessment,
    marketplaceProduct,
    evaluation,
  });

  const body: OpportunitySuccessResponse = {
    status: "ok",
    assessment,
    persistence,
    timestamp,
  };

  return NextResponse.json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Persists one economics evaluation, returning the records an assessment can
 * link to — or `null` when persistence is disabled or failed, in which case the
 * assessment is still written without a supplier linkage. Never throws
 * (docs/ARCHITECTURE.md §13).
 */
async function persistEvaluationSafe(args: {
  marketplaceProduct: MarketplaceProduct;
  candidate: MatchCandidate;
  economics: EconomicsResult;
  selectedVariant: SupplierVariant | null;
}): Promise<PersistedRecords | null> {
  const result = await persistEvaluation({
    marketplaceProduct: args.marketplaceProduct,
    supplierProduct: args.candidate.supplierProduct,
    candidate: args.candidate,
    selectedVariant: args.selectedVariant,
    economics: args.economics,
  });

  if (result.status === "ok") {
    return result.records;
  }

  if (result.status === "failed") {
    console.error("[products/opportunity] evaluation persistence failed:", result.message);
  }
  return null;
}

/**
 * Appends one assessment as a historical observation, classifying the outcome
 * for the response without ever throwing. An assessment is never overwritten:
 * a re-evaluation appends a new row so an old score stays attributable to the
 * engine version and evidence that produced it.
 */
async function persistAssessmentSafe(args: {
  assessment: OpportunityAssessment;
  marketplaceProduct: MarketplaceProduct;
  evaluation: PersistedRecords | null;
}): Promise<OpportunityPersistenceReport | undefined> {
  const result = await persistOpportunityAssessment({
    assessment: args.assessment,
    marketplaceProduct: args.marketplaceProduct,
    evaluation: args.evaluation,
  });

  switch (result.status) {
    case "ok":
      return { status: "ok", inserted: result.inserted };

    case "disabled":
      return { status: "disabled" };

    case "failed":
      // Reported, not swallowed: the response carries the failure honestly.
      console.error("[products/opportunity] assessment persistence failed:", result.message);
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
  code: OpportunityErrorCode,
  message: string,
  timestamp: string,
  detail?: string,
): Response {
  const body: OpportunityErrorResponse = {
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


