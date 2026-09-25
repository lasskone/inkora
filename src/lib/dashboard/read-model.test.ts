/**
 * Dashboard read-model tests (docs/ARCHITECTURE.md §19).
 *
 * `assembleDashboard` is pure and total, so the page's honest states are pinned
 * here from fixtures alone:
 *
 *   - a section whose evidence is missing degrades to `unavailable` or `partial`
 *     and never to a fabricated zero or an invented trend;
 *   - one failing read costs only its own section;
 *   - every bound is server-owned and cannot be raised by the caller;
 *   - the same reads always assemble the same model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { STALE_OBSERVATION_HOURS } from "@/lib/opportunity/types";

import {
  DASHBOARD_ACTIVITY_LIMIT,
  DASHBOARD_ASSESSMENT_WINDOW,
  DASHBOARD_ATTENTION_LIMIT,
  DASHBOARD_CHANGES_LIMIT,
  DASHBOARD_WATCHLIST_PREVIEW,
} from "./limits";
import { assembleDashboard, type DashboardReads } from "./read-model";
import type {
  AssessmentWindowRead,
  DashboardWatchlistEntry,
  MarketplaceSnapshotRead,
} from "./dashboard-repository";
import type { ScopeAssessment } from "./types";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const RECENT = "2026-09-23T10:00:00.000Z";
const STALE_ISO = new Date(
  NOW.getTime() - (STALE_OBSERVATION_HOURS + 12) * 60 * 60 * 1000,
).toISOString();

function makeScope(overrides: Partial<ScopeAssessment> = {}): ScopeAssessment {
  return {
    marketplaceExternalId: "v1|265983500898|0",
    supplierExternalId: "cj-product-1",
    score: 72,
    band: "MEDIUM",
    confidence: 41,
    confidenceLevel: "LOW",
    matchConfidence: 41,
    matchConfidenceBand: "LOW",
    economicsCompleteness: "COMPLETE",
    estimatedProfit: "8.40",
    marginPercent: 28.01,
    calculatedAt: RECENT,
    engineVersion: "opportunity-v1",
    competitionQuery: "wireless earbuds",
    supplierSnapshotObservedAt: RECENT,
    observationId: "obs-1",
    ...overrides,
  };
}

function makeWindowEntry(
  scope: ScopeAssessment,
  marketplaceProductId = "mp-1",
): AssessmentWindowRead {
  return {
    scope,
    marketplaceProductId,
    supplierProductId: scope.supplierExternalId,
    calculatedAt: scope.calculatedAt,
  };
}

function emptyReads(overrides: Partial<DashboardReads> = {}): DashboardReads {
  return {
    now: NOW_ISO,
    window: [],
    assessmentCount: 0,
    watchlist: [],
    watchlistCount: 0,
    newestSnapshots: [],
    sellerObservations: [],
    marketInfo: new Map<string, MarketplaceSnapshotRead>(),
    unavailableSources: [],
    filters: {},
    sort: "score",
    limit: 12,
    ...overrides,
  };
}

function snapshotFor(marketplaceProductId: string): MarketplaceSnapshotRead {
  return {
    marketplaceProductId,
    title: "Wireless Earbuds",
    imageUrl: "https://example.example/image.jpg",
    price: "29.99",
    currency: "USD",
    observedAt: RECENT,
  };
}

function watchEntry(overrides: Partial<{
  entryId: string;
  marketplaceExternalId: string;
  supplierExternalId: string | null;
  replayQuery: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}> = {}): DashboardWatchlistEntry {
  return {
    entryId: "watch-1",
    marketplaceExternalId: "v1|265983500898|0",
    supplierExternalId: "cj-product-1",
    replayQuery: "wireless earbuds",
    label: null,
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z",
    ...overrides,
  };
}


// ---------------------------------------------------------------------------
// No evidence at all
// ---------------------------------------------------------------------------

test("a database with no intelligence reports every section unavailable", () => {
  const dashboard = assembleDashboard(emptyReads());

  assert.equal(dashboard.hasIntelligence, false);
  assert.equal(dashboard.summary.status, "unavailable");
  assert.equal(dashboard.summary.evaluatedOpportunities, 0);
  assert.equal(dashboard.summary.persistedAssessments, 0);
  assert.equal(dashboard.topOpportunities.status, "unavailable");
  assert.equal(dashboard.topOpportunities.rows.length, 0);
  assert.equal(dashboard.attention.status, "unavailable");
  assert.equal(dashboard.changes.status, "unavailable");
  assert.equal(dashboard.watchlist.status, "unavailable");
  assert.equal(dashboard.coverage.status, "unavailable");
  assert.equal(dashboard.activity.status, "unavailable");
  assert.equal(dashboard.freshness.status, "unavailable");
  assert.equal(dashboard.freshness.entries.every((entry) => entry.observedAt === null), true);
  assert.equal(dashboard.warnings.length, 1);
});

test("a section never reports a count it cannot have", () => {
  const dashboard = assembleDashboard(emptyReads());

  // No fabricated zero-as-unknown: profit figures are absent, not zero.
  assert.equal(dashboard.summary.profitable, 0);
  assert.equal(dashboard.summary.losing, 0);
  assert.equal(dashboard.summary.profitUnknown, 0);
  assert.equal(dashboard.coverage.supplierEvidence.confirmed, 0);
  assert.equal(dashboard.coverage.supplierEvidence.unknown, 0);
  assert.equal(dashboard.coverage.supplierEvidence.none, 0);
});

// ---------------------------------------------------------------------------
// Scope collapsing — the window to the latest assessment per scope
// ---------------------------------------------------------------------------

test("the window collapses to the latest assessment per scope", () => {
  const latest = makeScope({ calculatedAt: RECENT, observationId: "obs-2", score: 80 });
  const previous = makeScope({
    calculatedAt: "2026-09-22T10:00:00.000Z",
    observationId: "obs-1",
    score: 60,
  });

  const dashboard = assembleDashboard(
    emptyReads({
      // Newest first, as the repository orders them.
      window: [makeWindowEntry(latest), makeWindowEntry(previous)],
      assessmentCount: 2,
    }),
  );

  assert.equal(dashboard.summary.evaluatedOpportunities, 1);
  assert.equal(dashboard.summary.persistedAssessments, 2);
  assert.equal(dashboard.topOpportunities.rows[0].scope.score, 80);
  assert.equal(dashboard.hasIntelligence, true);
});

test("a window row without its reasoning document is skipped, not reconstructed", () => {
  const good = makeScope({ observationId: "obs-good" });
  const dashboard = assembleDashboard(
    emptyReads({
      window: [
        makeWindowEntry(good),
        { ...makeWindowEntry(makeScope()), scope: null, marketplaceProductId: "mp-broken" },
      ],
      assessmentCount: 2,
    }),
  );

  assert.equal(dashboard.summary.evaluatedOpportunities, 1);
  assert.equal(dashboard.topOpportunities.rows.length, 1);
  assert.equal(dashboard.topOpportunities.rows[0].scope.observationId, "obs-good");
});

test("a marketplace-only scope is its own scope, not a wildcard supplier", () => {
  const marketplaceOnly = makeScope({
    supplierExternalId: null,
    supplierSnapshotObservedAt: null,
    observationId: "obs-marketplace-only",
  });

  const dashboard = assembleDashboard(
    emptyReads({ window: [makeWindowEntry(marketplaceOnly)], assessmentCount: 1 }),
  );

  assert.equal(dashboard.summary.evaluatedOpportunities, 1);
  assert.equal(dashboard.coverage.supplierEvidence.none, 1);
  assert.equal(dashboard.coverage.supplierEvidence.confirmed, 0);
  assert.equal(
    dashboard.attention.items[0].reasons.some((reason) => reason.code === "no-supplier-candidate"),
    true,
  );

// ---------------------------------------------------------------------------
// Ranking and bounds
// ---------------------------------------------------------------------------

test("ranking follows the engine's score, then evidence confidence, then ids", () => {
  const lowScoreStrongEvidence = makeScope({
    marketplaceExternalId: "v1|111111111111|0",
    supplierExternalId: "cj-a",
    score: 60,
    confidence: 80,
    observationId: "obs-3",
  });
  const lowScoreWeakEvidence = makeScope({
    marketplaceExternalId: "v1|222222222222|0",
    supplierExternalId: "cj-b",
    score: 60,
    confidence: 30,
    observationId: "obs-4",
  });
  const top = makeScope({
    marketplaceExternalId: "v1|333333333333|0",
    supplierExternalId: "cj-c",
    score: 90,
    confidence: 20,
    observationId: "obs-5",
  });

  const dashboard = assembleDashboard(
    emptyReads({
      window: [
        makeWindowEntry(lowScoreStrongEvidence, "mp-3"),
        makeWindowEntry(lowScoreWeakEvidence, "mp-2"),
        makeWindowEntry(top, "mp-1"),
      ],
      assessmentCount: 3,
    }),
  );

  const ordered = dashboard.topOpportunities.rows.map((row) => row.scope.observationId);
  assert.deepEqual(ordered, ["obs-5", "obs-3", "obs-4"]);
});

test("the limit is a hard bound the caller cannot raise", () => {
  const window: AssessmentWindowRead[] = [];
  for (let index = 0; index < 40; index += 1) {
    window.push(
      makeWindowEntry(
        makeScope({
          marketplaceExternalId: `v1|${index.toString().padStart(12, "0")}|0`,
          supplierExternalId: `cj-${index}`,
          score: 50 + index,
          observationId: `obs-${index}`,
        }),
        `mp-${index}`,
      ),
    );
  }

  const limited = assembleDashboard(
    emptyReads({ window, assessmentCount: window.length, limit: 5 }),
  );
  assert.equal(limited.topOpportunities.rows.length, 5);
  assert.equal(limited.topOpportunities.limit, 5);
  assert.equal(limited.topOpportunities.filteredCount, 40);

  // A client request above the documented ceiling still yields the same bounds.
  const greedy = assembleDashboard(
    emptyReads({ window, assessmentCount: window.length, limit: 5000 }),
  );
  assert.equal(greedy.topOpportunities.rows.length, 40);
  assert.equal(greedy.attention.items.length <= DASHBOARD_ATTENTION_LIMIT, true);
  assert.equal(greedy.changes.changes.length <= DASHBOARD_CHANGES_LIMIT, true);
  assert.equal(greedy.activity.events.length <= DASHBOARD_ACTIVITY_LIMIT, true);
  assert.equal(greedy.watchlist.preview.length <= DASHBOARD_WATCHLIST_PREVIEW, true);
});

test("a window larger than the assessment window collapses to distinct scopes", () => {
  // Far more rows than `DASHBOARD_ASSESSMENT_WINDOW`, but one scope re-evaluated
  // over and over: the model keeps exactly one evaluated opportunity for it and
  // the immediately previous assessment as its comparison partner.
  const window: AssessmentWindowRead[] = [];
  for (let index = 0; index < DASHBOARD_ASSESSMENT_WINDOW + 50; index += 1) {
    window.push(
      makeWindowEntry(
        makeScope({
          observationId: `obs-${index}`,
          calculatedAt: new Date(NOW.getTime() - index * 60 * 60 * 1000).toISOString(),
          score: 50 + index,
        }),
      ),
    );
  }

  const dashboard = assembleDashboard(emptyReads({ window, assessmentCount: window.length }));
  assert.equal(dashboard.summary.evaluatedOpportunities, 1);
  assert.equal(dashboard.summary.persistedAssessments, DASHBOARD_ASSESSMENT_WINDOW + 50);
  assert.equal(dashboard.changes.changes.length, 1);
  assert.equal(dashboard.changes.status, "available");
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test("a filter that matches nothing yields partial, not an empty available list", () => {
  const scope = makeScope({ observationId: "obs-1" });
  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(scope)],
      assessmentCount: 1,
      filters: { band: "HIGH" },
    }),
  );

  assert.equal(dashboard.topOpportunities.status, "partial");
  assert.equal(dashboard.topOpportunities.rows.length, 0);
  assert.equal(dashboard.topOpportunities.filteredCount, 0);
  assert.equal(dashboard.summary.status, "available");
});

test("a watch-state filter uses the exact scope, including the null supplier", () => {
  const watched = makeScope({ observationId: "obs-1" });
  const unwatched = makeScope({
    marketplaceExternalId: "v1|999999999999|0",
    supplierExternalId: "cj-other",
    observationId: "obs-2",
  });

  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(watched, "mp-1"), makeWindowEntry(unwatched, "mp-2")],
      assessmentCount: 2,
      watchlist: [
        watchEntry({
          marketplaceExternalId: watched.marketplaceExternalId,
          supplierExternalId: watched.supplierExternalId,
          createdAt: RECENT,
          updatedAt: RECENT,
        }),
      ],
      watchlistCount: 1,
      filters: { watchState: "watched" },
    }),
  );

  assert.equal(dashboard.topOpportunities.rows.length, 1);
  assert.equal(dashboard.topOpportunities.rows[0].scope.observationId, "obs-1");
  assert.equal(dashboard.topOpportunities.rows[0].watched, true);
});

});


// ---------------------------------------------------------------------------
// Needs attention — named conditions, no severity
// ---------------------------------------------------------------------------

test("attention reasons are reported in their fixed documented order", () => {
  // One scope that meets several conditions at once.
  const scope = makeScope({
    supplierExternalId: "cj-1",
    matchConfidenceBand: "LOW",
    estimatedProfit: "8.00", // profitable despite a LOW match -> low-match-profitable
    band: "MEDIUM",
    confidenceLevel: "LOW", // -> low-evidence-strong-score
    economicsCompleteness: "PARTIAL", // -> economics-partial
    supplierSnapshotObservedAt: null, // -> supplier-availability-unknown
    observationId: "obs-1",
  });

  const dashboard = assembleDashboard(
    emptyReads({ window: [makeWindowEntry(scope)], assessmentCount: 1 }),
  );

  assert.equal(dashboard.attention.status, "available");
  const codes = dashboard.attention.items[0].reasons.map((reason) => reason.code);
  assert.deepEqual(codes, [
    "low-match-profitable",
    "low-evidence-strong-score",
    "economics-partial",
    "supplier-availability-unknown",
  ]);
  assert.equal(dashboard.summary.needsAttention, 1);
});

test("a scope that meets no condition contributes no attention item", () => {
  const scope = makeScope({
    matchConfidenceBand: "HIGH",
    confidenceLevel: "HIGH",
    economicsCompleteness: "COMPLETE",
    supplierSnapshotObservedAt: RECENT,
    observationId: "obs-clean",
  });

  const dashboard = assembleDashboard(
    emptyReads({ window: [makeWindowEntry(scope)], assessmentCount: 1 }),
  );

  assert.equal(dashboard.attention.items.length, 0);
  assert.equal(dashboard.attention.status, "unavailable");
  assert.equal(dashboard.summary.needsAttention, 0);
});

test("a stored loss is reported, never clamped to zero", () => {
  const scope = makeScope({
    estimatedProfit: "-3.20",
    marginPercent: -12.5,
    observationId: "obs-loss",
  });

  const dashboard = assembleDashboard(
    emptyReads({ window: [makeWindowEntry(scope)], assessmentCount: 1 }),
  );

  assert.equal(dashboard.summary.losing, 1);
  assert.equal(dashboard.summary.profitable, 0);
  assert.equal(
    dashboard.attention.items[0].reasons.some((reason) => reason.code === "negative-profit"),
    true,
  );
});

test("a scope with no profit figure matches neither profitable nor losing", () => {
  const scope: ScopeAssessment = {
    ...makeScope({ observationId: "obs-no-profit" }),
    estimatedProfit: null,
    marginPercent: null,
  };

  const dashboard = assembleDashboard(
    emptyReads({ window: [makeWindowEntry(scope)], assessmentCount: 1 }),
  );

  assert.equal(dashboard.summary.profitUnknown, 1);
  assert.equal(dashboard.summary.profitable, 0);
  assert.equal(dashboard.summary.losing, 0);
});

test("a watched scope that changed carries the watch-changed reason", () => {
  const current = makeScope({ score: 80, observationId: "obs-now" });
  const previous = makeScope({ score: 55, observationId: "obs-then" });
  previous.calculatedAt = "2026-09-20T10:00:00.000Z";

  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(current), makeWindowEntry(previous, "mp-1")],
      assessmentCount: 2,
      watchlist: [watchEntry()],
      watchlistCount: 1,
    }),
  );

  const item = dashboard.attention.items[0];
  assert.equal(item.watched, true);
  assert.equal(
    item.reasons.some((reason) => reason.code === "watch-changed"),
    true,
  );

// ---------------------------------------------------------------------------
// Recent changes — two observations, never a trend
// ---------------------------------------------------------------------------

test("a scope with one assessment reports no change rather than an invented delta", () => {
  const scope = makeScope({ observationId: "obs-first" });
  const dashboard = assembleDashboard(
    emptyReads({ window: [makeWindowEntry(scope)], assessmentCount: 1 }),
  );

  assert.equal(dashboard.changes.status, "partial");
  assert.equal(dashboard.changes.changes.length, 0);
});

test("a genuine change is measured previous vs current, field by field", () => {
  const current = makeScope({
    score: 80,
    estimatedProfit: "12.00",
    marginPercent: 40,
    observationId: "obs-now",
  });
  const previous = makeScope({
    score: 60,
    estimatedProfit: "4.00",
    marginPercent: 15,
    calculatedAt: "2026-09-20T10:00:00.000Z",
    observationId: "obs-then",
  });

  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(current), makeWindowEntry(previous, "mp-1")],
      assessmentCount: 2,
    }),
  );

  assert.equal(dashboard.changes.status, "available");
  assert.equal(dashboard.changes.changes.length, 1);
  const rows = dashboard.changes.changes[0].rows;
  const scoreRow = rows.find((row) => row.field === "opportunityScore");
  const profitRow = rows.find((row) => row.field === "estimatedProfit");
  assert.equal(scoreRow?.direction, "up");
  assert.equal(profitRow?.direction, "up");
  assert.equal(profitRow?.previous, "4.00");
  assert.equal(profitRow?.current, "12.00");
});

test("a field present on only one side is unknown, never zero or unchanged", () => {
  const current = makeScope({ estimatedProfit: "12.00", observationId: "obs-now" });
  const previous: ScopeAssessment = {
    ...makeScope({ observationId: "obs-then" }),
    estimatedProfit: null,
    marginPercent: null,
  };
  previous.calculatedAt = "2026-09-20T10:00:00.000Z";

  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(current), makeWindowEntry(previous, "mp-1")],
      assessmentCount: 2,
    }),
  );

  const profitRow = dashboard.changes.changes[0].rows.find(
    (row) => row.field === "estimatedProfit",
  );
  assert.equal(profitRow?.direction, "unknown");
  assert.equal(profitRow?.previous, null);
});

test("an identical re-evaluation reports every comparable field unchanged", () => {
  const current = makeScope({ observationId: "obs-now" });
  const previous = makeScope({
    calculatedAt: "2026-09-20T10:00:00.000Z",
    observationId: "obs-then",
  });

  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(current), makeWindowEntry(previous, "mp-1")],
      assessmentCount: 2,
    }),
  );

  // Nothing moved: the entry survives with every field `unchanged`, so the page
  // can state "re-evaluated, no movement" instead of inventing a delta.
  assert.equal(dashboard.changes.status, "available");
  assert.equal(dashboard.changes.changes.length, 1);
  const directions = dashboard.changes.changes[0].rows.map((row) => row.direction);
  assert.equal(directions.every((direction) => direction === "unchanged"), true);

// ---------------------------------------------------------------------------
// Watchlist summary
// ---------------------------------------------------------------------------

test("the watchlist summary counts only active entries and their exact scopes", () => {
  const pairAssessment = makeScope({ observationId: "obs-pair" });
  const previousPair = makeScope({
    score: 40,
    calculatedAt: "2026-09-20T10:00:00.000Z",
    observationId: "obs-pair-previous",
  });

  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(pairAssessment), makeWindowEntry(previousPair, "mp-1")],
      assessmentCount: 2,
      watchlist: [
        watchEntry({
          entryId: "watch-pair",
          label: "Earbuds pair",
          updatedAt: RECENT,
        }),
        watchEntry({
          entryId: "watch-marketplace-only",
          marketplaceExternalId: "v1|777777777777|0",
          supplierExternalId: null,
          replayQuery: "phone case",
        }),
      ],
      watchlistCount: 2,
    }),
  );

  assert.equal(dashboard.watchlist.status, "available");
  assert.equal(dashboard.watchlist.activeCount, 2);
  assert.equal(dashboard.watchlist.marketplaceOnlyCount, 1);
  assert.equal(dashboard.watchlist.changedCount, 1);
  assert.equal(dashboard.watchlist.preview.length, 2);
  const pairPreview = dashboard.watchlist.preview.find(
    (entry) => entry.entryId === "watch-pair",
  );
  assert.equal(pairPreview?.assessment?.observationId, "obs-pair");
  assert.equal(pairPreview?.changed, true);
  assert.equal(pairPreview?.label, "Earbuds pair");
  assert.notEqual(pairPreview?.detailHref, null);

  // An entry with no assessment yet links to Product Detail by replay query.
  const freshPreview = dashboard.watchlist.preview.find(
    (entry) => entry.entryId === "watch-marketplace-only",
  );
  assert.equal(freshPreview?.assessment, null);
  assert.equal(freshPreview?.changed, false);
  assert.notEqual(freshPreview?.detailHref, null);
});

});


test("a watchlist entry never matches a scope of a different supplier", () => {
  const scope = makeScope({
    supplierExternalId: "cj-actual",
    observationId: "obs-1",
  });

  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(scope)],
      assessmentCount: 1,
      watchlist: [
        watchEntry({
          marketplaceExternalId: scope.marketplaceExternalId,
          supplierExternalId: "cj-different",
        }),
      ],
      watchlistCount: 1,
    }),
  );

  assert.equal(dashboard.topOpportunities.rows[0].watched, false);
  assert.equal(dashboard.watchlist.preview[0].assessment, null);
  assert.equal(dashboard.watchlist.changedCount, 0);
});

// ---------------------------------------------------------------------------
// Data coverage
// ---------------------------------------------------------------------------

test("coverage tallies the latest assessment per scope with the engines' own bands", () => {
  const pairWithSupplier = makeScope({
    supplierExternalId: "cj-1",
    supplierSnapshotObservedAt: RECENT,
    confidenceLevel: "HIGH",
    matchConfidenceBand: "HIGH",
    economicsCompleteness: "COMPLETE",
    band: "HIGH",
    observationId: "obs-1",
  });
  const pairWithoutSupplierObservation = makeScope({
    marketplaceExternalId: "v1|888888888888|0",
    supplierExternalId: "cj-2",
    supplierSnapshotObservedAt: null,
    confidenceLevel: "MEDIUM",
    matchConfidenceBand: "MEDIUM",
    economicsCompleteness: "PARTIAL",
    band: "MEDIUM",
    observationId: "obs-2",
  });

  const dashboard = assembleDashboard(
    emptyReads({
      window: [
        makeWindowEntry(pairWithSupplier, "mp-1"),
        makeWindowEntry(pairWithoutSupplierObservation, "mp-2"),
      ],
      assessmentCount: 2,
    }),
  );

  assert.equal(dashboard.coverage.status, "available");
  assert.deepEqual(dashboard.coverage.evidenceConfidence, { HIGH: 1, MEDIUM: 1, LOW: 0 });
  assert.deepEqual(dashboard.coverage.matchConfidence, { HIGH: 1, MEDIUM: 1, LOW: 0 });
  assert.deepEqual(dashboard.coverage.economicsCompleteness, {
    COMPLETE: 1,
    PARTIAL: 1,
    UNAVAILABLE: 0,
  });
  assert.deepEqual(dashboard.coverage.supplierEvidence, {
    confirmed: 1,
    unknown: 1,
    none: 0,
  });
  assert.deepEqual(dashboard.summary.bands, { HIGH: 1, MEDIUM: 1, LOW: 0 });
});

test("coverage counts a marketplace-only scope as no supplier candidate, not an unknown one", () => {
  const dashboard = assembleDashboard(
    emptyReads({
      window: [
        makeWindowEntry(
          makeScope({
            supplierExternalId: null,
            supplierSnapshotObservedAt: null,
            observationId: "obs-marketplace-only",
          }),
        ),
      ],
      assessmentCount: 1,
    }),
  );

  assert.deepEqual(dashboard.coverage.supplierEvidence, { confirmed: 0, unknown: 0, none: 1 });
});


// ---------------------------------------------------------------------------
// Recent activity — derived timestamps, no event table
// ---------------------------------------------------------------------------

test("the activity feed is derived from persisted timestamps, newest first", () => {
  const scope = makeScope({ observationId: "obs-1" });
  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(scope)],
      assessmentCount: 1,
      watchlist: [watchEntry({ createdAt: "2026-09-19T10:00:00.000Z" })],
      watchlistCount: 1,
      newestSnapshots: [snapshotFor("mp-1")],
      sellerObservations: [
        {
          externalSellerId: "seller-1",
          username: "SuperStore",
          contextQuery: "wireless earbuds",
          observedAt: "2026-09-22T10:00:00.000Z",
        },
      ],
    }),
  );

  assert.equal(dashboard.activity.status, "available");
  const types = dashboard.activity.events.map((event) => event.type);
  assert.deepEqual(types, [
    "opportunity-evaluated",
    "marketplace-observed",
    "seller-observed",
    "watch-re-evaluated",
    "watch-added",
  ]);
  for (let index = 1; index < dashboard.activity.events.length; index += 1) {
    const earlier = dashboard.activity.events[index - 1];
    const later = dashboard.activity.events[index];
    assert.equal(earlier.at >= later.at, true, `events are newest-first at ${index}`);
  }
  assert.equal(
    dashboard.activity.events.some((event) => event.detailHref !== null),
    true,
  );
});

test("a watch counts as re-evaluated only when its updated_at moved past created_at", () => {
  const scope = makeScope({ observationId: "obs-1" });
  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(scope)],
      assessmentCount: 1,
      watchlist: [watchEntry({ createdAt: RECENT, updatedAt: RECENT })],
      watchlistCount: 1,
    }),
  );

  const types = dashboard.activity.events.map((event) => event.type);
  assert.deepEqual(types, ["opportunity-evaluated", "watch-added"]);
});

test("a failed read source is reported by name and degrades only its own section", () => {
  const scope = makeScope({ observationId: "obs-1" });
  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(scope)],
      assessmentCount: 1,
      unavailableSources: ["marketplace-seller-observations"],
    }),
  );

  assert.equal(dashboard.activity.status, "partial");
  assert.deepEqual(dashboard.activity.unavailableSources, [
    "marketplace-seller-observations",
  ]);
  // The sections that needed no seller observation are untouched.
  assert.equal(dashboard.summary.status, "available");
  assert.equal(dashboard.topOpportunities.status, "available");
  assert.equal(dashboard.coverage.status, "available");
  assert.equal(dashboard.freshness.status, "available");
});

// ---------------------------------------------------------------------------
// Freshness — age reported, one reused threshold
// ---------------------------------------------------------------------------

test("freshness reports the age of every source against the engines' own threshold", () => {
  const fresh = makeScope({ calculatedAt: RECENT, observationId: "obs-fresh" });
  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(fresh)],
      assessmentCount: 1,
      newestSnapshots: [{ ...snapshotFor("mp-1"), observedAt: STALE_ISO }],
    }),
  );

  assert.equal(dashboard.freshness.status, "available");
  assert.equal(dashboard.freshness.staleThresholdHours, STALE_OBSERVATION_HOURS);

  const assessment = dashboard.freshness.entries.find(
    (entry) => entry.label === "Latest opportunity evaluation",
  );
  const marketplace = dashboard.freshness.entries.find(
    (entry) => entry.label === "Latest marketplace observation",
  );
  assert.notEqual(assessment?.observedAt, null);
  assert.equal(assessment?.stale, false);
  assert.equal(assessment?.ageHours, 2);
  assert.equal(marketplace?.observedAt, STALE_ISO);
  assert.equal(marketplace?.stale, true);
  assert.notEqual(marketplace?.ageHours, null);
});

test("a stale assessment is flagged stale, never labelled fresh", () => {
  const stale = makeScope({ calculatedAt: STALE_ISO, observationId: "obs-stale" });
  const dashboard = assembleDashboard(emptyReads({ window: [makeWindowEntry(stale)] }));

  const assessment = dashboard.freshness.entries.find(
    (entry) => entry.label === "Latest opportunity evaluation",
  );
  assert.equal(assessment?.observedAt, STALE_ISO);
  assert.equal(assessment?.stale, true);
});

test("a never-observed source reports null and unknown age, not zero", () => {
  const dashboard = assembleDashboard(emptyReads());

  for (const entry of dashboard.freshness.entries) {
    assert.equal(entry.observedAt, null);
    assert.equal(entry.ageHours, null);
    assert.equal(entry.stale, false);
  }
});

});


// ---------------------------------------------------------------------------
// Market info join
// ---------------------------------------------------------------------------

test("a product with no persisted snapshot renders without a title and price", () => {
  const scope = makeScope({ observationId: "obs-1" });
  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(scope, "mp-1")],
      assessmentCount: 1,
      marketInfo: new Map<string, MarketplaceSnapshotRead>([
        ["mp-other", snapshotFor("mp-other")],
      ]),
    }),
  );

  assert.equal(dashboard.topOpportunities.rows[0].market, null);
});

test("the displayed products' snapshots join on the internal product id", () => {
  const scope = makeScope({ observationId: "obs-1" });
  const dashboard = assembleDashboard(
    emptyReads({
      window: [makeWindowEntry(scope, "mp-1")],
      assessmentCount: 1,
      marketInfo: new Map<string, MarketplaceSnapshotRead>([["mp-1", snapshotFor("mp-1")]]),
    }),
  );

  assert.equal(dashboard.topOpportunities.rows[0].market?.title, "Wireless Earbuds");
  assert.equal(dashboard.topOpportunities.rows[0].market?.price, "29.99");
  assert.equal(dashboard.topOpportunities.rows[0].market?.currency, "USD");
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("the same reads always assemble the identical model", () => {
  const reads: DashboardReads = emptyReads({
    window: [makeWindowEntry(makeScope({ observationId: "obs-1" }))],
    assessmentCount: 1,
    watchlist: [watchEntry()],
    watchlistCount: 1,
    marketInfo: new Map<string, MarketplaceSnapshotRead>([["mp-1", snapshotFor("mp-1")]]),
  });

  const first = assembleDashboard(reads);
  const second = assembleDashboard(structuredClone(reads));

  assert.deepEqual(first, second);
});

test("the read model identifies the marketplace and supplier it summarises", () => {
  const dashboard = assembleDashboard(emptyReads());
  assert.equal(dashboard.marketplace, "ebay");
  assert.equal(dashboard.supplier, "cj");
});
