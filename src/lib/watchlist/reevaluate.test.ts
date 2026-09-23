/**
 * Manual re-evaluation tests (docs/ARCHITECTURE.md §16.4).
 *
 * Injected with fake ports on purpose, exactly like the scanner tests: these pin
 * what one re-evaluation does with each upstream state, without any network, so
 * a change to the orchestration surfaces here before it reaches the route.
 *
 * The contracts that matter most, all pinned below:
 *   - **candidate re-proof, never substitution** — a saved supplier that is no
 *     longer a matcher candidate yields `candidate-not-resolved`, the entry is
 *     untouched, and a different supplier product is never swapped in;
 *   - **no stale browser economics** — every figure is re-derived server-side;
 *   - **the prior is read before the new assessment is persisted**, so a fresh
 *     assessment never compares against itself;
 *   - **failure isolation** — every failure becomes an explicit outcome and
 *     leaves the entry and its history untouched;
 *   - a provider configuration failure is reported as `upstream-error` with a
 *     `*_NOT_CONFIGURED` code, which the boundary re-labels 503
 *     `not-configured` (docs/API_INTEGRATIONS.md §5).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CjConfigError } from "@/lib/cj/errors";
import { EbayApiError, EbayConfigError } from "@/lib/ebay/errors";
import type { MarketplaceProduct, MarketplaceSearchResult } from "@/lib/marketplace/types";
import type { MatchCandidate, MatchResult, MatcherLimits } from "@/lib/matcher/types";
import { MATCHER_VERSION } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type { SupplierProduct } from "@/lib/supplier/types";
import type { HistoryEvidenceSummary } from "@/lib/opportunity/types";

import { reevaluateBatch, reevaluateEntry } from "./reevaluate";
import { responseOutcome } from "./watchlist-http";
import {
  WATCHLIST_CONCURRENCY,
  WATCHLIST_MAX_RE_EVALUATIONS,
  WATCHLIST_RESOLVE_LIMIT,
} from "./limits";
import type {
  PreviousObservation,
  ReEvaluationResult,
  WatchlistEntrySnapshot,
  WatchlistPorts,
} from "./types";
import type { ScanDestination } from "@/lib/scanner/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-09-22T00:00:00.000Z";
const ENTRY_ID = "11111111-1111-1111-1111-111111111111";
const ITEM_ID = "v1|1000000001";
const SUPPLIER_ID = "cj-product-1";
const QUERY = "anker soundcore life q30";

const DESTINATION: ScanDestination = {
  countryCode: "US",
  postalCode: null,
  label: "baseline destination US",
};

const MATCHER_LIMITS: MatcherLimits = {
  maxQueries: 3,
  perQueryLimit: 10,
  maxCandidates: 10,
  maxResults: 10,
  maxInventoryLookups: 0,
};

function makeListing(overrides: Partial<MarketplaceProduct> = {}): MarketplaceProduct {
  return {
    marketplace: "ebay",
    externalId: ITEM_ID,
    title: "Anker Soundcore Life Q30 Headphones",
    imageUrl: null,
    listingUrl: null,
    price: "79.99",
    currency: "USD",
    condition: "NEW",
    sellerName: "seller-one",
    sellerFeedbackPercentage: null,
    shippingCost: "0.00",
    shippingCurrency: "USD",
    location: null,
    provenance: "OFFICIAL",
    fetchedAt: NOW,
    ...overrides,
  };
}

function makeSupplier(overrides: Partial<SupplierProduct> = {}): SupplierProduct {
  return {
    supplier: "cj",
    externalId: SUPPLIER_ID,
    sku: "CJ-SKU-1",
    title: "Anker Soundcore Life Q30 Headphones",
    imageUrl: null,
    productUrl: null,
    category: null,
    supplierPrice: "41.50",
    currency: "USD",
    availableInventory: null,
    warehouseCountry: null,
    shippingOrigin: null,
    variants: [],
    provenance: "OFFICIAL",
    fetchedAt: NOW,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    marketplaceProduct: makeListing(),
    supplierProduct: makeSupplier(),
    confidence: 72,
    confidenceBand: "MEDIUM",
    signals: [],
    contradictions: [],
    explanation: "plausible candidate",
    foundByQueries: [QUERY],
    usWarehouseInventory: null,
    confidenceProvenance: "ESTIMATED",
    ...overrides,
  };
}

function makeMatchResult(
  candidates: MatchCandidate[],
  product: MarketplaceProduct,
): MatchResult {
  return {
    marketplaceProduct: product,
    supplier: "cj",
    queries: [{ query: QUERY, rationale: "title tokens", count: candidates.length, failure: null }],
    candidates,
    limits: MATCHER_LIMITS,
    matcherVersion: MATCHER_VERSION,
  };
}

function makeSearchResult(products: MarketplaceProduct[]): MarketplaceSearchResult {
  return {
    query: QUERY,
    limit: WATCHLIST_RESOLVE_LIMIT,
    offset: 0,
    total: products.length,
    count: products.length,
    products,
  };
}


function makeEconomics(overrides: Partial<EconomicsResult> = {}): EconomicsResult {
  return {
    marketplace: "ebay",
    marketplaceItemId: ITEM_ID,
    itemPrice: "79.99",
    buyerShipping: "0.00",
    grossMarketplaceRevenue: "79.99",
    currency: "USD",
    supplier: "cj",
    supplierProductId: SUPPLIER_ID,
    selectedVariant: { externalId: "vid-1", sku: "CJ-SKU-1", title: null },
    supplierProductCost: "41.50",
    supplierCostBasis: "SELECTED_VARIANT",
    supplierShippingCost: "9.20",
    supplierShippingMethod: "USPS+",
    supplierShippingTransitTime: "2-5",
    shippingQuotes: [],
    shippingDestination: { countryCode: "US", postalCode: null, label: "US" },
    landedSupplierCost: "50.70",
    marketplaceFee: "10.59",
    feeBreakdown: [],
    feeEngineVersion: "ebay-fee-rules-1.0",
    feeStatus: "ESTIMATED",
    feeRuleSource: "published policy",
    estimatedProfit: "18.70",
    marginPercent: "23.50",
    completeness: "COMPLETE",
    economicsEngineVersion: "economics-landed-1.0",
    provenance: {
      itemPrice: "OFFICIAL",
      buyerShipping: "OFFICIAL",
      supplierProductCost: "OFFICIAL",
      supplierShippingCost: "OFFICIAL",
      marketplaceFee: "ESTIMATED",
      estimatedProfit: "ESTIMATED",
      marginPercent: "ESTIMATED",
    },
    assumptions: [],
    warnings: [],
    calculatedAt: NOW,
    ...overrides,
  };
}

const EMPTY_HISTORY: HistoryEvidenceSummary = {
  snapshotCount: 0,
  matchObservationCount: 0,
  economicsObservationCount: 0,
  firstSeenAt: null,
  lastSeenAt: null,
  priceObservations: [],
  priorAssessments: [],
};

function makeEntry(overrides: Partial<WatchlistEntrySnapshot> = {}): WatchlistEntrySnapshot {
  return {
    id: ENTRY_ID,
    marketplaceExternalId: ITEM_ID,
    supplierExternalId: SUPPLIER_ID,
    replayQuery: QUERY,
    archivedAt: null,
    ...overrides,
  };
}

function makePrevious(overrides: Partial<PreviousObservation> = {}): PreviousObservation {
  return {
    assessment: {
      engineVersion: "opportunity-v1",
      calculatedAt: "2026-09-15T00:00:00.000Z",
      marketplace: "ebay",
      marketplaceExternalId: ITEM_ID,
      supplier: "cj",
      supplierExternalId: SUPPLIER_ID,
      score: 55,
      band: "MEDIUM",
      confidence: 55,
      confidenceLevel: "MEDIUM",
      components: {
        economics: {
          completeness: "COMPLETE",
          estimatedProfit: "15.00",
          marginPercent: 18,
          supplierCostBasis: "SELECTED_VARIANT",
          score: 70,
          rationale: "complete economics",
          warnings: [],
          assumptions: [],
          economicsEngineVersion: "economics-landed-1.0",
          feeEngineVersion: "ebay-fee-rules-1.0",
        },
        match: {
          confidence: 70,
          confidenceBand: "MEDIUM",
          score: 70,
          explanation: "plausible candidate",
          signals: [],
          contradictions: [],
          cappedByHardContradiction: false,
          supplierExternalId: SUPPLIER_ID,
        },
        competition: {
          verdict: "APPEARS_MODERATE",
          intensity: 45,
          score: 55,
          query: QUERY,
          searchResultTotal: 120,
          sampleSize: 10,
          distinctSellers: 8,
          similarlyPricedListings: 3,
          newConditionListings: 7,
          caveats: ["one query is a sample, not a census"],
        },
        demand: {
          verdict: "INSUFFICIENT_EVIDENCE",
          score: 0,
          evidence: [],
          limitations: ["no demand evidence available"],
          listingPersistence: null,
          sourcing: { queries: 1, candidateCount: 1, note: "one candidate" },
        },
        dataQuality: {
          score: 80,
          dimensions: [],
          evidence: ["title", "price", "seller"],
          limitations: [],
        },
      },
      factors: [],
      caps: [],
      headline: "a plausible opportunity",
      explanation: ["one line"],
      caveats: ["not a prediction"],
      inputs: {
        marketplaceSnapshotObservedAt: NOW,
        supplierSnapshotObservedAt: NOW,
        economicsCalculatedAt: NOW,
        competitionQuery: QUERY,
        historyAvailable: false,
      },
    },
    money: {
      marketplacePriceCents: 7999,
      supplierCostCents: 4150,
      supplierShippingCents: 900,
      landedCostCents: 5050,
      estimatedProfitCents: 1500,
      marginPercent: 18,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------

interface FakePortsOptions {
  entry?: WatchlistEntrySnapshot | null;
  previous?: PreviousObservation | null;
  /** Products the replayed search window returns; defaults to the watched one. */
  products?: MarketplaceProduct[];
  /** Candidates the matcher returns for the listing. */
  candidates?: MatchCandidate[];
  /** When set, `computeEconomics` throws for every candidate. */
  economicsError?: Error;
  /** When set, `searchMarketplace` throws, failing the replay. */
  searchError?: Error;
  economics?: EconomicsResult | null;
  history?: HistoryEvidenceSummary | null;
  /** When true, `persistAssessment` reports a failure instead of ok. */
  persistenceFailure?: boolean;
  /** When true, `readPreviousObservation` throws, so no comparison is possible. */
  previousReadFails?: boolean;
}

