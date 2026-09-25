/**
 * Product Detail service tests (docs/ARCHITECTURE.md §18.6, §16.4).
 *
 * The service receives its persistence client and the Watchlist ports, so a
 * test injects fakes and no network is ever required. These pin the two
 * contracts the page relies on:
 *
 *   read    — persisted-first and zero-upstream; one failing table degrades
 *             only its own section, and nothing is ever invented;
 *   refresh — the same engines as a watchlist re-evaluation, with the persisted
 *             pairing re-proved and never substituted, and the prior
 *             observation read *before* anything upstream runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketplaceProduct, MarketplaceSearchResult } from "@/lib/marketplace/types";
import type { MatchCandidate, MatchResult } from "@/lib/matcher/types";
import type { EconomicsResult } from "@/lib/economics/types";
import type { OpportunityAssessment } from "@/lib/opportunity/types";
import type { ScanDestination } from "@/lib/scanner/types";
import type { WatchlistPorts } from "@/lib/watchlist/types";
import type { PersistedRecords } from "@/lib/persistence/persistence-service";

import { readProductDetail, refreshProductDetail } from "./product-detail-service";

const ITEM_ID = "v1|265983500898|0";
const SUPPLIER_ID = "cj-product-1";
const QUERY = "wireless earbuds";
const MP_UUID = "mp-uuid-1";
const SP_UUID = "sp-uuid-1";
const NOW = "2026-09-23T12:00:00.000Z";
const DESTINATION: ScanDestination = {
  countryCode: "US",
  postalCode: null,
  label: "test destination US",
};

function makeListing(overrides: Partial<MarketplaceProduct> = {}): MarketplaceProduct {
  return {
    marketplace: "ebay",
    externalId: ITEM_ID,
    title: "Wireless earbuds, one listing among many",
    imageUrl: null,
    listingUrl: null,
    price: "29.99",
    currency: "USD",
    condition: "NEW",
    sellerName: "seller-one",
    sellerFeedbackPercentage: 98.5,
    shippingCost: "0.00",
    shippingCurrency: "USD",
    location: "US",
    provenance: "OFFICIAL",
    fetchedAt: NOW,
    ...overrides,
  };
}

const LISTING = makeListing();

function makeCandidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    marketplaceProduct: LISTING,
    supplierProduct: {
      supplier: "cj",
      externalId: SUPPLIER_ID,
      sku: "CJ-SKU-1",
      title: "Wireless earbuds",
      imageUrl: null,
      productUrl: null,
      category: null,
      supplierPrice: "14.50",
      currency: "USD",
      availableInventory: 120,
      warehouseCountry: "CN",
      shippingOrigin: null,
      variants: [],
      provenance: "OFFICIAL",
      fetchedAt: NOW,
    },
    confidence: 82,
    confidenceBand: "HIGH",
    signals: [],
    contradictions: [],
    explanation: "distinctive tokens agree",
    foundByQueries: [QUERY],
    usWarehouseInventory: null,
    confidenceProvenance: "ESTIMATED",
    ...overrides,
  };
}

const CANDIDATE = makeCandidate();
const OTHER_CANDIDATE = makeCandidate({
  supplierProduct: { ...makeCandidate().supplierProduct, externalId: "cj-product-2" },
  confidence: 40,
});

const ECONOMICS: EconomicsResult = {
  marketplace: "ebay",
  marketplaceItemId: ITEM_ID,
  itemPrice: "29.99",
  buyerShipping: "0.00",
  grossMarketplaceRevenue: "29.99",
  currency: "USD",
  supplier: "cj",
  supplierProductId: SUPPLIER_ID,
  selectedVariant: { externalId: "vid-1", sku: "CJ-SKU-1", title: "Wireless earbuds" },
  supplierProductCost: "14.50",
  supplierCostBasis: "SELECTED_VARIANT",
  supplierShippingCost: "3.20",
  supplierShippingMethod: "USPS+",
  supplierShippingTransitTime: "2-5",
  shippingQuotes: [],
  shippingDestination: { countryCode: "US", postalCode: null, label: "test destination US" },
  landedSupplierCost: "17.70",
  marketplaceFee: "4.35",
  feeBreakdown: [],
  feeEngineVersion: "fees-v1",
  feeStatus: "EXACT",
  feeRuleSource: "test-rules",
  estimatedProfit: "7.94",
  marginPercent: "26.48",
  completeness: "COMPLETE",
  economicsEngineVersion: "economics-v1",
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
};

// ---------------------------------------------------------------------------
// An in-memory stand-in for PostgREST on the tables Product Detail reads
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeDatabase {
  marketplace_products: Row[];
  supplier_products: Row[];
  marketplace_product_snapshots: Row[];
  match_observations: Row[];
  economics_observations: Row[];
  opportunity_observations: Row[];
  watchlist_entries: Row[];
}

/**
 * The tables Product Detail actually reads. A read against any other name fails
 * loudly instead of quietly returning an empty list: a typo'd table would
 * otherwise degrade every section to `unavailable` in production while every
 * unit test still passed.
 */
