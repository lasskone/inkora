/**
 * Opportunity Scanner orchestration tests.
 *
 * Injected with fake ports on purpose, exactly like the candidate-resolution
 * tests: these pin the *contract* — what a scan does with each upstream state —
 * without any network, so a change to the orchestration surfaces here before it
 * reaches the route (docs/ARCHITECTURE.md §15).
 *
 * The properties pinned here are the ones the scanner guarantees:
 *   - a bounded batch, server-enforced, in deterministic order;
 *   - candidate stability — the browser's ids are re-resolved in the server's
 *     own window, and anything that scrolled out is reported, not matched;
 *   - failure isolation — one bad listing never forfeits the rest;
 *   - no new score — the ranking is the Opportunity Engine's score with
 *     documented tie-breakers only;
 *   - bounded concurrency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CjApiError } from "@/lib/cj/errors";
import type {
  MarketplaceProduct,
  MarketplaceSearchResult,
} from "@/lib/marketplace/types";
import type {
  MatchCandidate,
  MatchResult,
  MatcherLimits,
} from "@/lib/matcher/types";
import { MATCHER_VERSION } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type { SupplierProduct } from "@/lib/supplier/types";

import { runOpportunityScan, ScanPipelineError } from "./scanner";
import type { ScannerPorts, ScanRequest, ScanDestination } from "./types";
import {
  SCANNER_CONCURRENCY,
  SCANNER_DISCOVERY_LIMIT,
  SCANNER_MAX_EVALUATIONS,
} from "./limits";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-09-22T00:00:00.000Z";
const DESTINATION: ScanDestination = {
  countryCode: "US",
  postalCode: null,
  label: "baseline destination US",
};

function makeListing(overrides: Partial<MarketplaceProduct> = {}): MarketplaceProduct {
  return {
    marketplace: "ebay",
    externalId: "v1|1000000001",
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
    externalId: "cj-product-1",
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
    foundByQueries: ["Anker Soundcore Life Q30"],
    usWarehouseInventory: null,
    confidenceProvenance: "ESTIMATED",
    ...overrides,
  };
}

const MATCHER_LIMITS: MatcherLimits = {
  maxQueries: 3,
  perQueryLimit: 10,
  maxCandidates: 10,
  maxResults: SCANNER_MAX_EVALUATIONS,
  maxInventoryLookups: 0,
};

function makeMatchResult(
  candidates: MatchCandidate[],
  product: MarketplaceProduct,
): MatchResult {
  return {
    marketplaceProduct: product,
    supplier: "cj",
    queries: [
      {
        query: "Anker Soundcore Life Q30",
        rationale: "title tokens",
        count: candidates.length,
        failure: null,
      },
    ],
    candidates,
    limits: MATCHER_LIMITS,
    matcherVersion: MATCHER_VERSION,
  };
}

function makeSearchResult(products: MarketplaceProduct[]): MarketplaceSearchResult {
  return {
    query: "anker headphones",
    limit: SCANNER_DISCOVERY_LIMIT,
    offset: 0,
    total: products.length,
    count: products.length,
    products,
  };
}

function makeEconomics(
  itemId: string,
  overrides: Partial<EconomicsResult> = {},
): EconomicsResult {
  return {
    marketplace: "ebay",
    marketplaceItemId: itemId,
    itemPrice: "79.99",
    buyerShipping: "0.00",
    grossMarketplaceRevenue: "79.99",
    currency: "USD",
    supplier: "cj",
    supplierProductId: "cj-product-1",
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

interface FakePortsOptions {
  products: MarketplaceProduct[];
  /** Candidates the matcher returns, keyed by marketplace external id. */
  candidatesByItem?: Record<string, MatchCandidate[]>;
  /** Economics result per candidate external id; absent means "no quote". */
  economicsByCandidate?: Record<string, EconomicsResult>;
  /** When set, `computeEconomics` throws this error for every candidate. */
  economicsError?: Error;
  /** When set, `searchMarketplace` rejects, failing discovery. */
  discoveryError?: Error;
  /** When set, `matchCandidates` throws for this item id only. */
  matchErrorForItem?: string;
  /** When true, persistAssessment reports a failure instead of ok. */
  persistenceFailure?: boolean;
}