interface FakePortsRecord {
  searches: number;
  matches: number;
  economics: number;
  assessmentsPersisted: number;
  evaluationsPersisted: number;
  /** In-order call log, so a test can prove the prior read precedes the write. */
  calls: string[];
  scopes: Array<{ marketplaceExternalId: string; supplierExternalId: string | null }>;
  evidenceScopes: Array<{ marketplaceExternalId: string; supplierExternalId: string | null }>;
}

function fakePorts(options: FakePortsOptions, record: FakePortsRecord): WatchlistPorts {
  const products = options.products ?? [makeListing()];
  const candidates = options.candidates ?? [makeCandidate()];

  return {
    async readEntry() {
      return options.entry === undefined ? makeEntry() : options.entry;
    },
    async readPreviousObservation(scope) {
      record.scopes.push(scope);
      record.calls.push("readPreviousObservation");
      if (options.previousReadFails) {
        throw new Error("the observation store is unreachable");
      }
      return options.previous === undefined ? makePrevious() : options.previous;
    },
    async searchMarketplace() {
      record.searches += 1;
      record.calls.push("searchMarketplace");
      if (options.searchError) {
        throw options.searchError;
      }
      return makeSearchResult(products);
    },
    async matchCandidates(product) {
      record.matches += 1;
      record.calls.push("matchCandidates");
      return makeMatchResult(candidates, product);
    },
    async computeEconomics() {
      record.economics += 1;
      record.calls.push("computeEconomics");
      if (options.economicsError) {
        throw options.economicsError;
      }
      return {
        result: options.economics ?? makeEconomics(),
        selectedVariant: {
          externalId: "vid-1",
          sku: "CJ-SKU-1",
          title: null,
          price: "41.50",
          availableInventory: null,
        },
      };
    },
    async readEvidence(scope) {
      record.evidenceScopes.push(scope);
      return options.history === undefined ? EMPTY_HISTORY : options.history;
    },
    async persistEvaluation() {
      record.evaluationsPersisted += 1;
      return null;
    },
    async persistAssessment() {
      record.assessmentsPersisted += 1;
      record.calls.push("persistAssessment");
      return options.persistenceFailure
        ? { status: "failed", message: "storage unavailable" }
        : { status: "ok", inserted: true };
    },
  };
}

