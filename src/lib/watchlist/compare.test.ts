/**
 * Previous-vs-current comparison tests (docs/ARCHITECTURE.md §16.8).
 *
 * `compareAssessments` is pure, so these pin the contract without any database
 * or network:
 *   - a delta exists only when both sides are present — a missing value is
 *     reported as `unknown`, never coerced to zero and never hidden as
 *     "unchanged";
 *   - money is compared in integer minor units, so no binary float ever touches
 *     a financial figure;
 *   - categorical fields render as `previous → current`;
 *   - a genuinely first evaluation is `noPrevious: true`, which is a different
 *     fact from a failed previous read (`comparison: null`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { EconomicsResult } from "@/lib/economics/types";
import type { OpportunityAssessment } from "@/lib/opportunity/types";

import { compareAssessments, currentSide } from "./compare";
import type { ComparisonMoney, PreviousObservation } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-09-22T00:00:00.000Z";
const THEN = "2026-09-15T00:00:00.000Z";

function makeAssessment(overrides: {
  calculatedAt: string;
  score: number;
  confidence?: number;
  matchConfidence?: number;
  estimatedProfit?: string | null;
  marginPercent?: number | null;
}): OpportunityAssessment {
  const confidence = overrides.confidence ?? 60;
  return {
    engineVersion: "opportunity-v1",
    calculatedAt: overrides.calculatedAt,
    marketplace: "ebay",
    marketplaceExternalId: "v1|1000000001",
    supplier: "cj",
    supplierExternalId: "cj-product-1",
    score: overrides.score,
    band: overrides.score >= 70 ? "HIGH" : overrides.score >= 40 ? "MEDIUM" : "LOW",
    confidence,
    confidenceLevel: confidence >= 70 ? "HIGH" : confidence >= 40 ? "MEDIUM" : "LOW",
    components: {
      economics: {
        completeness: "COMPLETE",
        estimatedProfit: overrides.estimatedProfit === undefined ? "18.70" : overrides.estimatedProfit,
        marginPercent: overrides.marginPercent === undefined ? 23.5 : overrides.marginPercent,
        supplierCostBasis: "SELECTED_VARIANT",
        score: 70,
        rationale: "complete economics",
        warnings: [],
        assumptions: [],
        economicsEngineVersion: "economics-landed-1.0",
        feeEngineVersion: "ebay-fee-rules-1.0",
      },

      match: {
        confidence: overrides.matchConfidence ?? 72,
        confidenceBand: "MEDIUM",
        score: 72,
        explanation: "plausible candidate",
        signals: [],
        contradictions: [],
        cappedByHardContradiction: false,
        supplierExternalId: "cj-product-1",
      },
      competition: {
        verdict: "APPEARS_MODERATE",
        intensity: 45,
        score: 55,
        query: "anker headphones",
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
        evidence: ["listing snapshot is current"],
        limitations: [],
      },
    },
    factors: [],
    caps: [],
    headline: "A middling opportunity.",
    explanation: ["A middling opportunity."],
    caveats: ["every figure is an observation, not a live claim"],
    inputs: {
      marketplaceSnapshotObservedAt: NOW,
      supplierSnapshotObservedAt: NOW,
      economicsCalculatedAt: NOW,
      competitionQuery: "anker headphones",
      historyAvailable: true,
    },
  };
}


function makeEconomics(overrides: Partial<EconomicsResult> = {}): EconomicsResult {
  return {
    marketplace: "ebay",
    marketplaceItemId: "v1|1000000001",
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

const EMPTY_MONEY: ComparisonMoney = {
  marketplacePriceCents: null,
  supplierCostCents: null,
  supplierShippingCents: null,
  landedCostCents: null,
  estimatedProfitCents: null,
  marginPercent: null,
};

// ---------------------------------------------------------------------------
// noPrevious
// ---------------------------------------------------------------------------

test("a first evaluation reports noPrevious and no deltas", () => {
  const current = makeAssessment({ calculatedAt: NOW, score: 62 });

  const comparison = compareAssessments(null, {
    assessment: current,
    economics: makeEconomics(),
  });

  assert.equal(comparison.noPrevious, true);
  assert.equal(comparison.previousCalculatedAt, null);
  assert.equal(comparison.currentCalculatedAt, NOW);
  for (const delta of comparison.numeric) {
    assert.equal(delta.previous, null, `${delta.field} has no previous value`);
    assert.equal(delta.delta, null, `${delta.field} has no delta`);
    assert.equal(delta.direction, "unknown", `${delta.field} is unknown, not unchanged`);
  }
});

// ---------------------------------------------------------------------------
// Numeric deltas
// ---------------------------------------------------------------------------

test("a profit increase is an up delta in integer minor units", () => {
  const previous: PreviousObservation = {
    assessment: makeAssessment({ calculatedAt: THEN, score: 58, estimatedProfit: "18.70" }),
    money: { ...EMPTY_MONEY, estimatedProfitCents: 1870 },
  };
  const current = makeAssessment({ calculatedAt: NOW, score: 66, estimatedProfit: "24.30" });

  const comparison = compareAssessments(previous, {
    assessment: current,
    economics: makeEconomics({ estimatedProfit: "24.30" }),
  });

  const profit = comparison.numeric.find((delta) => delta.field === "estimatedProfit");
  assert.ok(profit, "estimatedProfit is compared");
  assert.equal(profit?.previous, "18.70");
  assert.equal(profit?.current, "24.30");
  assert.equal(profit?.delta, "5.60");
  assert.equal(profit?.direction, "up");
});

test("a price drop is a down delta", () => {
  const previous: PreviousObservation = {
    assessment: makeAssessment({ calculatedAt: THEN, score: 58 }),
    money: { ...EMPTY_MONEY, marketplacePriceCents: 7999, estimatedProfitCents: 1870 },
  };
  const current = makeAssessment({ calculatedAt: NOW, score: 51, estimatedProfit: "12.40" });

  const comparison = compareAssessments(previous, {
    assessment: current,
    economics: makeEconomics({ itemPrice: "69.99", estimatedProfit: "12.40" }),
  });

  const price = comparison.numeric.find((delta) => delta.field === "marketplacePrice");
  assert.equal(price?.previous, "79.99");
  assert.equal(price?.current, "69.99");
  assert.equal(price?.delta, "-10.00");
  assert.equal(price?.direction, "down");
});

test("equal values are unchanged, not unknown", () => {
  const previous: PreviousObservation = {
    assessment: makeAssessment({ calculatedAt: THEN, score: 58 }),
    money: { ...EMPTY_MONEY, estimatedProfitCents: 1870 },
  };
  const current = makeAssessment({ calculatedAt: NOW, score: 58, estimatedProfit: "18.70" });

  const comparison = compareAssessments(previous, {
    assessment: current,
    economics: makeEconomics(),
  });

  const profit = comparison.numeric.find((delta) => delta.field === "estimatedProfit");
  assert.equal(profit?.delta, "0.00");
  assert.equal(profit?.direction, "unchanged");
});

test("a missing money side stays unknown even when the other side is present", () => {
  const previous: PreviousObservation = {
    assessment: makeAssessment({ calculatedAt: THEN, score: 58 }),
    money: EMPTY_MONEY, // the previous observation linked to no economics record
  };
  const current = makeAssessment({ calculatedAt: NOW, score: 66, estimatedProfit: "24.30" });

  const comparison = compareAssessments(previous, {
    assessment: current,
    economics: makeEconomics({ estimatedProfit: "24.30" }),
  });

  const price = comparison.numeric.find((delta) => delta.field === "marketplacePrice");
  assert.equal(price?.previous, null);
  assert.equal(price?.current, "79.99");
  assert.equal(price?.delta, null);
  assert.equal(price?.direction, "unknown");
});

test("a loss is a negative delta and is never clamped to zero", () => {
  const previous: PreviousObservation = {
    assessment: makeAssessment({ calculatedAt: THEN, score: 30, estimatedProfit: "-4.20" }),
    money: { ...EMPTY_MONEY, estimatedProfitCents: -420 },
  };
  const current = makeAssessment({ calculatedAt: NOW, score: 22, estimatedProfit: "-9.80" });

  const comparison = compareAssessments(previous, {
    assessment: current,
    economics: makeEconomics({ estimatedProfit: "-9.80" }),
  });

  const profit = comparison.numeric.find((delta) => delta.field === "estimatedProfit");
  assert.equal(profit?.previous, "-4.20");
  assert.equal(profit?.current, "-9.80");
  assert.equal(profit?.delta, "-5.60");
  assert.equal(profit?.direction, "down");
});

// ---------------------------------------------------------------------------
// Categorical changes
// ---------------------------------------------------------------------------

test("a band change is reported as previous → current", () => {
  const previous: PreviousObservation = {
    assessment: makeAssessment({ calculatedAt: THEN, score: 58 }),
    money: EMPTY_MONEY,
  };
  const current = makeAssessment({ calculatedAt: NOW, score: 74 });

  const comparison = compareAssessments(previous, {
    assessment: current,
    economics: makeEconomics(),
  });

  const band = comparison.categorical.find((change) => change.field === "band");
  assert.ok(band, "band is compared categorically");
  assert.equal(band?.previous, "MEDIUM");
  assert.equal(band?.current, "HIGH");
  assert.equal(band?.changed, true);
});

test("an unchanged categorical field reports changed: false", () => {
  const previous: PreviousObservation = {
    assessment: makeAssessment({ calculatedAt: THEN, score: 58 }),
    money: EMPTY_MONEY,
  };
  const current = makeAssessment({ calculatedAt: NOW, score: 55 });

  const comparison = compareAssessments(previous, {
    assessment: current,
    economics: makeEconomics(),
  });

  const band = comparison.categorical.find((change) => change.field === "band");
  assert.equal(band?.previous, "MEDIUM");
  assert.equal(band?.current, "MEDIUM");
  assert.equal(band?.changed, false);
});

test("timestamps of both sides are carried verbatim", () => {
  const previous: PreviousObservation = {
    assessment: makeAssessment({ calculatedAt: THEN, score: 58 }),
    money: EMPTY_MONEY,
  };
  const current = makeAssessment({ calculatedAt: NOW, score: 74 });

  const comparison = compareAssessments(previous, {
    assessment: current,
    economics: makeEconomics(),
  });

  assert.equal(comparison.previousCalculatedAt, THEN);
  assert.equal(comparison.currentCalculatedAt, NOW);
  assert.equal(comparison.noPrevious, false);
});

// ---------------------------------------------------------------------------
// currentSide normalization
// ---------------------------------------------------------------------------

test("currentSide reads profit from the assessment, not the economics record", () => {
  // The economics layer owns money; the assessment owns the verdict. Profit is
  // taken from the assessment's economics component so one number has one
  // accountable source (docs/ARCHITECTURE.md §10).
  const side = currentSide(
    makeAssessment({ calculatedAt: NOW, score: 60, estimatedProfit: "12.00" }),
    makeEconomics({ estimatedProfit: "99.99" }),
  );

  assert.equal(side.money.estimatedProfitCents, 1200);
  assert.equal(side.money.supplierCostCents, 4150);
});

test("currentSide with no economics reports the upstream cost figures as null", () => {
  const side = currentSide(makeAssessment({ calculatedAt: NOW, score: 60 }), null);

  assert.equal(side.money.marketplacePriceCents, null, "price needs the economics record");
  assert.equal(side.money.supplierCostCents, null, "cost needs the economics record");
  assert.equal(side.money.supplierShippingCents, null, "shipping needs the economics record");
  assert.equal(side.money.landedCostCents, null, "landed cost needs the economics record");
});

test("currentSide reports null profit and margin only when the assessment itself has none", () => {
  const side = currentSide(
    makeAssessment({ calculatedAt: NOW, score: 60, estimatedProfit: null, marginPercent: null }),
    null,
  );
  assert.equal(side.money.estimatedProfitCents, null);
  assert.equal(side.money.marginPercent, null);
});