type TableName = keyof FakeDatabase;

/** Tables named here answer every read with a PostgREST-style error. */
type BrokenTables = Set<TableName>;

function storedMarketplaceProduct(): Row[] {
  return [{ id: MP_UUID, marketplace: "ebay", external_id: ITEM_ID, search_query: QUERY }];
}

function emptyDatabase(overrides: Partial<FakeDatabase> = {}): FakeDatabase {
  return {
    marketplace_products: [],
    supplier_products: [],
    marketplace_product_snapshots: [],
    match_observations: [],
    economics_observations: [],
    opportunity_observations: [],
    watchlist_entries: [],
    ...overrides,
  };
}

function fakeClient(
  database: FakeDatabase,
  broken: BrokenTables = new Set(),
): SupabaseClient {
  const from = (table: string) => {
    if (!(table in database)) {
      throw new Error(
        `Product Detail read a table the fake does not model: "${table}". ` +
          "The fake mirrors the real schema, so this name does not exist in production either.",
      );
    }
    const name = table as TableName;
    const filters: { column: string; value: unknown; isNull: boolean }[] = [];
    let orderColumn: string | null = null;
    let orderAscending = true;
    let rowLimit: number | null = null;

    const finish = (): { data: Row[] | null; error: unknown } => {
      if (broken.has(name)) {
        return { data: null, error: { message: `fake failure on ${String(name)}` } };
      }
      let rows = database[name];
      for (const filter of filters) {
        rows = rows.filter((row) => {
          const cell = row[filter.column];
          return filter.isNull ? cell === null : cell === filter.value;
        });
      }
      if (orderColumn !== null) {
        const column = orderColumn;
        rows = [...rows].sort((a, b) => {
          const left = String(a[column] ?? "");
          const right = String(b[column] ?? "");
          return orderAscending ? left.localeCompare(right) : right.localeCompare(left);
        });
      }
      if (rowLimit !== null) {
        rows = rows.slice(0, rowLimit);
      }
      return { data: rows, error: null };
    };

    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push({ column, value, isNull: false });
        return chain;
      },
      is: (column: string, value: null) => {
        filters.push({ column, value, isNull: value === null });
        return chain;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        orderColumn = column;
        orderAscending = options?.ascending ?? true;
        return chain;
      },
      // The real PostgREST builder stays chainable after `limit` and only
      // materializes on `await`, so a reader can keep narrowing the scope after
      // bounding it. Returning a resolved promise here would silently truncate
      // any filter appended after the bound.
      limit: (limit: number) => {
        rowLimit = limit;
        return chain;
      },
      then: <T>(onFulfilled?: (value: T) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(finish() as unknown as T).then(onFulfilled, onRejected),
    };
    return chain;
  };

  return { from } as unknown as SupabaseClient;
}


// ---------------------------------------------------------------------------
// Fake Watchlist ports, driven by scenario
// ---------------------------------------------------------------------------

interface RefreshScenario {
  /** Products the replayed search window contains. Defaults to the listing. */
  windowProducts?: MarketplaceProduct[];
  /** Candidates the matcher surfaces, best first. Defaults to the candidate. */
  candidates?: MatchCandidate[];
  /** Economics for the proven candidate. `null` makes the port throw. */
  economics?: EconomicsResult | null;
  /** Makes `readPreviousObservation` reject, so the comparison is unknown. */
  previousReadFails?: boolean;
}

