/**
 * Candidate-resolution stability tests.
 *
 * The module is injected with fake ports on purpose: these tests pin the
 * resolution *contract* — which outcome is returned for which upstream state —
 * without any network, so a change to the shared flow surfaces here before it
 * reaches both product routes (docs/ARCHITECTURE.md §8.3).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  MarketplaceProduct,
  MarketplaceSearchRequest,
  MarketplaceSearchResult,
} from "@/lib/marketplace/types";
import type { MatchCandidate, MatchResult, MatcherLimits } from "@/lib/matcher/types";
import { MATCHER_VERSION } from "@/lib/matcher/types";

import {
  resolveMarketplaceProduct,
  selectBestCandidate,
  selectCandidate,
} from "./candidate-resolution";
import type { CandidateResolutionPorts } from "./candidate-resolution";

function makeListing(overrides: Partial<MarketplaceProduct> = {}): MarketplaceProduct {
  return {
    marketplace: "ebay",
    externalId: "v1|1234567890",
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
    fetchedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

const LISTING = makeListing();
const OTHER_LISTING = makeListing({ externalId: "v1|9999999999", sellerName: "seller-two" });

function makeCandidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    marketplaceProduct: LISTING,
    supplierProduct: {
      supplier: "cj",
      externalId: "cj-product-1",
      sku: "CJ-SKU-1",
      title: "Anker Soundcore Life Q30 Headphones",
      imageUrl: null,
      productUrl: null,
      category: null,
      supplierPrice: "34.11",
      currency: "USD",
      availableInventory: null,
      warehouseCountry: null,
      shippingOrigin: null,
      variants: [],
      provenance: "OFFICIAL",
      fetchedAt: "2026-09-22T00:00:00.000Z",
    },
    confidence: 80,
    confidenceBand: "HIGH",
    signals: [],
    contradictions: [],
    explanation: "distinctive tokens agree",
    foundByQueries: ["Anker Soundcore Life Q30"],
    usWarehouseInventory: null,
    confidenceProvenance: "ESTIMATED",
    ...overrides,
  };
}

const CANDIDATE = makeCandidate();
const RUNNER_UP = makeCandidate({
  supplierProduct: { ...makeCandidate().supplierProduct, externalId: "cj-product-2" },
  confidence: 55,
});

const MATCHER_LIMITS: MatcherLimits = {
  maxQueries: 3,
  perQueryLimit: 20,
  maxCandidates: 10,
  maxResults: 10,
  maxInventoryLookups: 3,
};

function matchResult(candidates: MatchCandidate[]): MatchResult {
  return {
    marketplaceProduct: LISTING,
    supplier: "cj",
    queries: [],
    candidates,
    limits: MATCHER_LIMITS,
    matcherVersion: MATCHER_VERSION,
  };
}

function searchResult(products: MarketplaceProduct[]): MarketplaceSearchResult {
  return {
    query: "Anker Soundcore Life Q30",
    limit: 24,
    offset: 0,
    total: products.length,
    count: products.length,
    products,
  };
}

interface FakeState {
  searchResult: MarketplaceSearchResult;
  matchResult: MatchResult;
  marketplaceError?: unknown;
  supplierError?: unknown;
}

interface RecordingPorts extends CandidateResolutionPorts {
  searchRequests: MarketplaceSearchRequest[];
  matchRequests: MarketplaceProduct[];
}

/** Records the requests it received so the tests can prove the budget is honoured. */
function fakePorts(state: FakeState): RecordingPorts {
  return {
    searchRequests: [],
    matchRequests: [],
    async searchMarketplace(request) {
      this.searchRequests.push(request);
      if (state.marketplaceError !== undefined) throw state.marketplaceError;
      return state.searchResult;
    },
    async matchCandidates(product) {
      this.matchRequests.push(product);
      if (state.supplierError !== undefined) throw state.supplierError;
      return state.matchResult;
    },
  };
}