interface FakePortsRecord {
  searches: number;
  matches: number;
  economics: number;
  persisted: number;
  evaluationsPersisted: number;
  peakConcurrency: number;
}

function fakePorts(options: FakePortsOptions, record: FakePortsRecord): ScannerPorts {
  let inFlight = 0;
  return {
    async searchMarketplace() {
      record.searches += 1;
      if (options.discoveryError) {
        throw options.discoveryError;
      }
      return makeSearchResult(options.products);
    },
    async matchCandidates(product) {
      record.matches += 1;
      if (options.matchErrorForItem === product.externalId) {
        throw new Error("unexpected internal fault");
      }
      inFlight += 1;
      record.peakConcurrency = Math.max(record.peakConcurrency, inFlight);
      // A match round-trip is what makes the concurrency observable.
      await Promise.resolve();
      inFlight -= 1;
      return makeMatchResult(
        options.candidatesByItem?.[product.externalId] ?? [],
        product,
      );
    },
    async computeEconomics(request) {
      record.economics += 1;
      if (options.economicsError) {
        throw options.economicsError;
      }
      const result =
        options.economicsByCandidate?.[request.candidate.supplierProduct.externalId];
      if (!result) {
        throw new CjApiError("CJ could not quote this product.", { status: 500 });
      }
      return {
        result,
        selectedVariant: {
          externalId: "vid-1",
          sku: "CJ-SKU-1",
          title: null,
          price: "41.50",
          availableInventory: null,
        },
      };
    },
    async readEvidence() {
      return null;
    },
    async persistEvaluation() {
      record.evaluationsPersisted += 1;
      return null;
    },
    async persistAssessment() {
      record.persisted += 1;
      return options.persistenceFailure
        ? { status: "failed", message: "storage unavailable" }
        : { status: "ok", inserted: true };
    },
  };
}

async function scan(
  request: ScanRequest,
  options: FakePortsOptions,
): Promise<{ result: Awaited<ReturnType<typeof runOpportunityScan>>; record: FakePortsRecord }> {
  const record: FakePortsRecord = {
    searches: 0,
    matches: 0,
    economics: 0,
    persisted: 0,
    evaluationsPersisted: 0,
    peakConcurrency: 0,
  };
  const result = await runOpportunityScan({
    request,
    ports: fakePorts(options, record),
    destination: DESTINATION,
    now: NOW,
  });
  return { result, record };
}


// ---------------------------------------------------------------------------
// Bounded batch and determinism
// ---------------------------------------------------------------------------

test("batch mode evaluates the first listings of the discovery window, in order", async () => {
  const products = [
    makeListing({ externalId: "v1|1", title: "one" }),
    makeListing({ externalId: "v1|2", title: "two" }),
    makeListing({ externalId: "v1|3", title: "three" }),
  ];

  const { result, record } = await scan(
    { query: "anker headphones", mode: "batch" },
    {
      products,
      candidatesByItem: {
        "v1|1": [makeCandidate()],
        "v1|2": [makeCandidate()],
        "v1|3": [makeCandidate()],
      },
      economicsByCandidate: { "cj-product-1": makeEconomics("v1|1") },
    },
  );

  assert.equal(record.searches, 1, "discovery is exactly one marketplace call");
  assert.equal(record.matches, 3);
  assert.equal(result.meta.discoveryCount, 3);
  assert.equal(result.meta.selectedCount, 3);
  assert.equal(result.meta.evaluatedCount, 3);
  assert.equal(result.meta.failedCount, 0);
  assert.equal(result.status, "ok");
  // Discovery order is preserved, not the order the caller posted.
  assert.deepEqual(
    result.results.map((item) => item.marketplaceProduct?.externalId),
    ["v1|1", "v1|2", "v1|3"],
  );
});