async function reevaluate(
  options: FakePortsOptions = {},
): Promise<{ result: ReEvaluationResult; record: FakePortsRecord }> {
  const record: FakePortsRecord = {
    searches: 0,
    matches: 0,
    economics: 0,
    assessmentsPersisted: 0,
    evaluationsPersisted: 0,
    calls: [],
    scopes: [],
    evidenceScopes: [],
  };
  const result = await reevaluateEntry({
    ports: fakePorts(options, record),
    entryId: ENTRY_ID,
    destination: DESTINATION,
    now: NOW,
  });
  return { result, record };
}

// ---------------------------------------------------------------------------
// Entry state
// ---------------------------------------------------------------------------

test("an entry that does not exist is reported, not evaluated", async () => {
  const { result } = await reevaluate({ entry: null });

  assert.equal(result.outcome, "entry-not-found");
  assert.equal(result.assessment, null);
  assert.equal(result.comparison, null);
  assert.equal(result.entryId, ENTRY_ID);
});

test("an archived entry is refused, not silently re-evaluated", async () => {
  const { result } = await reevaluate({
    entry: makeEntry({ archivedAt: "2026-09-10T00:00:00.000Z" }),
  });

  assert.equal(result.outcome, "archived");
  assert.equal(result.assessment, null);
});