function fakePorts(scenario: RefreshScenario = {}): {
  ports: WatchlistPorts;
  calls: string[];
} {
  const calls: string[] = [];
  const products = scenario.windowProducts ?? [LISTING];
  const candidates = scenario.candidates ?? [CANDIDATE];

  const ports: WatchlistPorts = {
    readEntry: async () => null,
    readPreviousObservation: async () => {
      calls.push("readPreviousObservation");
      if (scenario.previousReadFails === true) {
        throw new Error("the prior read is unavailable");
      }
      return null;
    },
    searchMarketplace: async (request) => {
      calls.push("searchMarketplace");
      const result: MarketplaceSearchResult = {
        query: request.query,
        limit: request.limit,
        offset: request.offset ?? 0,
        total: products.length,
        count: products.length,
        products,
      };
      return result;
    },
    matchCandidates: async (product) => {
      calls.push("matchCandidates");
      const matchResult: MatchResult = {
        marketplaceProduct: product,
        supplier: "cj",
        queries: [
          {
            query: QUERY,
            rationale: "test fixture query",
            count: candidates.length,
            failure: null,
          },
        ],
        candidates,
        limits: {
          maxQueries: 3,
          perQueryLimit: 20,
          maxCandidates: 60,
          maxResults: 20,
          maxInventoryLookups: 6,
        },
        matcherVersion: "matcher-v1",
      };
      return matchResult;
    },
    computeEconomics: async () => {
      calls.push("computeEconomics");
      if (scenario.economics === null) {
        throw new Error("no shipping quote available");
      }
      return { result: scenario.economics ?? ECONOMICS, selectedVariant: null } as never;
    },
    readEvidence: async () => null,
    persistEvaluation: async () => {
      calls.push("persistEvaluation");
      return null as unknown as PersistedRecords | null;
    },
    persistAssessment: async () => {
      calls.push("persistAssessment");
      return undefined;
    },
  };
  return { ports, calls };
}

/** A watchlist service stand-in: the ports plus the client the read-back uses. */
function fakeWatchlist(
  database: FakeDatabase,
  broken: BrokenTables = new Set(),
  scenario: RefreshScenario = {},
): { ports: WatchlistPorts; client: SupabaseClient; calls: string[] } {
  const { ports, calls } = fakePorts(scenario);
  return { ports, client: fakeClient(database, broken), calls };
}


// ---------------------------------------------------------------------------
// read — persisted-first, zero upstream
// ---------------------------------------------------------------------------

test("a read with persistence off reports disabled rather than failing", async () => {
  const result = await readProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    options: { persistence: null, now: NOW },
  });
  assert.deepEqual(result, { status: "disabled" });
});

test("a read for a listing Inkora never observed reports not-observed", async () => {
  const result = await readProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: null,
    options: { persistence: fakeClient(emptyDatabase()), now: NOW },
  });
  assert.deepEqual(result, { status: "not-observed" });
});

test("a read performs no upstream call at all", async () => {
  const { calls } = fakePorts();
  await readProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    options: {
      persistence: fakeClient(
        emptyDatabase({ marketplace_products: storedMarketplaceProduct() }),
      ),
      now: NOW,
    },
  });
  assert.deepEqual(calls, []);
});

/**
 * A persisted assessment as the Opportunity Engine writes it: the whole verdict
 * in one jsonb `assessment` column on `opportunity_observations`
 * (docs/DATABASE.md §6.8), the same table the Watchlist reads.
 */
function storedAssessment(overrides: Partial<OpportunityAssessment> = {}): OpportunityAssessment {
  return {
    engineVersion: "opportunity-v1",
    calculatedAt: NOW,
    marketplace: "ebay",
    marketplaceExternalId: ITEM_ID,
    supplier: "cj",
    supplierExternalId: SUPPLIER_ID,
    score: 72,
    band: "MEDIUM",
    confidence: 41,
    confidenceLevel: "LOW",
    components: {
      economics: {
        completeness: "COMPLETE",
        estimatedProfit: "8.40",
        marginPercent: 28.01,
        supplierCostBasis: "SELECTED_VARIANT",
        score: 60,
        rationale: "Economics are complete.",
        warnings: [],
        assumptions: [],
        economicsEngineVersion: "economics-v1",
        feeEngineVersion: "fees-v1",
      },
      match: {
        confidence: 41,
        confidenceBand: "LOW",
        score: 45,
        explanation: "tokens mostly agree",
        signals: [],
        contradictions: [],
        cappedByHardContradiction: false,
        supplierExternalId: SUPPLIER_ID,
      },
      competition: {
        verdict: "APPEARS_LIMITED",
        intensity: 30,
        score: 70,
        query: QUERY,
        searchResultTotal: 240,
        sampleSize: 20,
        distinctSellers: 12,
        similarlyPricedListings: 3,
        newConditionListings: 15,
        caveats: [],
      },
      demand: {
        verdict: "INSUFFICIENT_EVIDENCE",
        score: 0,
        evidence: [],
        limitations: ["No legitimate units-sold signal exists in V1."],
        listingPersistence: null,
        sourcing: {
          queries: 1,
          candidateCount: 1,
          note: "Sourcing proves availability, not demand.",
        },
      },
      dataQuality: {
        score: 80,
        dimensions: [],
        evidence: [],
        limitations: [],
      },
    },
    factors: [],
    caps: [],
    headline: "A medium opportunity on low evidence.",
    explanation: ["Economics contribute 60 of 100.", "Match confidence is LOW."],
    caveats: ["This is an assessment of stored evidence, not a live quote."],
    inputs: {
      marketplaceSnapshotObservedAt: NOW,
      supplierSnapshotObservedAt: NOW,
      economicsCalculatedAt: NOW,
      competitionQuery: QUERY,
      historyAvailable: true,
    },
    ...overrides,
  };
}