test("the listing is located in the replayed search window", async () => {
  const ports = fakePorts({
    searchResult: searchResult([OTHER_LISTING, LISTING]),
    matchResult: matchResult([CANDIDATE]),
  });

  const outcome = await resolveMarketplaceProduct({
    ports,
    itemId: LISTING.externalId,
    query: "Anker Soundcore Life Q30",
    resolveLimit: 24,
  });

  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.product, LISTING);
  assert.equal(outcome.searchResult.products.length, 2);
  assert.deepEqual(ports.searchRequests, [
    { query: "Anker Soundcore Life Q30", limit: 24, offset: 0 },
  ]);
});

test("an id that scrolled out of the window is reported, not guessed", async () => {
  const outcome = await resolveMarketplaceProduct({
    ports: fakePorts({
      searchResult: searchResult([OTHER_LISTING]),
      matchResult: matchResult([CANDIDATE]),
    }),
    itemId: LISTING.externalId,
    query: "Anker Soundcore Life Q30",
    resolveLimit: 24,
  });

  assert.equal(outcome.status, "item-not-found");
});

test("a marketplace failure is returned, never thrown", async () => {
  const failure = new Error("upstream");
  const outcome = await resolveMarketplaceProduct({
    ports: fakePorts({
      searchResult: searchResult([LISTING]),
      matchResult: matchResult([CANDIDATE]),
      marketplaceError: failure,
    }),
    itemId: LISTING.externalId,
    query: "Anker Soundcore Life Q30",
    resolveLimit: 24,
  });

  assert.equal(outcome.status, "marketplace-error");
  assert.equal((outcome as { error: unknown }).error, failure);
});

test("the requested candidate is selected when the matcher ranks it first", async () => {
  const outcome = await selectCandidate({
    ports: fakePorts({
      searchResult: searchResult([LISTING]),
      matchResult: matchResult([CANDIDATE, RUNNER_UP]),
    }),
    marketplaceProduct: LISTING,
    supplierProductId: "cj-product-1",
  });

  assert.equal(outcome.status, "selected");
  assert.equal(outcome.candidate.supplierProduct.externalId, "cj-product-1");
});

test("a lower-ranked requested candidate is still selected", async () => {
  const outcome = await selectCandidate({
    ports: fakePorts({
      searchResult: searchResult([LISTING]),
      matchResult: matchResult([RUNNER_UP, CANDIDATE]),
    }),
    marketplaceProduct: LISTING,
    supplierProductId: "cj-product-1",
  });

  assert.equal(outcome.status, "selected");
  assert.equal(outcome.candidate.supplierProduct.externalId, "cj-product-1");
  assert.equal(outcome.candidate.confidence, 80);
});

test("a supplier id that is not a matcher candidate is refused", async () => {
  const outcome = await selectCandidate({
    ports: fakePorts({
      searchResult: searchResult([LISTING]),
      matchResult: matchResult([CANDIDATE]),
    }),
    marketplaceProduct: LISTING,
    supplierProductId: "cj-something-else",
  });

  assert.equal(outcome.status, "not-a-candidate");
  assert.equal(outcome.matchResult.candidates.length, 1);
});

test("a matcher that surfaces no candidates reports it as a state, not an error", async () => {
  const ports = fakePorts({
    searchResult: searchResult([LISTING]),
    matchResult: matchResult([]),
  });

  assert.equal(
    (await selectCandidate({
      ports,
      marketplaceProduct: LISTING,
      supplierProductId: "cj-product-1",
    })).status,
    "no-candidates",
  );
  assert.equal((await selectBestCandidate(ports, LISTING)).status, "no-candidates");
});

test("a supplier failure is returned, never thrown", async () => {
  const failure = new Error("supplier down");
  const outcome = await selectCandidate({
    ports: fakePorts({
      searchResult: searchResult([LISTING]),
      matchResult: matchResult([CANDIDATE]),
      supplierError: failure,
    }),
    marketplaceProduct: LISTING,
    supplierProductId: "cj-product-1",
  });

  assert.equal(outcome.status, "supplier-error");
  assert.equal((outcome as { error: unknown }).error, failure);
});

test("the matcher is run against exactly the resolved listing", async () => {
  const ports = fakePorts({
    searchResult: searchResult([LISTING]),
    matchResult: matchResult([CANDIDATE]),
  });

  await selectCandidate({
    ports,
    marketplaceProduct: LISTING,
    supplierProductId: "cj-product-1",
  });

  assert.deepEqual(ports.matchRequests, [LISTING]);
});

