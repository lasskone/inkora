/**
 * Product Detail read-model tests (docs/ARCHITECTURE.md §18.5, §18.6).
 *
 * `buildProductDetail` is pure and total, so the whole page's honest states are
 * pinned here from fixtures alone: a section with no stored evidence degrades
 * to `unavailable` and never to a zero or an estimate, and one failing table
 * costs only its own section. This is the rule that makes a partial page safe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { STALE_OBSERVATION_HOURS } from "@/lib/opportunity/types";
import type { OpportunityAssessment } from "@/lib/opportunity/types";

import { buildProductDetail, type ProductDetailReads } from "./read-model";

const NOW = "2026-09-23T12:00:00.000Z";
const HISTORY_LIMIT = 25;

function emptyReads(overrides: Partial<ProductDetailReads> = {}): ProductDetailReads {
  return {
    now: NOW,
    marketplaceExternalId: "v1|265983500898|0",
    replayQuery: "wireless earbuds",
    supplierExternalId: null,
    marketplaceSnapshots: [],
    matchObservations: [],
    economicsObservations: [],
    assessments: [],
    supplierSnapshots: [],
    latestEconomics: null,
    watched: { entryId: null, archived: false },
    historyLimit: HISTORY_LIMIT,
    ...overrides,
  };
}

function makeAssessment(overrides: Partial<OpportunityAssessment> = {}): OpportunityAssessment {
  return {
    engineVersion: "opportunity-v1",
    calculatedAt: NOW,
    marketplace: "ebay",
    marketplaceExternalId: "v1|265983500898|0",
    supplier: "cj",
    supplierExternalId: "cj-product-1",
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
        supplierExternalId: "cj-product-1",
      },
      competition: {
        verdict: "APPEARS_LIMITED",
        intensity: 30,
        score: 70,
        query: "wireless earbuds",
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
      competitionQuery: "wireless earbuds",
      historyAvailable: true,
    },
    ...overrides,
  };
}

const ASSESSMENT = makeAssessment();

test("a listing with no stored observation at all is reported as never observed, not as zeros", () => {
  const detail = buildProductDetail(emptyReads());
  assert.equal(detail.observed, false);
  assert.equal(detail.market.snapshot, null);
  assert.equal(detail.match.confidence, null);
  assert.equal(detail.opportunity.score, null);
  assert.equal(detail.economics.completeness, null);
  assert.equal(detail.supplier.externalId, null);
  assert.equal(detail.history.series.assessments.length, 0);
  assert.equal(detail.competition.evidence, null);
  assert.equal(detail.watchlist.entryId, null);

  for (const section of [
    detail.market,
    detail.competition,
    detail.supplier,
    detail.match,
    detail.economics,
    detail.opportunity,
    detail.history,
    detail.freshness,
  ] as const) {
    assert.equal(section.status, "unavailable");
  }

  assert.ok(
    detail.warnings.some((warning) => warning.includes("never stored an observation")),
    "a never-observed listing states its absence in its own words",
  );

test("a marketplace-only scope has no supplier section, and says so instead of guessing one", () => {
  const detail = buildProductDetail(emptyReads());
  assert.equal(detail.supplierExternalId, null);
  assert.equal(detail.supplier.externalId, null);
  assert.equal(detail.supplier.status, "unavailable");
});

test("a supplier in scope with no supplier observation warns, and degrades only that section", () => {
  const detail = buildProductDetail(
    emptyReads({
      supplierExternalId: "cj-product-1",
      marketplaceSnapshots: [
        {
          title: "Wireless earbuds",
          imageUrl: null,
          listingUrl: null,
          price: "29.99",
          currency: "USD",
          condition: "NEW",
          sellerName: "seller-one",
          sellerFeedbackPercentage: null,
          shippingCost: "0.00",
          shippingCurrency: "USD",
          location: null,
          provenance: "OFFICIAL",
          observedAt: NOW,
        },
      ],
    }),
  );

  assert.equal(detail.observed, true);
  assert.equal(detail.market.status, "available");
  assert.equal(detail.supplier.status, "unavailable");
  assert.ok(
    detail.warnings.some((warning) => warning.includes("no supplier observation is stored")),
  );
});

test("an assessment alone makes the page observed and renders the opportunity section", () => {
  const detail = buildProductDetail(
    emptyReads({
      supplierExternalId: "cj-product-1",
      assessments: [ASSESSMENT],
    }),
  );
  assert.equal(detail.observed, true);
  assert.equal(detail.opportunity.status, "available");
  assert.equal(detail.opportunity.score, 72);
  assert.equal(detail.opportunity.band, "MEDIUM");
  assert.equal(detail.opportunity.confidence, 41);
  assert.equal(detail.opportunity.demand?.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(detail.opportunity.demand?.score, 0);

  // The history series carries the summarized assessment, not the raw document.
  const [entry] = detail.history.series.assessments;
  assert.equal(entry.score, 72);
  assert.equal(entry.band, "MEDIUM");
  assert.equal(entry.confidence, 41);
  assert.equal(entry.matchConfidence, 41);
  assert.equal(entry.economicsCompleteness, "COMPLETE");
  assert.equal(entry.calculatedAt, NOW);
});

test("a stale observation is labelled stale by the project's existing threshold, not a new one", () => {
  const staleAt = new Date(
    Date.parse(NOW) - (STALE_OBSERVATION_HOURS + 6) * 60 * 60 * 1000,
  ).toISOString();
  const detail = buildProductDetail(
    emptyReads({
      marketplaceSnapshots: [
        {
          title: "Wireless earbuds",
          imageUrl: null,
          listingUrl: null,
          price: "29.99",
          currency: "USD",
          condition: "NEW",
          sellerName: null,
          sellerFeedbackPercentage: null,
          shippingCost: null,
          shippingCurrency: null,
          location: null,
          provenance: "OFFICIAL",
          observedAt: staleAt,
        },
      ],
    }),
  );

  assert.equal(detail.market.status, "stale");
  assert.equal(detail.freshness.entries[0].stale, true);
  assert.equal(detail.freshness.staleThresholdHours, STALE_OBSERVATION_HOURS);
  assert.ok(
    detail.warnings.some((warning) => warning.includes("older than")),
    "a stale market observation warns that it describes the past",
  );
});

test("the first observation is labelled first, never as a change", () => {
  const detail = buildProductDetail(
    emptyReads({ supplierExternalId: "cj-product-1", assessments: [ASSESSMENT] }),
  );
  assert.equal(detail.history.changes.noPrevious, true);
  assert.ok(
    detail.history.changes.note.includes("first observation"),
    "the summary states it is a first observation rather than dressing up no-change",
  );
  // No row invents a previous side: a missing side is unknown, never "unchanged".
  assert.ok(
    detail.history.changes.rows.every(
      (row) => row.previous === null || row.previous === "unknown",
    ),
  );
  assert.ok(
    detail.history.changes.rows.every(
      (row) => row.direction === "unknown" || row.direction === "unchanged",
    ),
  );
});

test("history carries the bound that was actually applied, so the limit is never hidden", () => {
  const detail = buildProductDetail(emptyReads({ historyLimit: 12 }));
  assert.equal(detail.history.series.limit, 12);
  assert.ok(detail.history.series.note.includes("12"));
});

test("a watched scope reports its entry id and its archived standing", () => {
  const detail = buildProductDetail(
    emptyReads({
      supplierExternalId: "cj-product-1",
      watched: { entryId: "entry-uuid-1", archived: true },
    }),
  );
  assert.equal(detail.watchlist.entryId, "entry-uuid-1");
  assert.equal(detail.watchlist.archived, true);
  assert.equal(detail.watchlist.isPair, true);
});

test("the replay query is carried so a refresh can re-resolve the same listing", () => {
  assert.equal(buildProductDetail(emptyReads()).replayQuery, "wireless earbuds");
  assert.equal(buildProductDetail(emptyReads({ replayQuery: null })).replayQuery, null);
});

});