test("a persisted assessment surfaces in the read, from the table the engine writes to", async () => {
  const assessment = storedAssessment();
  const result = await readProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    options: {
      persistence: fakeClient(
        emptyDatabase({
          marketplace_products: storedMarketplaceProduct(),
          supplier_products: [{ id: SP_UUID, external_id: SUPPLIER_ID }],
          // The row the Opportunity Engine appends: the verdict is one jsonb
          // column on `opportunity_observations`, scoped by both internal ids.
          opportunity_observations: [
            {
              marketplace_product_id: MP_UUID,
              supplier_product_id: SP_UUID,
              calculated_at: NOW,
              assessment,
            },
          ],
        }),
      ),
      now: NOW,
    },
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.detail.opportunity.status, "available");
  assert.equal(result.detail.opportunity.score, 72);
  assert.equal(result.detail.opportunity.band, "MEDIUM");
  assert.equal(result.detail.opportunity.confidence, 41);
  assert.equal(result.detail.opportunity.engineVersion, "opportunity-v1");
  assert.equal(result.detail.history.series.assessments.length, 1);
  assert.equal(result.detail.history.changes.status, "partial");
  assert.equal(result.detail.history.changes.noPrevious, true);
});

test("a marketplace-only assessment is a first-class scope, not a wildcard", async () => {
  // An assessment recorded with no matcher candidate is a legitimate verdict,
  // stored with supplier_product_id IS NULL, so the marketplace-only read must
  // surface it — never a pair assessment of the same listing, and never nothing.
  const pair = storedAssessment({ score: 80, band: "HIGH" });
  const marketOnly = storedAssessment({
    supplierExternalId: "",
    score: 22,
    band: "LOW",
  });

  const result = await readProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: null,
    options: {
      persistence: fakeClient(
        emptyDatabase({
          marketplace_products: storedMarketplaceProduct(),
          opportunity_observations: [
            {
              marketplace_product_id: MP_UUID,
              supplier_product_id: SP_UUID,
              calculated_at: NOW,
              assessment: pair,
            },
            {
              marketplace_product_id: MP_UUID,
              supplier_product_id: null,
              calculated_at: NOW,
              assessment: marketOnly,
            },
          ],
        }),
      ),
      now: NOW,
    },
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.detail.supplierExternalId, null);
  assert.equal(result.detail.opportunity.status, "available");
  assert.equal(result.detail.opportunity.score, 22);
  assert.equal(result.detail.opportunity.band, "LOW");
  assert.equal(result.detail.history.series.assessments.length, 1);
});

test("one failing table degrades only its own section, never the page", async () => {
  const result = await readProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    options: {
      persistence: fakeClient(
        emptyDatabase({
          marketplace_products: storedMarketplaceProduct(),
          supplier_products: [
            {
              id: SP_UUID,
              external_id: SUPPLIER_ID,
              title: "Wireless earbuds",
              image_url: null,
              product_url: null,
              category: null,
              reference_cost_cents: 1450,
              currency: "USD",
              available_inventory: 120,
              warehouse_country: "CN",
              shipping_origin_country: null,
              provenance: "OFFICIAL",
              last_observed_at: NOW,
            },
          ],
          // A match observation keeps the page "observed" even though both the
          // marketplace snapshot and the economics reads fail below.
          match_observations: [
            {
              marketplace_product_id: MP_UUID,
              supplier_product_id: SP_UUID,
              supplier_products: { external_id: SUPPLIER_ID },
              matcher_version: "matcher-v1",
              confidence: 82,
              confidence_band: "HIGH",
              explanation: "distinctive tokens agree",
              signals: [],
              contradictions: [],
              calculated_at: NOW,
            },
          ],
        }),
        new Set(["marketplace_product_snapshots", "economics_observations"]),
      ),
      now: NOW,
    },
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.detail.observed, true);
  assert.equal(result.detail.market.status, "unavailable");
  assert.equal(result.detail.economics.status, "unavailable");
  // The intact supplier table still renders its own honest state: a Chinese
  // warehouse with no resolved variant cost is evidence, not confirmation, so
  // the section is `partial` rather than `available` (read-model.test.ts pins
  // that rule; here it only matters that the section was not dragged down).
  assert.equal(result.detail.supplier.status, "partial");
  assert.equal(result.detail.supplier.externalId, SUPPLIER_ID);
  assert.equal(result.detail.supplier.title, "Wireless earbuds");
});