test("an archived entry issues no upstream calls", async () => {
  const { result, record } = await reevaluate({
    entry: makeEntry({ archivedAt: "2026-09-10T00:00:00.000Z" }),
  });

  assert.equal(result.outcome, "archived");
  assert.equal(record.searches, 0, "no marketplace search is replayed");
  assert.equal(record.matches, 0, "no matcher call is made");
  assert.equal(record.economics, 0, "no economics are computed");
  assert.equal(record.assessmentsPersisted, 0, "nothing is persisted");
});

// ---------------------------------------------------------------------------
// Re-resolution
// ---------------------------------------------------------------------------

test("a listing that scrolled out of the replayed window is reported as unavailable", async () => {
  const { result, record } = await reevaluate({
    products: [makeListing({ externalId: "v1|9999999999" })],
  });

  assert.equal(result.outcome, "listing-unavailable");
  assert.equal(result.failureCode, "ITEM_NOT_RESOLVED");
  assert.ok(result.failureMessage);
  assert.equal(result.assessment, null);
  assert.equal(record.searches, 1, "the search is replayed once");
  assert.equal(record.assessmentsPersisted, 0, "nothing is persisted");
});

test("a marketplace failure during replay is an upstream error", async () => {
  const { result } = await reevaluate({
    searchError: new EbayApiError("eBay is throttling", { status: 429 }),
  });

  assert.equal(result.outcome, "upstream-error");
  assert.equal(result.failureCode, "EBAY_RATE_LIMITED");
  assert.equal(result.assessment, null);
});

test("the replay re-searches the saved query at the documented resolve limit", async () => {
  const { record } = await reevaluate();

  assert.equal(record.searches, 1);
  assert.equal(record.matches, 1);
  assert.equal(record.economics, 1);
});

// ---------------------------------------------------------------------------
// Candidate re-proof — never substitution
// ---------------------------------------------------------------------------

test("a saved supplier that is no longer a candidate yields candidate-not-resolved", async () => {
  // The matcher now surfaces a *different* supplier product for this listing.
  const replacement = makeCandidate({
    supplierProduct: makeSupplier({ externalId: "cj-a-different-product" }),
  });
  const { result } = await reevaluate({ candidates: [replacement] });

  assert.equal(result.outcome, "candidate-not-resolved");
  assert.equal(result.failureCode, "CANDIDATE_NOT_FOUND");
  assert.ok(
    result.failureMessage?.includes("not been substituted"),
    "the message states plainly that nothing was substituted",
  );
  assert.equal(result.assessment, null, "no assessment is produced");
  assert.equal(result.comparison, null);
});

