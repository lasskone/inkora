/**
 * Opportunity Engine V1 — model tests.
 *
 * These tests pin the *model*, not a snapshot: every assertion is a statement
 * about what the deterministic engine must do, so a change to a weight, cap, or
 * formula surfaces here as a deliberate, reviewed change rather than as silent
 * drift (docs/ARCHITECTURE.md §9.7).
 *
 * The engine is pure, so every case is constructed in-process — no network, no
 * database, no clock. `now` is always an injected constant.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { MarketplaceProduct, MarketplaceSearchResult } from "@/lib/marketplace/types";
import type { MatchCandidate, MatchSignal } from "@/lib/matcher/types";
import type { EconomicsResult, ShippingDestination } from "@/lib/economics/types";
import type { SupplierProduct } from "@/lib/supplier/types";
import type {
  HistoryEvidenceSummary,
  OpportunityInput,
  OpportunityLimits,
} from "./types";

import { assessOpportunity } from "./assess";
import { hashOpportunityObservation } from "@/lib/persistence/content-hash";
import {
  OPPORTUNITY_ENGINE_VERSION,
  SCORE_CAPS,
} from "./types";

const NOW = "2026-09-22T00:00:00.000Z";

const DEFAULT_LIMITS: OpportunityLimits = {
  maxPriorAssessments: 3,
  maxPriceObservations: 10,
  maxCompetitionSample: 20,
};

export function makeMarketplace(
  overrides: Partial<MarketplaceProduct> = {},
): MarketplaceProduct {
  return {
    marketplace: "ebay",
    externalId: "v1|1234567890",
    title: "Anker Soundcore Life Q30 Hybrid Active Noise Cancelling Headphones",
    imageUrl: "https://example.com/ebay.jpg",
    listingUrl: "https://example.com/ebay/1234567890",
    price: "79.99",
    currency: "USD",
    condition: "NEW",
    sellerName: "seller-one",
    sellerFeedbackPercentage: 98.7,
    shippingCost: "0.00",
    shippingCurrency: "USD",
    location: "Austin, US",
    provenance: "OFFICIAL",
    fetchedAt: NOW,
    ...overrides,
  };
}

export function makeSupplierProduct(
  overrides: Partial<SupplierProduct> = {},
): SupplierProduct {
  return {
    supplier: "cj",
    externalId: "cj-product-1",
    sku: "CJ-SKU-1",
    title: "Anker Soundcore Life Q30 Hybrid Active Noise Cancelling Headphones",
    imageUrl: "https://example.com/cj.jpg",
    productUrl: null,
    category: null,
    supplierPrice: "34.11",
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

const HIGH_MATCH_SIGNAL: MatchSignal = {
  name: "distinctiveTokenAgreement",
  label: "Distinctive token agreement",
  contribution: 40,
  detail: "Both titles contain the distinctive token Q30.",
};

export function makeCandidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    marketplaceProduct: makeMarketplace(),
    supplierProduct: makeSupplierProduct(),
    confidence: 84,
    confidenceBand: "HIGH",
    signals: [HIGH_MATCH_SIGNAL],
    contradictions: [],
    explanation: "High-confidence text match: distinctive tokens agree and no contradiction was found.",
    foundByQueries: ["Anker Soundcore Life Q30"],
    usWarehouseInventory: null,
    confidenceProvenance: "ESTIMATED",
    ...overrides,
  };
}

const BASELINE_DESTINATION: ShippingDestination = {
  countryCode: "US",
  postalCode: null,
  label: "United States (baseline destination)",
};

/**
 * Builds an economics result. Money values use the same decimal-string shapes the
 * economics engine actually emits, so these tests exercise the real parsing
 * boundary rather than a convenience number.
 */