test("a read honours the history bound it is given", async () => {
  const result = await readProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    options: {
      persistence: fakeClient(
        emptyDatabase({ marketplace_products: storedMarketplaceProduct() }),
      ),
      historyLimit: 7,
      now: NOW,
    },
  });
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.detail.history.series.limit, 7);
    assert.equal(result.detail.freshness.entries.length > 0, true);
  }
});


// ---------------------------------------------------------------------------
// refresh — deliberate, bounded, identity-preserving
// ---------------------------------------------------------------------------

test("a refresh with persistence off reports disabled rather than failing", async () => {
  // The watchlist service is built from the persistence client, which is `null`
  // without the Supabase variables. Removing them here pins that refusal
  // without ever touching the network.
  const env = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const result = await refreshProductDetail({
      itemId: ITEM_ID,
      query: QUERY,
      supplierProductId: SUPPLIER_ID,
      destination: DESTINATION,
      options: { now: NOW },
    });
    assert.deepEqual(result, { outcome: "disabled" });
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.key;
  }
});

test("a refresh for a listing Inkora never observed still evaluates it", async () => {
  // A refresh is the deliberate evaluation that *creates* the first observation,
  // so an empty store is a reason to run, not a reason to refuse: the read-back
  // beside the result is what shows the store was empty a moment ago.
  const database = emptyDatabase();
  const watchlist = fakeWatchlist(database);
  const result = await refreshProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    destination: DESTINATION,
    options: { watchlist, now: NOW },
  });

  assert.equal(result.outcome, "evaluated");
  assert.equal(
    watchlist.calls.indexOf("readPreviousObservation") <
      watchlist.calls.indexOf("searchMarketplace"),
    true,
    "the prior is read before anything upstream runs",
  );
  if (result.outcome === "evaluated") {
    assert.equal(result.detail, null, "nothing was stored, so there is nothing to read back");
    assert.equal(result.comparison?.noPrevious, true);
    assert.equal(result.comparison?.previousCalculatedAt, null);
  }
});

test("a refresh is an explicit re-evaluation and always persists something", async () => {
  const database = emptyDatabase({ marketplace_products: storedMarketplaceProduct() });
  const watchlist = fakeWatchlist(database);
  const first = await refreshProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    destination: DESTINATION,
    options: { watchlist, now: NOW },
  });

  assert.equal(first.outcome, "evaluated");
  assert.equal(watchlist.calls.includes("persistAssessment"), true);
  assert.deepEqual(
    watchlist.calls.filter((call) => call === "persistAssessment"),
    ["persistAssessment"],
    "exactly one assessment is persisted per refresh — never duplicated",
  );
  assert.equal(first.comparison?.noPrevious, true, "no prior existed, so the comparison says so");
});

test("the prior observation is read before any upstream call", async () => {
  const database = emptyDatabase({ marketplace_products: storedMarketplaceProduct() });
  const watchlist = fakeWatchlist(database);
  await refreshProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    destination: DESTINATION,
    options: { watchlist, now: NOW },
  });
  assert.equal(
    watchlist.calls.indexOf("readPreviousObservation") <
      watchlist.calls.indexOf("searchMarketplace"),
    true,
    "the prior must be read before the replayed search, so a fresh assessment can never be its own prior",
  );
});

test("a listing scrolled out of the replayed window is item-not-found", async () => {
  const database = emptyDatabase({ marketplace_products: storedMarketplaceProduct() });
  const watchlist = fakeWatchlist(database, new Set(), {
    windowProducts: [makeListing({ externalId: "v1|999999999999" })],
  });
  const result = await refreshProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    destination: DESTINATION,
    options: { watchlist, now: NOW },
  });

  assert.equal(result.outcome, "item-not-found");
  if (result.outcome === "item-not-found") {
    assert.equal(result.failureCode, "ITEM_NOT_RESOLVED");
    assert.ok(result.failureMessage.includes("no longer inside the replayed search window"));
  }
});