test("candidate-not-resolved persists nothing and runs no economics", async () => {
  const replacement = makeCandidate({
    supplierProduct: makeSupplier({ externalId: "cj-a-different-product" }),
  });
  const { record } = await reevaluate({ candidates: [replacement] });

  assert.equal(record.economics, 0, "the replacement candidate is never costed");
  assert.equal(record.assessmentsPersisted, 0, "no assessment is written");
  assert.equal(record.evaluationsPersisted, 0);
});

test("the entry's own supplier id is what the re-proof checks, not the matcher's best guess", async () => {
  // Best candidate is the saved one, but a second candidate also exists; the
  // re-proof must still select by the entry's saved supplier id.
  const saved = makeCandidate();
  const other = makeCandidate({
    supplierProduct: makeSupplier({ externalId: "cj-other" }),
    confidence: 30,
  });

  const { result } = await reevaluate({ candidates: [saved, other] });
  assert.equal(result.outcome, "evaluated");
  assert.equal(result.assessment?.supplierExternalId, SUPPLIER_ID);
});

test("a marketplace-only watch takes the matcher's current best candidate", async () => {
  const best = makeCandidate({
    supplierProduct: makeSupplier({ externalId: "cj-best-available" }),
  });
  const { result, record } = await reevaluate({
    entry: makeEntry({ supplierExternalId: null }),
    candidates: [best],
  });

  assert.equal(result.outcome, "evaluated");
  assert.equal(result.assessment?.supplierExternalId, "cj-best-available");
  assert.equal(
    record.scopes[0]?.supplierExternalId,
    null,
    "the prior is read for the no-supplier scope",
  );
});

test("a marketplace-only watch with no candidates is a verdict, not an error", async () => {
  const { result } = await reevaluate({
    entry: makeEntry({ supplierExternalId: null }),
    candidates: [],
  });

  assert.equal(result.outcome, "no-candidates");
  assert.ok(result.assessment, "the engine still produces a hard-capped assessment");
  assert.equal(result.assessment?.supplierExternalId, "");
  assert.equal(result.comparison?.noPrevious, false);
});

// ---------------------------------------------------------------------------
// Economics
// ---------------------------------------------------------------------------

test("economics that cannot be computed is an honest verdict, not an error", async () => {
  const { result, record } = await reevaluate({
    economicsError: new CjConfigError("CJ_API_KEY is not set"),
  });

  assert.equal(result.outcome, "upstream-error");
  assert.equal(result.failureCode, "CJ_NOT_CONFIGURED");
  assert.equal(result.assessment, null);
  assert.equal(record.assessmentsPersisted, 0);
});

test("a CJ configuration failure maps to the 503 not-configured outcome", async () => {
  const { result } = await reevaluate({
    economicsError: new CjConfigError("CJ_API_KEY is not set"),
  });

  // The orchestrator reports it as an upstream error; the boundary re-labels
  // it so the status is 503 (the operator's fix) rather than 502.
  assert.equal(result.failureCode, "CJ_NOT_CONFIGURED");
  assert.equal(responseOutcome(result), "not-configured");
});

test("an eBay configuration failure also maps to not-configured", async () => {
  const { result } = await reevaluate({
    searchError: new EbayConfigError("eBay is not configured"),
  });

  assert.equal(result.failureCode, "EBAY_NOT_CONFIGURED");
  assert.equal(responseOutcome(result), "not-configured");
});

test("an UNAVAILABLE economics result is reported, with the assessment kept", async () => {
  const { result } = await reevaluate({
    economics: makeEconomics({
      completeness: "UNAVAILABLE",
      estimatedProfit: null,
      marginPercent: null,
    }),
  });

  assert.equal(result.outcome, "economics-unavailable");
  assert.ok(result.assessment, "the engine still returns a full assessment");
  assert.equal(result.assessment?.components.economics.completeness, "UNAVAILABLE");
});

test("a successful re-evaluation produces the evaluated outcome and a comparison", async () => {
  const { result, record } = await reevaluate();

  assert.equal(result.outcome, "evaluated");
  assert.ok(result.assessment);
  assert.ok(result.comparison);
  assert.equal(result.assessment?.supplierExternalId, SUPPLIER_ID);
  assert.equal(record.assessmentsPersisted, 1, "the fresh assessment is persisted");
  assert.ok(result.durationMs >= 0);
  assert.equal(result.evaluatedAt, NOW);
});