export function makeEconomics(
  overrides: Partial<EconomicsResult> = {},
): EconomicsResult {
  return {
    marketplace: "ebay",
    marketplaceItemId: "v1|1234567890",
    itemPrice: "79.99",
    buyerShipping: "0.00",
    grossMarketplaceRevenue: "79.99",
    currency: "USD",
    supplier: "cj",
    supplierProductId: "cj-product-1",
    selectedVariant: { externalId: "cj-variant-1", sku: "CJ-SKU-1", title: "Black" },
    supplierProductCost: "34.11",
    supplierCostBasis: "SELECTED_VARIANT",
    supplierShippingCost: "6.70",
    supplierShippingMethod: "USPS+",
    supplierShippingTransitTime: "2-5",
    shippingQuotes: [],
    shippingDestination: BASELINE_DESTINATION,
    landedSupplierCost: "40.81",
    marketplaceFee: "12.40",
    feeBreakdown: [],
    feeEngineVersion: "ebay-us-1.0",
    feeStatus: "ESTIMATED",
    feeRuleSource: "published-policy",
    estimatedProfit: "26.78",
    marginPercent: "33.48",
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

export function makeSearchResult(
  overrides: Partial<MarketplaceSearchResult> = {},
): MarketplaceSearchResult {
  return {
    query: "Anker Soundcore Life Q30",
    limit: 20,
    offset: 0,
    total: 120,
    count: 3,
    products: [
      makeMarketplace({ externalId: "v1|other-1", sellerName: "seller-two", price: "82.00" }),
      makeMarketplace({ externalId: "v1|other-2", sellerName: "seller-three", price: "84.50" }),
      makeMarketplace({ externalId: "v1|other-3", sellerName: "seller-four", price: "150.00" }),
    ],
    ...overrides,
  };
}

export function makeHistory(
  overrides: Partial<HistoryEvidenceSummary> = {},
): HistoryEvidenceSummary {
  return {
    snapshotCount: 0,
    matchObservationCount: 0,
    economicsObservationCount: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    priceObservations: [],
    priorAssessments: [],
    ...overrides,
  };
}

export function makeInput(
  overrides: Partial<OpportunityInput> = {},
): OpportunityInput {
  return {
    marketplaceProduct: makeMarketplace(),
    candidate: makeCandidate(),
    economics: makeEconomics(),
    supplierQueries: ["Anker Soundcore Life Q30"],
    supplierCandidateCount: 3,
    competition: {
      query: "Anker Soundcore Life Q30",
      searchResult: makeSearchResult(),
    },
    history: null,
    now: NOW,
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

test("a well-evidenced opportunity lands HIGH with MEDIUM confidence", () => {
  const assessment = assessOpportunity(makeInput());

  assert.equal(assessment.engineVersion, OPPORTUNITY_ENGINE_VERSION);
  assert.equal(assessment.band, "HIGH");
  assert.equal(assessment.score, 78);
  assert.equal(assessment.confidence, 56);
  assert.equal(assessment.confidenceLevel, "MEDIUM");
  assert.deepEqual(assessment.caps, []);
  assert.equal(assessment.supplierExternalId, "cj-product-1");
});

test("identical inputs always produce identical assessments", () => {
  const input = makeInput();
  assert.deepEqual(assessOpportunity(input), assessOpportunity(input));
});

test("every factor reconciles exactly with the reported score", () => {
  const inputs: OpportunityInput[] = [
    makeInput(),
    makeInput({ economics: makeEconomics({ estimatedProfit: "-5.00", marginPercent: "-6.28" }) }),
    makeInput({ economics: makeEconomics({ completeness: "UNAVAILABLE", estimatedProfit: null, marginPercent: null }) }),
    makeInput({ candidate: null }),
    makeInput({ history: makeHistory({ snapshotCount: 3 }) }),
  ];

  for (const input of inputs) {
    const assessment = assessOpportunity(input);
    const total = assessment.factors.reduce((sum, factor) => sum + factor.contribution, 0);
    assert.equal(
      total,
      assessment.score,
      `factors summed to ${total} but the score is ${assessment.score}`,
    );
    assert.ok(assessment.factors.length >= 5, "every assessment explains all five components");
  }
});

test("a confirmed loss cannot reach the MEDIUM band", () => {
  const assessment = assessOpportunity(
    makeInput({ economics: makeEconomics({ estimatedProfit: "-5.00", marginPercent: "-6.28" }) }),
  );

  assert.equal(assessment.score, 38);
  assert.equal(assessment.band, "LOW");
  assert.equal(assessment.components.economics.score, 0);
  assert.deepEqual(
    assessment.caps.map((cap) => cap.name),
    ["negativeCompleteProfitGate"],
  );
});

test("unavailable economics cap the score and are explained", () => {
  const assessment = assessOpportunity(
    makeInput({
      economics: makeEconomics({
        completeness: "UNAVAILABLE",
        estimatedProfit: null,
        marginPercent: null,
        supplierProductCost: null,
      }),
    }),
  );

  assert.equal(assessment.score, 31);
  assert.equal(assessment.band, "LOW");
  assert.deepEqual(
    assessment.caps.map((cap) => cap.name),
    ["unavailableEconomicsGate"],
  );
  assert.equal(assessment.components.economics.estimatedProfit, null);
});

test("incomplete economics can be investigated but never rated HIGH", () => {
  const assessment = assessOpportunity(
    makeInput({ economics: makeEconomics({ completeness: "PARTIAL" }) }),
  );

  assert.equal(assessment.components.economics.score, 60);
  assert.equal(assessment.score, 60);
  assert.equal(assessment.band, "MEDIUM");
  assert.ok(assessment.score <= SCORE_CAPS.PARTIAL_ECONOMICS);
  assert.deepEqual(
    assessment.caps.map((cap) => cap.name),
    ["partialEconomicsGate"],
  );
});

test("a reference supplier cost discounts the economics component further", () => {
  const assessment = assessOpportunity(
    makeInput({
      economics: makeEconomics({
        completeness: "PARTIAL",
        supplierCostBasis: "VARIANT_REFERENCE",
      }),
    }),
  );

  assert.equal(assessment.components.economics.score, 42);
  assert.ok(
    assessment.caveats.some((caveat) => caveat.includes("reference value")),
    "a reference cost is stated as a caveat",
  );
});

test("a low-confidence match caps the score below the MEDIUM band", () => {
  const assessment = assessOpportunity(
    makeInput({
      candidate: makeCandidate({ confidence: 30, confidenceBand: "LOW" }),
    }),
  );

  assert.equal(assessment.score, SCORE_CAPS.LOW_MATCH);
  assert.equal(assessment.band, "LOW");
  assert.deepEqual(
    assessment.caps.map((cap) => cap.name),
    ["lowMatchGate"],
  );
});

test("an absent candidate is a complete, explainable assessment", () => {
  const assessment = assessOpportunity(makeInput({ candidate: null }));

  assert.equal(assessment.score, SCORE_CAPS.LOW_MATCH);
  assert.equal(assessment.band, "LOW");
  assert.equal(assessment.supplierExternalId, "");
  assert.equal(assessment.components.match.confidence, 0);
  assert.deepEqual(
    assessment.caps.map((cap) => cap.name),
    ["noCandidateGate"],
  );
  assert.ok(assessment.explanation.length > 0);
});

test("a fully unpopulated input still produces a defensible assessment", () => {
  const assessment = assessOpportunity(
    makeInput({
      candidate: null,
      economics: null,
      competition: null,
      history: null,
      supplierQueries: [],
      supplierCandidateCount: 0,
    }),
  );

  assert.equal(assessment.band, "LOW");
  assert.equal(assessment.components.competition.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(assessment.components.demand.verdict, "INSUFFICIENT_EVIDENCE");
  assert.deepEqual(
    assessment.caps.map((cap) => cap.name),
    ["noCandidateGate", "unavailableEconomicsGate"],
  );
  assert.equal(assessment.inputs.competitionQuery, null);
  assert.equal(assessment.inputs.historyAvailable, false);
});

test("a first assessment carries no demand evidence and no demand points", () => {
  const assessment = assessOpportunity(makeInput());

  assert.equal(assessment.components.demand.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(assessment.components.demand.score, 0);
  assert.equal(assessment.components.demand.listingPersistence, null);
  assert.equal(assessment.components.demand.sourcing.candidateCount, 3);
  assert.ok(
    assessment.components.demand.limitations.some((line) => line.includes("units sold")),
    "the API limitation that forbids a volume claim is always stated",
  );
});

test("listing persistence over a meaningful span reads as SUPPORTING", () => {
  const assessment = assessOpportunity(
    makeInput({
      history: makeHistory({
        snapshotCount: 3,
        firstSeenAt: "2026-09-19T00:00:00.000Z",
        lastSeenAt: NOW,
        priceObservations: [
          { observedAt: "2026-09-19T00:00:00.000Z", priceCents: 7999 },
          { observedAt: "2026-09-20T12:00:00.000Z", priceCents: 7999 },
          { observedAt: "2026-09-22T00:00:00.000Z", priceCents: 7999 },
        ],
      }),
    }),
  );

  assert.equal(assessment.components.demand.verdict, "SUPPORTING");
  assert.equal(assessment.components.demand.score, 100);
  assert.deepEqual(assessment.components.demand.listingPersistence, {
    observations: 3,
    spanHours: 72,
    priceStable: true,
  });
  assert.equal(assessment.score, 88);
  assert.equal(assessment.confidence, 94);
  assert.equal(assessment.confidenceLevel, "HIGH");
});

test("observations closer than the minimum gap collapse into one", () => {
  const assessment = assessOpportunity(
    makeInput({
      history: makeHistory({
        snapshotCount: 3,
        priceObservations: [
          { observedAt: "2026-09-22T00:00:00.000Z", priceCents: 7999 },
          { observedAt: "2026-09-22T00:30:00.000Z", priceCents: 7999 },
          { observedAt: "2026-09-22T00:59:00.000Z", priceCents: 7999 },
        ],
      }),
    }),
  );

  assert.equal(assessment.components.demand.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(assessment.components.demand.listingPersistence, null);
});

test("the assessed listing is never counted as its own competition", () => {
  const assessment = assessOpportunity(
    makeInput({
      competition: {
        query: "Anker Soundcore Life Q30",
        searchResult: makeSearchResult({
          count: 4,
          products: [
            makeMarketplace(),
            makeMarketplace({ externalId: "v1|other-1", sellerName: "seller-two", price: "82.00" }),
            makeMarketplace({ externalId: "v1|other-2", sellerName: "seller-three", price: "84.50" }),
            makeMarketplace({ externalId: "v1|other-3", sellerName: "seller-four", price: "150.00" }),
          ],
        }),
      },
    }),
  );

  assert.equal(assessment.components.competition.sampleSize, 3);
  assert.equal(assessment.components.competition.distinctSellers, 3);
  assert.equal(assessment.components.competition.verdict, "APPEARS_MODERATE");
  assert.equal(assessment.inputs.competitionQuery, "Anker Soundcore Life Q30");
});

test("competition evidence respects the declared sample bound", () => {
  const assessment = assessOpportunity(
    makeInput({
      limits: { ...DEFAULT_LIMITS, maxCompetitionSample: 1 },
    }),
  );

  assert.equal(assessment.components.competition.sampleSize, 1);
  assert.equal(assessment.components.competition.distinctSellers, 1);
});

test("a crowded query reads as broad competition", () => {
  const assessment = assessOpportunity(
    makeInput({
      competition: {
        query: "wireless earbuds",
        searchResult: makeSearchResult({
          query: "wireless earbuds",
          total: 25_000,
          count: 20,
          products: Array.from({ length: 20 }, (_, index) =>
            makeMarketplace({
              externalId: `v1|crowd-${index}`,
              sellerName: `seller-${index}`,
              price: "80.00",
            }),
          ),
        }),
      },
    }),
  );

  assert.equal(assessment.components.competition.verdict, "APPEARS_BROAD");
  assert.ok(
    assessment.components.competition.intensity >= 65,
    `expected broad intensity, got ${assessment.components.competition.intensity}`,
  );
  assert.ok(assessment.components.competition.score < 35);
});

test("a stale snapshot costs data quality and lowers the score", () => {
  const baseline = assessOpportunity(makeInput()).score;
  const assessment = assessOpportunity(
    makeInput({
      marketplaceProduct: makeMarketplace({ fetchedAt: "2026-08-23T00:00:00.000Z" }),
    }),
  );

  assert.equal(assessment.components.dataQuality.score, 65);
  assert.ok(assessment.score < baseline, "staleness must lower the score");
  assert.ok(
    assessment.components.dataQuality.limitations.some((line) => line.includes("freshness")),
    "staleness is reported as a named limitation",
  );
});

test("a listing with neither price nor economics has zero data quality", () => {
  const assessment = assessOpportunity(
    makeInput({
      marketplaceProduct: makeMarketplace({ price: null }),
      economics: makeEconomics({
        completeness: "UNAVAILABLE",
        estimatedProfit: null,
        marginPercent: null,
        supplierProductCost: null,
      }),
    }),
  );

  assert.equal(assessment.components.dataQuality.score, 0);
  assert.equal(assessment.band, "LOW");
  assert.ok(
    assessment.components.dataQuality.limitations.some((line) => line.includes("sale price")),
    "the missing price is reported by name",
  );
});

test("caveats always separate the assessment from a sales prediction", () => {
  const assessment = assessOpportunity(makeInput());

  assert.ok(assessment.caveats.length >= 2);
  assert.ok(
    assessment.caveats.some((line) => line.includes("not a prediction")),
    "the assessment must say what it is not",
  );
});

test("the economics figures are carried verbatim, never re-derived", () => {
  const assessment = assessOpportunity(makeInput());
  const economics = assessment.components.economics;

  assert.equal(economics.estimatedProfit, "26.78");
  assert.equal(economics.marginPercent, 33.48);
  assert.equal(economics.economicsEngineVersion, "economics-landed-1.0");
  assert.equal(economics.feeEngineVersion, "ebay-us-1.0");
});

test("confidence falls when match evidence is weak even with perfect economics", () => {
  const strong = assessOpportunity(makeInput());
  const weakMatch = assessOpportunity(
    makeInput({
      candidate: makeCandidate({ confidence: 35, confidenceBand: "LOW" }),
    }),
  );

  // Same economics, same data quality — the only difference is match evidence.
  assert.equal(strong.confidence, 56);
  assert.equal(weakMatch.confidence, 33);
  assert.equal(weakMatch.confidenceLevel, "LOW");
  assert.ok(weakMatch.confidence < strong.confidence);
  assert.equal(weakMatch.score, SCORE_CAPS.LOW_MATCH);
  assert.equal(weakMatch.band, "LOW");
});

test("demand evidence raises confidence without raising the score alone", () => {
  const first = assessOpportunity(makeInput());
  const repeated = assessOpportunity(
    makeInput({
      history: makeHistory({
        snapshotCount: 3,
        priceObservations: [
          { observedAt: "2026-09-19T00:00:00.000Z", priceCents: 7999 },
          { observedAt: "2026-09-22T00:00:00.000Z", priceCents: 7999 },
        ],
      }),
    }),
  );

  assert.ok(repeated.confidence > first.confidence);
  assert.equal(repeated.components.demand.verdict, "SUPPORTING");
  assert.ok(repeated.score > first.score, "persistence evidence is real evidence, so it moves the score too");
});


/**
 * The content hash is the deduplication verdict for the observation tables
 * (docs/DATABASE.md §7), so the engine's own outputs must hash the way the
 * persistence layer assumes: identical evidence seen twice is one observation,
 * no matter when the two scans happened.
 */
test("two identical evaluations a second apart hash the same, so they deduplicate", () => {
  const first = assessOpportunity(makeInput({ now: "2026-09-22T00:00:00.000Z" }));
  // The same listing, one second later: every fetch/economics timestamp moves,
  // but nothing about the evidence changed.
  const repeated = assessOpportunity(
    makeInput({
      now: "2026-09-22T00:00:01.000Z",
      marketplaceProduct: makeMarketplace({ fetchedAt: "2026-09-22T00:00:00.500Z" }),
      candidate: makeCandidate({
        supplierProduct: makeSupplierProduct({ fetchedAt: "2026-09-22T00:00:00.700Z" }),
      }),
      economics: makeEconomics({ calculatedAt: "2026-09-22T00:00:00.900Z" }),
    }),
  );

  // The documents themselves carry the moved times (provenance is preserved)...
  assert.notEqual(repeated.calculatedAt, first.calculatedAt);
  assert.notEqual(
    repeated.inputs.economicsCalculatedAt,
    first.inputs.economicsCalculatedAt,
  );
  // ...but the dedup key ignores them, so this is a reuse, not a second row.
  assert.equal(hashOpportunityObservation(repeated), hashOpportunityObservation(first));
});

test("a meaningful change in the evidence changes the opportunity hash", () => {
  const first = assessOpportunity(makeInput());
  const repriced = assessOpportunity(
    makeInput({
      economics: makeEconomics({
        itemPrice: "89.99",
        grossMarketplaceRevenue: "89.99",
        estimatedProfit: "36.78",
        marginPercent: "40.89",
      }),
    }),
  );

  assert.notEqual(hashOpportunityObservation(repriced), hashOpportunityObservation(first));
});