test("a supplier no longer a matcher candidate is reported, never substituted", async () => {
  const database = emptyDatabase({ marketplace_products: storedMarketplaceProduct() });
  const watchlist = fakeWatchlist(database, new Set(), {
    candidates: [OTHER_CANDIDATE],
  });
  const result = await refreshProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    destination: DESTINATION,
    options: { watchlist, now: NOW },
  });

  assert.equal(result.outcome, "candidate-not-resolved");
  if (result.outcome === "candidate-not-resolved") {
    assert.equal(result.failureCode, "CANDIDATE_NOT_FOUND");
    assert.ok(
      result.failureMessage.includes("has not been substituted"),
      "the failure states plainly that no other supplier was used",
    );
  }
  // The other candidate the matcher surfaced was never swapped in.
  assert.ok(!watchlist.calls.includes("computeEconomics"));
  // The last-known read model stays on screen beside the reason.
  assert.notEqual(result.detail, null);
  assert.equal(result.detail?.supplierExternalId, SUPPLIER_ID);
});


test("a marketplace-only refresh with no candidates reports no-candidates", async () => {
  const database = emptyDatabase({ marketplace_products: storedMarketplaceProduct() });
  const watchlist = fakeWatchlist(database, new Set(), { candidates: [] });
  const result = await refreshProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: null,
    destination: DESTINATION,
    options: { watchlist, now: NOW },
  });

  assert.equal(result.outcome, "no-candidates");
  if (result.outcome === "no-candidates") {
    assert.equal(result.assessment.components.economics.completeness, "UNAVAILABLE");
  }
});

test("a candidate whose shipping quote fails reports an upstream error", async () => {
  const database = emptyDatabase({ marketplace_products: storedMarketplaceProduct() });
  const watchlist = fakeWatchlist(database, new Set(), { economics: null });
  const result = await refreshProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    destination: DESTINATION,
    options: { watchlist, now: NOW },
  });

  assert.equal(result.outcome, "upstream-error");
  if (result.outcome === "upstream-error") {
    assert.ok(result.failureCode.length > 0);
    assert.ok(result.failureMessage.length > 0);
  }
});

test("a proven pairing evaluates, persists, and reads the scope back", async () => {
  const database = emptyDatabase({
    marketplace_products: storedMarketplaceProduct(),
    supplier_products: [
      {
        id: SP_UUID,
        external_id: SUPPLIER_ID,
        title: "Wireless earbuds",
        image_url: null,
        product_url: null,
        category: null,
        reference_cost_cents: 1450,
        currency: "USD",
        available_inventory: 120,
        warehouse_country: "CN",
        shipping_origin_country: null,
        provenance: "OFFICIAL",
        last_observed_at: NOW,
      },
    ],
  });
  const watchlist = fakeWatchlist(database);
  const result = await refreshProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    destination: DESTINATION,
    options: { watchlist, now: NOW },
  });

  assert.equal(result.outcome, "evaluated");
  if (result.outcome !== "evaluated") {
    return;
  }
  assert.equal(result.assessment.marketplaceExternalId, ITEM_ID);
  assert.equal(result.assessment.supplierExternalId, SUPPLIER_ID);
  assert.equal(
    result.comparison?.noPrevious,
    true,
    "no prior observation existed, so no deltas are invented",
  );
  assert.notEqual(result.detail, null);
  // The read-back reflects storage, not the in-memory result.
  assert.equal(result.detail?.supplierExternalId, SUPPLIER_ID);
});

test("a prior read that fails yields no comparison rather than a fabricated one", async () => {
  const database = emptyDatabase({ marketplace_products: storedMarketplaceProduct() });
  const watchlist = fakeWatchlist(database, new Set(), { previousReadFails: true });
  const result = await refreshProductDetail({
    itemId: ITEM_ID,
    query: QUERY,
    supplierProductId: SUPPLIER_ID,
    destination: DESTINATION,
    options: { watchlist, now: NOW },
  });

  assert.equal(result.outcome, "evaluated");
  if (result.outcome === "evaluated") {
    assert.equal(result.comparison, null, "a failed prior read is reported as unknown, not as zero deltas");
    assert.equal(watchlist.calls.includes("persistAssessment"), true);
  }
});