test("the assessment is anchored to the injected now, not to wall-clock time", async () => {
  const { result } = await reevaluate();
  assert.equal(result.assessment?.calculatedAt, NOW);
});

// ---------------------------------------------------------------------------
// Prior ordering and comparison
// ---------------------------------------------------------------------------

test("the prior observation is read before the new assessment is persisted", async () => {
  const { record } = await reevaluate();

  const priorIndex = record.calls.indexOf("readPreviousObservation");
  const persistIndex = record.calls.indexOf("persistAssessment");

  assert.notEqual(priorIndex, -1, "the prior was read");
  assert.notEqual(persistIndex, -1, "the assessment was persisted");
  assert.ok(
    priorIndex < persistIndex,
    "a fresh assessment must never count itself as its own prior",
  );
});

test("a first evaluation reports noPrevious rather than an empty comparison", async () => {
  const { result } = await reevaluate({ previous: null });

  assert.equal(result.outcome, "evaluated");
  assert.equal(result.comparison?.noPrevious, true);
  assert.equal(result.comparison?.previousCalculatedAt, null);
  assert.equal(result.comparison?.currentCalculatedAt, NOW);
  // A first evaluation carries no deltas at all — the honest "nothing to compare
  // against", not a list of zeros that would read as "nothing changed".
  assert.equal(result.comparison?.numeric.length, 0);
  assert.equal(result.comparison?.categorical.length, 0);
});

test("a failed prior read yields no comparison, distinct from a first evaluation", async () => {
  const { result } = await reevaluate({ previousReadFails: true });

  assert.equal(result.outcome, "evaluated");
  assert.equal(
    result.comparison,
    null,
    "a read failure is `null`, not `noPrevious` — a different fact",
  );
  assert.ok(result.assessment, "the assessment is still produced and persisted");
});

test("a comparison reports the change since the previous evaluation", async () => {
  const { result } = await reevaluate();

  assert.equal(result.comparison?.noPrevious, false);
  assert.equal(result.comparison?.previousCalculatedAt, "2026-09-15T00:00:00.000Z");
  assert.equal(result.comparison?.currentCalculatedAt, NOW);

  const profit = result.comparison?.numeric.find((delta) => delta.field === "estimatedProfit");
  assert.ok(profit, "profit is compared");
  assert.equal(profit?.previous, "15.00");
  assert.equal(profit?.current, "18.70");
  assert.equal(profit?.delta, "3.70");
  assert.equal(profit?.direction, "up");
});