test("batch mode clamps a client limit above the evaluation cap", async () => {
  const products = Array.from({ length: 10 }, (_, index) =>
    makeListing({ externalId: `v1|${index}` }),
  );

  const { result, record } = await scan(
    { query: "anker headphones", mode: "batch", limit: 99 },
    { products },
  );

  assert.equal(record.matches, SCANNER_MAX_EVALUATIONS);
  assert.equal(result.meta.selectedCount, SCANNER_MAX_EVALUATIONS);
  assert.equal(result.meta.limits.maxEvaluations, SCANNER_MAX_EVALUATIONS);
});

test("batch mode clamps a limit of zero up to one", async () => {
  const products = [makeListing({ externalId: "v1|1" })];

  const { result, record } = await scan(
    { query: "anker headphones", mode: "batch", limit: 0 },
    { products, candidatesByItem: { "v1|1": [makeCandidate()] } },
  );

  assert.equal(record.matches, 1);
  assert.equal(result.meta.selectedCount, 1);
});

test("the limits the scan ran under are reported in the result", async () => {
  const { result } = await scan(
    { query: "anker headphones", mode: "batch" },
    { products: [makeListing()] },
  );

  assert.deepEqual(result.meta.limits, {
    discoveryLimit: SCANNER_DISCOVERY_LIMIT,
    maxEvaluations: SCANNER_MAX_EVALUATIONS,
    concurrency: SCANNER_CONCURRENCY,
    deadlineMs: 90_000,
  });
  assert.equal(result.meta.scannerVersion, "scanner-v1");
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("an empty query is rejected before any upstream call", async () => {
  await assert.rejects(
    scan({ query: "   ", mode: "batch" }, { products: [] }),
    (error: unknown) =>
      error instanceof ScanPipelineError && error.code === "INVALID_QUERY",
  );
});

test("a query over 100 characters is rejected", async () => {
  await assert.rejects(
    scan({ query: "a".repeat(101), mode: "batch" }, { products: [] }),
    (error: unknown) =>
      error instanceof ScanPipelineError && error.code === "INVALID_QUERY",
  );
});

test("an unknown mode is rejected", async () => {
  await assert.rejects(
    scan({ query: "ok", mode: "nope" as never }, { products: [] }),
    (error: unknown) =>
      error instanceof ScanPipelineError && error.code === "INVALID_MODE",
  );
});

test("manual mode without item ids is rejected", async () => {
  await assert.rejects(
    scan({ query: "ok", mode: "manual" }, { products: [makeListing()] }),
    (error: unknown) =>
      error instanceof ScanPipelineError && error.code === "ITEMS_REQUIRED",
  );
});

test("manual mode rejects more item ids than the evaluation cap", async () => {
  const tooMany = Array.from(
    { length: SCANNER_MAX_EVALUATIONS + 1 },
    (_, index) => `v1|${index}`,
  );
  await assert.rejects(
    scan({ query: "ok", mode: "manual", itemIds: tooMany }, { products: [] }),
    (error: unknown) =>
      error instanceof ScanPipelineError && error.code === "TOO_MANY_ITEMS",
  );
});

test("manual mode rejects a malformed item id", async () => {
  await assert.rejects(
    scan(
      { query: "ok", mode: "manual", itemIds: ["v1|1", "not an id!"] },
      { products: [makeListing({ externalId: "v1|1" })] },
    ),
    (error: unknown) =>
      error instanceof ScanPipelineError && error.code === "INVALID_ITEM_ID",
  );
});

test("a failed discovery search fails the whole scan", async () => {
  await assert.rejects(
    scan(
      { query: "ok", mode: "batch" },
      { products: [], discoveryError: new Error("eBay down") },
    ),
    (error: unknown) =>
      error instanceof ScanPipelineError && error.code === "DISCOVERY_FAILED",
  );
});


// ---------------------------------------------------------------------------
// Candidate stability
// ---------------------------------------------------------------------------

test("manual mode re-resolves selected ids inside the server's own window", async () => {
  const products = [
    makeListing({ externalId: "v1|1", title: "one" }),
    makeListing({ externalId: "v1|2", title: "two" }),
  ];

  const { result, record } = await scan(
    { query: "anker headphones", mode: "manual", itemIds: ["v1|2", "v1|1"] },
    {
      products,
      candidatesByItem: {
        "v1|1": [makeCandidate()],
        "v1|2": [makeCandidate()],
      },
      economicsByCandidate: { "cj-product-1": makeEconomics("v1|1") },
    },
  );

  assert.equal(record.matches, 2);
  // Discovery order, not the order the browser posted.
  assert.deepEqual(
    result.results.map((item) => item.marketplaceProduct?.externalId),
    ["v1|1", "v1|2"],
  );
});

test("an id that scrolled out of the window is reported, never matched", async () => {
  const products = [makeListing({ externalId: "v1|1", title: "one" })];

  const { result } = await scan(
    { query: "anker headphones", mode: "manual", itemIds: ["v1|1", "v1|gone"] },
    {
      products,
      candidatesByItem: { "v1|1": [makeCandidate()] },
      economicsByCandidate: { "cj-product-1": makeEconomics("v1|1") },
    },
  );

  assert.equal(result.status, "partial");
  assert.equal(result.results.length, 1);
  assert.equal(result.failures.length, 1);

  const [failure] = result.failures;
  assert.equal(failure.outcome, "item-not-found");
  assert.equal(failure.requestedItemId, "v1|gone");
  assert.equal(failure.marketplaceProduct, null);
  assert.equal(failure.failureCode, "ITEM_NOT_RESOLVED");
});

test("manual mode collapses duplicate ids", async () => {
  const products = [makeListing({ externalId: "v1|1" })];

  const { record } = await scan(
    { query: "anker headphones", mode: "manual", itemIds: ["v1|1", "v1|1", " v1|1 "] },
    { products, candidatesByItem: { "v1|1": [makeCandidate()] } },
  );

  assert.equal(record.matches, 1);
});

test("when no requested id remains in the window, the scan refuses rather than assessing nothing", async () => {
  await assert.rejects(
    scan(
      { query: "ok", mode: "manual", itemIds: ["v1|gone"] },
      { products: [makeListing({ externalId: "v1|1" })] },
    ),
    (error: unknown) =>
      error instanceof ScanPipelineError && error.code === "ITEM_NOT_RESOLVED",
  );
});


// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

test("a listing the matcher cannot source is a verdict, not a failure", async () => {
  const products = [
    makeListing({ externalId: "v1|1" }),
    makeListing({ externalId: "v1|2" }),
  ];

  const { result } = await scan(
    { query: "anker headphones", mode: "batch" },
    {
      products,
      candidatesByItem: { "v1|2": [makeCandidate()] },
      economicsByCandidate: { "cj-product-1": makeEconomics("v1|2") },
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.failures.length, 0);

  const unsourced = result.results.find(
    (item) => item.marketplaceProduct?.externalId === "v1|1",
  );
  assert.equal(unsourced?.outcome, "no-candidates");
  assert.equal(unsourced?.candidate, null);
  // The engine still produced a complete assessment — hard-capped at LOW.
  assert.notEqual(unsourced?.assessment, null);
  assert.equal(unsourced?.assessment?.band, "LOW");
});

test("a candidate whose economics cannot be quoted is still assessed", async () => {
  const products = [makeListing({ externalId: "v1|1" })];

  const { result, record } = await scan(
    { query: "anker headphones", mode: "batch" },
    {
      products,
      candidatesByItem: { "v1|1": [makeCandidate()] },
      economicsError: new CjApiError("CJ freight failed.", { status: 502 }),
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.outcome, "economics-unavailable");
  assert.equal(result.results[0]?.economics, null);
  assert.notEqual(result.results[0]?.assessment, null);
  assert.equal(result.results[0]?.failureCode, "CJ_UPSTREAM_ERROR");
  // The evaluation record was never written, because economics never resolved.
  assert.equal(record.evaluationsPersisted, 0);
  assert.equal(record.persisted, 1);
});

test("a persistence failure is reported on the item without failing the scan", async () => {
  const products = [makeListing({ externalId: "v1|1" })];

  const { result } = await scan(
    { query: "anker headphones", mode: "batch" },
    {
      products,
      candidatesByItem: { "v1|1": [makeCandidate()] },
      economicsByCandidate: { "cj-product-1": makeEconomics("v1|1") },
      persistenceFailure: true,
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.persistence?.status, "failed");
  assert.equal(result.meta.evaluatedCount, 1);
  assert.equal(result.meta.failedCount, 0);
});

test("an unexpected matcher error becomes an upstream-error item, not a crash", async () => {
  const products = [
    makeListing({ externalId: "v1|1" }),
    makeListing({ externalId: "v1|2" }),
  ];

  const { result, record } = await scan(
    { query: "anker headphones", mode: "batch" },
    {
      products,
      matchErrorForItem: "v1|2",
      candidatesByItem: { "v1|1": [makeCandidate()] },
      economicsByCandidate: { "cj-product-1": makeEconomics("v1|1") },
    },
  );

  assert.equal(result.status, "partial");
  assert.equal(result.results.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.outcome, "upstream-error");
  assert.equal(result.failures[0]?.failureCode, "INTERNAL_ERROR");
  assert.equal(record.matches, 2, "the other listing still ran");
});


test("the reported scan window reflects real start and completion times", async () => {
  const products = [makeListing({ externalId: "v1|1" })];

  const { result } = await scan(
    { query: "anker headphones", mode: "batch" },
    { products, candidatesByItem: { "v1|1": [makeCandidate()] } },
  );

  // The injected `now` anchors the assessment's freshness rules, but the scan's
  // own window must report when it actually finished.
  assert.ok(
    Date.parse(result.meta.completedAt) >= Date.parse(result.meta.startedAt),
    "completedAt must not predate startedAt",
  );
  assert.ok(result.meta.durationMs >= 0);
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test("results are ordered by the Opportunity Engine score, highest first", async () => {
  const products = [
    makeListing({ externalId: "v1|low", price: "60.00" }),
    makeListing({ externalId: "v1|high", price: "120.00" }),
  ];

  const { result } = await scan(
    { query: "anker headphones", mode: "batch" },
    {
      products,
      candidatesByItem: {
        "v1|low": [makeCandidate()],
        "v1|high": [makeCandidate()],
      },
      economicsByCandidate: {
        "cj-product-1": makeEconomics("v1|high", {
          estimatedProfit: "40.00",
          marginPercent: "33.00",
        }),
      },
    },
  );

  // The fixture only manufactures one supplier id, so both items share an
  // economics outcome; the tie-break ladder must still order them stably.
  assert.equal(result.results.length, 2);
  assert.equal(
    result.results[0]?.marketplaceProduct?.externalId,
    "v1|high",
    "the stronger listing ranks first",
  );
});

test("the ranking is deterministic across identical runs", async () => {
  const products = Array.from({ length: 4 }, (_, index) =>
    makeListing({ externalId: `v1|${index}` }),
  );
  const options = {
    products,
    candidatesByItem: Object.fromEntries(
      products.map((product) => [product.externalId, [makeCandidate()]]),
    ),
  } satisfies FakePortsOptions;

  const first = await scan({ query: "anker headphones", mode: "batch" }, options);
  const second = await scan({ query: "anker headphones", mode: "batch" }, options);

  assert.deepEqual(
    first.result.results.map((item) => item.marketplaceProduct?.externalId),
    second.result.results.map((item) => item.marketplaceProduct?.externalId),
  );
  assert.equal(first.result.status, second.result.status);
  assert.equal(first.result.meta.evaluatedCount, second.result.meta.evaluatedCount);
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test("deep evaluation never exceeds the configured concurrency", async () => {
  const products = Array.from({ length: 6 }, (_, index) =>
    makeListing({ externalId: `v1|${index}` }),
  );

  const { record, result } = await scan(
    { query: "anker headphones", mode: "batch" },
    {
      products,
      candidatesByItem: Object.fromEntries(
        products.map((product) => [product.externalId, [makeCandidate()]]),
      ),
    },
  );

  assert.equal(result.meta.selectedCount, products.length);
  assert.equal(record.matches, products.length);
  assert.ok(
    record.peakConcurrency <= SCANNER_CONCURRENCY,
    `peak concurrency ${record.peakConcurrency} exceeded the cap ${SCANNER_CONCURRENCY}`,
  );
});