test("a persistence failure is reported but the assessment is still returned", async () => {
  const { result } = await reevaluate({ persistenceFailure: true });

  assert.equal(result.outcome, "evaluated");
  assert.ok(result.assessment);
  assert.equal(result.persistence?.status, "failed");

// ---------------------------------------------------------------------------
// Bounded batch re-evaluation
// ---------------------------------------------------------------------------

/** N distinct uuids, so a batch always has something to name. */
function batchIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${index.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`,
  );
}

function makeBatchPorts(options: FakePortsOptions, record: FakePortsRecord): WatchlistPorts {
  const ports = fakePorts(options, record);
  return {
    ...ports,
    readEntry: async (id: string) => makeEntry({ id }),
  };
}

async function reevaluateBatchFor(
  entryIds: string[],
  options: FakePortsOptions = {},
): Promise<{ batch: import("./types").ReEvaluationBatchResult; record: FakePortsRecord }> {
  const record: FakePortsRecord = {
    searches: 0,
    matches: 0,
    economics: 0,
    assessmentsPersisted: 0,
    evaluationsPersisted: 0,
    calls: [],
    scopes: [],
    evidenceScopes: [],
  };
  const batch = await reevaluateBatch({
    ports: makeBatchPorts(options, record),
    entryIds,
    destination: DESTINATION,
    now: NOW,
  });
  return { batch, record };
}

test("a batch evaluates every named entry and reports ok", async () => {
  const { batch } = await reevaluateBatchFor(batchIds(3));

  assert.equal(batch.status, "ok");
  assert.equal(batch.results.length, 3);
  assert.deepEqual(
    batch.results.map((result) => result.outcome),
    ["evaluated", "evaluated", "evaluated"],
  );
});

test("a batch preserves the caller's order in its results", async () => {
  const ids = batchIds(4);
  const { batch } = await reevaluateBatchFor(ids);

  assert.deepEqual(
    batch.results.map((result) => result.entryId),
    ids,
  );
});

test("a batch de-duplicates its ids while preserving order", async () => {
  const ids = batchIds(3);
  const { batch } = await reevaluateBatchFor([ids[0], ids[0], ids[1], ids[0], ids[2]]);

  assert.equal(batch.results.length, 3);
  assert.deepEqual(batch.results.map((result) => result.entryId), ids);
});

test(`a batch never processes more than ${WATCHLIST_MAX_RE_EVALUATIONS} entries`, async () => {
  const ids = batchIds(WATCHLIST_MAX_RE_EVALUATIONS + 4);
  const { batch } = await reevaluateBatchFor(ids);

  assert.equal(batch.results.length, WATCHLIST_MAX_RE_EVALUATIONS);
  assert.equal(batch.limits.maxReEvaluations, WATCHLIST_MAX_RE_EVALUATIONS);
});

test("a batch reports partial when one entry fails", async () => {
  const ids = batchIds(3);
  const record: FakePortsRecord = {
    searches: 0,
    matches: 0,
    economics: 0,
    assessmentsPersisted: 0,
    evaluationsPersisted: 0,
    calls: [],
    scopes: [],
    evidenceScopes: [],
  };
  const ports = makeBatchPorts({}, record);
  const batch = await reevaluateBatch({
    ports: {
      ...ports,
      readEntry: async (id: string) =>
        id === ids[1] ? null : makeEntry({ id }),
    },
    entryIds: ids,
    destination: DESTINATION,
    now: NOW,
  });

  assert.equal(batch.status, "partial");
  assert.equal(batch.results[1]?.outcome, "entry-not-found");
  assert.equal(batch.results[0]?.outcome, "evaluated");
  assert.equal(batch.results[2]?.outcome, "evaluated");
});

test("a batch isolates a candidate-not-resolved failure to its own entry", async () => {
  const ids = batchIds(2);
  const replacement = makeCandidate({
    supplierProduct: makeSupplier({ externalId: "cj-a-different-product" }),
  });
  const saved = makeCandidate();
  const record: FakePortsRecord = {
    searches: 0,
    matches: 0,
    economics: 0,
    assessmentsPersisted: 0,
    evaluationsPersisted: 0,
    calls: [],
    scopes: [],
    evidenceScopes: [],
  };
  const ports = makeBatchPorts({}, record);

  // Route each entry's matcher result by the entry id the re-proof is running
  // for, since the listing external id is shared in this fixture.
  let currentEntryId = "";
  const batch = await reevaluateBatch({
    ports: {
      ...ports,
      readEntry: async (id: string) => {
        currentEntryId = id;
        return id === ids[0]
          ? makeEntry({ id, supplierExternalId: "cj-gone" })
          : makeEntry({ id, supplierExternalId: SUPPLIER_ID });
      },
      matchCandidates: async (product) =>
        makeMatchResult(currentEntryId === ids[0] ? [replacement] : [saved], product),
    },
    entryIds: ids,
    destination: DESTINATION,
    now: NOW,
  });

  assert.equal(batch.status, "partial");
  assert.equal(batch.results[0]?.outcome, "candidate-not-resolved");
  assert.equal(batch.results[1]?.outcome, "evaluated");
});

test("a batch reports the bounds it actually applied", async () => {
  const { batch } = await reevaluateBatchFor(batchIds(2));

  assert.equal(batch.limits.maxReEvaluations, WATCHLIST_MAX_RE_EVALUATIONS);
  assert.equal(batch.limits.concurrency, WATCHLIST_CONCURRENCY);
  assert.ok(batch.durationMs >= 0);
});

test("an empty batch produces no results and is still ok", async () => {
  const { batch } = await reevaluateBatchFor([]);

  assert.equal(batch.status, "ok");
  assert.equal(batch.results.length, 0);
});

  assert.ok(result.persistence?.message);
});

