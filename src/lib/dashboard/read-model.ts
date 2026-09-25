/**
 * Pure assembly of the Dashboard read model (docs/ARCHITECTURE.md §19).
 *
 * This module is deterministic: it never reads the clock, never touches the
 * network, and never reaches a database. `now` arrives as an input, so any
 * rendered Dashboard can be replayed exactly in a unit test from fixtures alone.
 *
 * The assembly owns **no intelligence** — it selects, counts, tallies and labels
 * facts the persistence layer already stored. Every section computes its own
 * status so a missing watchlist, snapshot or seller read degrades that section
 * alone and never the page (docs/ARCHITECTURE.md §19.7).
 */

import { STALE_OBSERVATION_HOURS } from "@/lib/opportunity/types";
import { productDetailHref } from "@/lib/product-detail/product-detail-links";
import type {
  ActivityEvent,
  ActivitySection,
  AttentionItem,
  AttentionSection,
  BandTally,
  CompletenessTally,
  DashboardChangeRow,
  DashboardData,
  DashboardFilters,
  DashboardSortKey,
  DataCoverageSection,
  FreshnessEntry,
  FreshnessSection,
  OpportunityMarketInfo,
  RecentChangesSection,
  ScopeAssessment,
  ScopeChange,
  SummarySection,
  SupplierEvidenceTally,
  TopOpportunitiesSection,
  TopOpportunityRow,
  WatchlistPreviewRow,
  WatchlistSummarySection,
} from "./types";
import { MARKETPLACE, SUPPLIER } from "@/lib/dashboard/dashboard-repository";
import type {
  AssessmentWindowRead,
  DashboardWatchlistEntry,
  MarketplaceSnapshotRead,
  SellerObservationRead,
} from "./dashboard-repository";
import {
  DASHBOARD_ACTIVITY_LIMIT,
  DASHBOARD_ASSESSMENT_WINDOW,
  DASHBOARD_ATTENTION_LIMIT,
  DASHBOARD_CHANGES_LIMIT,
  DASHBOARD_WATCHLIST_PREVIEW,
} from "./limits";
import {
  filterOpportunities,
  rankOpportunities,
  scopeKey,
  scopeTieBreak,
} from "./sorting";
import {
  assessmentChanged,
  deriveAttentionReasons,
} from "./attention";
import { buildChangeRows, elapsedHours } from "./changes";

/** The scopes the window collapses into, with their previous assessment if any. */
interface ScopeGroup {
  scope: ScopeAssessment;
  previous: ScopeAssessment | null;
  /** Internal id, used only to look up marketplace presentation info. */
  marketplaceProductId: string;
}

/**
 * Everything the assembly consumes. Every field is already a mapped read model,
 * so this structure is what a fixture provides and what a test asserts against.
 */
export interface DashboardReads {
  now: string;
  /** The bounded assessment window, newest first — already mapped. */
  window: AssessmentWindowRead[];
  /** Exact head count of all persisted assessments. */
  assessmentCount: number;
  /** Active watchlist entries, most recently evaluated first. */
  watchlist: DashboardWatchlistEntry[];
  /** Exact head count of active watchlist entries. */
  watchlistCount: number;
  /** Newest marketplace snapshots, newest first. */
  newestSnapshots: MarketplaceSnapshotRead[];
  /** Newest seller observations, newest first. */
  sellerObservations: SellerObservationRead[];
  /** Latest snapshot per product, for the products actually displayed. */
  marketInfo: Map<string, MarketplaceSnapshotRead>;
  /** Read sources that returned nothing, so the activity feed can label itself. */
  unavailableSources: readonly string[];
  /** Applied public controls. */
  filters: DashboardFilters;
  sort: DashboardSortKey;
  limit: number;
}

/** The replay query the Dashboard links to Product Detail with, per scope. */
function replayQueryFor(
  scope: ScopeAssessment,
  watchlist: readonly DashboardWatchlistEntry[],
): string | null {
  if (scope.competitionQuery !== null) {
    return scope.competitionQuery;
  }
  const entry = watchlist.find(
    (candidate) =>
      candidate.marketplaceExternalId === scope.marketplaceExternalId &&
      candidate.supplierExternalId === scope.supplierExternalId,
  );
  return entry?.replayQuery ?? null;
}

/** The Product Detail href for one scope, or `null` when no query is persisted. */
export function dashboardDetailHref(
  scope: ScopeAssessment,
  watchlist: readonly DashboardWatchlistEntry[],
): string | null {
  const query = replayQueryFor(scope, watchlist);
  if (query === null) {
    return null;
  }
  return productDetailHref({
    itemId: scope.marketplaceExternalId,
    query,
    supplierProductId: scope.supplierExternalId,
  });
}

/**
 * Collapses the newest-first window into one entry per scope.
 *
 * The window is already ordered by `calculated_at` descending, so the first row
 * seen for a scope is its latest assessment and the next one its immediately
 * previous — which is how the changes feed gets its two observations without a
 * second query, and how a duplicate observation never double-counts a product
 * identity. A scope with a NULL supplier is its own key (docs/ARCHITECTURE.md §16.2).
 */
export function groupScopes(window: AssessmentWindowRead[]): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();

  for (const entry of window) {
    if (entry.scope === null) {
      continue;
    }
    const key = scopeKey(entry.scope);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        scope: entry.scope,
        previous: null,
        marketplaceProductId: entry.marketplaceProductId,
      });
      continue;
    }
    if (existing.previous === null) {
      groups.set(key, { ...existing, previous: entry.scope });
    }
  }

  return [...groups.values()];
}

/** Presentation info for one scope, from the bounded displayed-product read. */
function marketInfoFor(
  group: ScopeGroup,
  marketInfo: Map<string, MarketplaceSnapshotRead>,
): OpportunityMarketInfo | null {
  const snapshot = marketInfo.get(group.marketplaceProductId);
  if (snapshot === undefined) {
    return null;
  }
  return {
    title: snapshot.title,
    imageUrl: snapshot.imageUrl,
    price: snapshot.price,
    currency: snapshot.currency,
    observedAt: snapshot.observedAt,
  };
}

/** An empty band tally, so a section with no scopes reports zeros it actually has. */
function emptyBandTally(): BandTally {
  return { HIGH: 0, MEDIUM: 0, LOW: 0 };
}

function emptyCompletenessTally(): CompletenessTally {
  return { COMPLETE: 0, PARTIAL: 0, UNAVAILABLE: 0 };
}

/** Counts a band into a tally. */
function tallyBand(tally: BandTally, band: ScopeAssessment["band"]): void {
  tally[band] += 1;
}

/** Builds the summary section from the latest assessment of every scope. */
function buildSummarySection(
  groups: readonly ScopeGroup[],
  watchlistCount: number,
  assessmentCount: number,
  attentionCount: number,
): SummarySection {
  const bands = emptyBandTally();
  const evidenceConfidence = emptyBandTally();
  const economicsCompleteness = emptyCompletenessTally();

  let profitable = 0;
  let losing = 0;
  let profitUnknown = 0;

  for (const group of groups) {
    const scope = group.scope;
    tallyBand(bands, scope.band);
    tallyBand(evidenceConfidence, scope.confidenceLevel);
    economicsCompleteness[scope.economicsCompleteness] += 1;

    if (scope.estimatedProfit === null) {
      profitUnknown += 1;
    } else if (Number.parseFloat(scope.estimatedProfit) > 0) {
      profitable += 1;
    } else {
      losing += 1;
    }
  }

  const scopes = groups.length;

  return {
    status: scopes === 0 ? "unavailable" : "available",
    note:
      scopes === 0
        ? "No opportunity has been evaluated yet. Nothing here is a statement about the marketplace — only about INKORA's database."
        : `Evaluated opportunities are the distinct scopes whose latest assessment falls inside the assessment window of ${DASHBOARD_ASSESSMENT_WINDOW}. Profitability comes from that latest assessment only; a scope with no profit figure is reported unknown, never zero.`,
    evaluatedOpportunities: scopes,
    watchedOpportunities: watchlistCount,
    profitable,
    losing,
    profitUnknown,
    needsAttention: attentionCount,
    persistedAssessments: assessmentCount,
    bands,
    evidenceConfidence,
    economicsCompleteness,
  };
}


/**
 * Builds the Top Opportunities section.
 *
 * The ranking is the Opportunity Engine's own `score` under a deterministic
 * tie-break ladder (docs/ARCHITECTURE.md §19.4) — the Dashboard introduces no
 * score, and never ranks solely by profitability. Filters apply strictly, and an
 * unrecognized value is rejected by the route before this runs.
 */
function buildTopOpportunitiesSection(params: {
  groups: readonly ScopeGroup[];
  watchlist: readonly DashboardWatchlistEntry[];
  marketInfo: Map<string, MarketplaceSnapshotRead>;
  watchedScopes: ReadonlySet<string>;
  filters: DashboardFilters;
  sort: DashboardSortKey;
  limit: number;
}): TopOpportunitiesSection {
  const scopes = params.groups.map((group) => group.scope);
  const filtered = filterOpportunities(scopes, params.filters, params.watchedScopes);
  const ranked = rankOpportunities(filtered, params.sort);
  const rows: TopOpportunityRow[] = ranked
    .slice(0, params.limit)
    .map((scope) => {
      const group = params.groups.find((candidate) => candidate.scope === scope);
      return {
        scope,
        market: group === undefined ? null : marketInfoFor(group, params.marketInfo),
        watched: params.watchedScopes.has(scopeKey(scope)),
        detailHref: dashboardDetailHref(scope, params.watchlist),
      };
    });

  const status = topOpportunitiesStatus(params.groups.length, filtered.length, rows.length);
  return {
    status,
    note: topOpportunitiesNote(status, { limit: params.limit, filteredCount: filtered.length }),
    rows,
    sort: params.sort,
    limit: params.limit,
    filteredCount: filtered.length,
  };
}

function topOpportunitiesStatus(
  scopeCount: number,
  filteredCount: number,
  rowCount: number,
): TopOpportunitiesSection["status"] {
  if (scopeCount === 0) {
    return "unavailable";
  }
  if (filteredCount === 0 || rowCount === 0) {
    return "partial";
  }
  return "available";
}

function topOpportunitiesNote(
  status: TopOpportunitiesSection["status"],
  params: { limit: number; filteredCount: number },
): string {
  if (status === "unavailable") {
    return "No opportunity has been evaluated yet, so there is nothing to rank — not a statement about the marketplace.";
  }
  if (status === "partial") {
    return "Opportunities are evaluated, but none matches the applied filters. Widen the filters, or scan for new opportunities.";
  }
  return `Ranked by the Opportunity Engine's score, then by evidence confidence, economics completeness and match confidence — never by profitability alone. Showing the newest ${params.limit} of ${params.filteredCount} matching scopes within the assessment window.`;
}

/**
 * Builds the Needs Attention section.
 *
 * Every reason is a named condition an existing engine already recorded; there is
 * no severity and no priority, and the items are ordered by the Opportunity
 * Engine's own score under the same ladder every other list uses
 * (docs/ARCHITECTURE.md §19.5).
 */
function buildAttentionSection(params: {
  groups: readonly ScopeGroup[];
  watchlist: readonly DashboardWatchlistEntry[];
  marketInfo: Map<string, MarketplaceSnapshotRead>;
  watchedScopes: ReadonlySet<string>;
}): { section: AttentionSection; items: AttentionItem[] } {
  const items: AttentionItem[] = params.groups
    .map((group) => {
      const reasons = deriveAttentionReasons(
        group.scope,
        { previous: group.previous },
        params.watchedScopes,
      );
      if (reasons.length === 0) {
        return null;
      }
      return {
        scope: group.scope,
        market: marketInfoFor(group, params.marketInfo),
        reasons,
        watched: params.watchedScopes.has(scopeKey(group.scope)),
        detailHref: dashboardDetailHref(group.scope, params.watchlist),
      };
    })
    .filter((item): item is AttentionItem => item !== null)
    .sort((a, b) => scopeTieBreak(a.scope, b.scope))
    .sort((a, b) => {
      const comparison = b.scope.score - a.scope.score;
      return comparison !== 0 ? comparison : b.scope.confidence - a.scope.confidence;
    })
    .slice(0, DASHBOARD_ATTENTION_LIMIT);

  const section: AttentionSection = {
    status: items.length === 0 ? "unavailable" : "available",
    note:
      items.length === 0
        ? "No deterministic attention condition is currently met by any evaluated opportunity. This is a derived state, not a guarantee."
        : `Each item lists the named conditions its latest assessment meets, in a fixed order. There is no severity score: the position comes from the Opportunity Engine's score, and the reasons speak for themselves. Bounded to ${DASHBOARD_ATTENTION_LIMIT} items.`,
    items,
    limit: DASHBOARD_ATTENTION_LIMIT,
  };

  return { section, items };
}

/**
 * Builds the Recent Changes section.
 *
 * A change exists only where persisted history genuinely proves it: the scope's
 * latest assessment **and** its immediately previous one, both inside the window.
 * A first observation is reported as `noPrevious`, never as "no change", and
 * never as a zero delta (docs/ARCHITECTURE.md §19.5).
 */
function buildChangesSection(params: {
  groups: readonly ScopeGroup[];
  watchlist: readonly DashboardWatchlistEntry[];
  marketInfo: Map<string, MarketplaceSnapshotRead>;
}): RecentChangesSection {
  const withPrevious = params.groups.filter((group) => group.previous !== null);

  const changes: ScopeChange[] = withPrevious
    .map((group) => {
      const rows: DashboardChangeRow[] = buildChangeRows(group.previous, group.scope);
      return {
        scope: group.scope,
        market: marketInfoFor(group, params.marketInfo),
        rows,
        calculatedAt: group.scope.calculatedAt,
        detailHref: dashboardDetailHref(group.scope, params.watchlist),
      };
    })
    .filter((change) => change.rows.some((row) => row.direction !== "unknown"))
    .sort((a, b) => (a.calculatedAt < b.calculatedAt ? 1 : a.calculatedAt > b.calculatedAt ? -1 : 0))
    .slice(0, DASHBOARD_CHANGES_LIMIT);

  const status: RecentChangesSection["status"] =
    params.groups.length === 0
      ? "unavailable"
      : withPrevious.length === 0
        ? "partial"
        : changes.length === 0
          ? "partial"
          : "available";

  return {
    status,
    note:
      status === "unavailable"
        ? "No opportunity has been evaluated, so there is no history to compare."
        : status === "partial" && withPrevious.length === 0
          ? "Every evaluated opportunity is a first observation — there is genuine history to compare yet. Re-evaluate one to produce a change."
          : status === "partial"
            ? "Changes exist but none survived the comparison: a field present on only one side is reported unknown rather than as no change."
            : `Previous versus current assessment, per scope. Two observations are a comparison — not a trend. Bounded to ${DASHBOARD_CHANGES_LIMIT} scopes.`,
    changes,
    limit: DASHBOARD_CHANGES_LIMIT,
  };
}

/**
 * Builds the Watchlist summary.
 *
 * The Dashboard does not duplicate watchlist persistence — it summarizes the same
 * active entries the watchlist page reads, and links there for the full list. An
 * entry's figures are the last-known assessment for its exact scope; an archived
 * entry is excluded from every count, because archiving is the watchlist's only
 * removal path and a freed scope is no longer monitored
 * (docs/ARCHITECTURE.md §16.5).
 */
function buildWatchlistSection(params: {
  watchlist: readonly DashboardWatchlistEntry[];
  groups: readonly ScopeGroup[];
}): WatchlistSummarySection {
  const scopesByKey = new Map<string, ScopeGroup>();
  for (const group of params.groups) {
    scopesByKey.set(scopeKey(group.scope), group);
  }

  const preview: WatchlistPreviewRow[] = params.watchlist
    .slice(0, DASHBOARD_WATCHLIST_PREVIEW)
    .map((entry) => {
      const group = scopesByKey.get(
        scopeKey({
          marketplaceExternalId: entry.marketplaceExternalId,
          supplierExternalId: entry.supplierExternalId,
        }),
      );
      const scope = group?.scope ?? null;
      return {
        entryId: entry.entryId,
        marketplaceExternalId: entry.marketplaceExternalId,
        supplierExternalId: entry.supplierExternalId,
        replayQuery: entry.replayQuery,
        label: entry.label,
        assessment: scope,
        changed:
          scope !== null &&
          group !== undefined &&
          assessmentChanged(scope, { previous: group.previous }),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        detailHref:
          scope === null
            ? productDetailHref({
                itemId: entry.marketplaceExternalId,
                query: entry.replayQuery,
                supplierProductId: entry.supplierExternalId,
              })
            : dashboardDetailHref(scope, params.watchlist),
      };
    });

  const changedCount = params.watchlist.filter((entry) => {
    const group = scopesByKey.get(
      scopeKey({
        marketplaceExternalId: entry.marketplaceExternalId,
        supplierExternalId: entry.supplierExternalId,
      }),
    );
    return (
      group !== undefined && assessmentChanged(group.scope, { previous: group.previous })
    );
  }).length;

  const marketplaceOnlyCount = params.watchlist.filter(
    (entry) => entry.supplierExternalId === null,
  ).length;

  return {
    status: params.watchlist.length === 0 ? "unavailable" : "available",
    note:
      params.watchlist.length === 0
        ? "Nothing is being watched. Watchlist entries are monitoring intent — the figures beside an entry are stored observations, read fresh on every request."
        : `Active entries only; archived entries keep their history but are no longer monitored. Preview bounded to ${DASHBOARD_WATCHLIST_PREVIEW} — the full list is on the watchlist page.`,
    activeCount: params.watchlist.length,
    marketplaceOnlyCount,
    changedCount,
    preview,
    limit: DASHBOARD_WATCHLIST_PREVIEW,
  };
}

/** Builds the data coverage section from the latest assessment per scope. */
function buildCoverageSection(groups: readonly ScopeGroup[]): DataCoverageSection {
  const evidenceConfidence = emptyBandTally();
  const matchConfidence = emptyBandTally();
  const economicsCompleteness = emptyCompletenessTally();
  const supplierEvidence: SupplierEvidenceTally = { confirmed: 0, unknown: 0, none: 0 };

  for (const group of groups) {
    const scope = group.scope;
    tallyBand(evidenceConfidence, scope.confidenceLevel);
    tallyBand(matchConfidence, scope.matchConfidenceBand);
    economicsCompleteness[scope.economicsCompleteness] += 1;

    if (scope.supplierExternalId === null) {
      supplierEvidence.none += 1;
    } else if (scope.supplierSnapshotObservedAt === null) {
      supplierEvidence.unknown += 1;
    } else {
      supplierEvidence.confirmed += 1;
    }
  }

  return {
    status: groups.length === 0 ? "unavailable" : "available",
    note:
      groups.length === 0
        ? "No assessment exists, so there is no coverage to report."
        : "Coverage is measured over the latest assessment of each scope. Supplier evidence is what the assessment itself recorded — confirmed, unknown, or no candidate at all.",
    economicsCompleteness,
    evidenceConfidence,
    matchConfidence,
    supplierEvidence,
  };
}

/**
 * Builds the Recent Activity feed.
 *
 * No event-log table exists for this, and none is created: every event is derived
 * from a persisted record that already carries the timestamp the feed needs — an
 * assessment's `calculated_at`, a snapshot's `observed_at`, a seller observation's
 * `observed_at`, a watch's `created_at` or its `updated_at`. A watch counts as
 * re-evaluated only when its `updated_at` moved past its `created_at`, which is
 * what the repository bumps on a write (docs/ARCHITECTURE.md §16.1).
 *
 * Only sources that actually produced records contribute; a source that failed is
 * reported by name so the feed can label itself partial rather than shorter.
 */
function buildActivitySection(params: {
  window: readonly AssessmentWindowRead[];
  watchlist: readonly DashboardWatchlistEntry[];
  newestSnapshots: readonly MarketplaceSnapshotRead[];
  sellerObservations: readonly SellerObservationRead[];
  unavailableSources: readonly string[];
}): ActivitySection {
  const events: ActivityEvent[] = [];

  for (const entry of params.window) {
    if (entry.scope === null) {
      continue;
    }
    events.push({
      type: "opportunity-evaluated",
      label: "Opportunity evaluated",
      detail: entry.scope.marketplaceExternalId,
      at: entry.calculatedAt,
      detailHref: dashboardDetailHref(entry.scope, params.watchlist),
    });
  }

  for (const snapshot of params.newestSnapshots) {
    events.push({
      type: "marketplace-observed",
      label: "Marketplace product observed",
      detail: snapshot.title,
      at: snapshot.observedAt,
      detailHref: null,
    });
  }

  for (const observation of params.sellerObservations) {
    events.push({
      type: "seller-observed",
      label: "Seller observed",
      detail:
        observation.username !== null && observation.username.length > 0
          ? `${observation.username} (${observation.contextQuery})`
          : `${observation.externalSellerId} (${observation.contextQuery})`,
      at: observation.observedAt,
      detailHref: null,
    });
  }

  for (const entry of params.watchlist) {
    events.push({
      type: "watch-added",
      label: "Added to watchlist",
      detail: entry.marketplaceExternalId,
      at: entry.createdAt,
      detailHref: productDetailHref({
        itemId: entry.marketplaceExternalId,
        query: entry.replayQuery,
        supplierProductId: entry.supplierExternalId,
      }),
    });
    if (entry.updatedAt > entry.createdAt) {
      events.push({
        type: "watch-re-evaluated",
        label: "Watch re-evaluated",
        detail: entry.marketplaceExternalId,
        at: entry.updatedAt,
        detailHref: productDetailHref({
          itemId: entry.marketplaceExternalId,
          query: entry.replayQuery,
          supplierProductId: entry.supplierExternalId,
        }),
      });
    }
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const bounded = events.slice(0, DASHBOARD_ACTIVITY_LIMIT);

  const status: ActivitySection["status"] =
    bounded.length === 0
      ? "unavailable"
      : params.unavailableSources.length > 0
        ? "partial"
        : "available";

  return {
    status,
    note:
      status === "unavailable"
        ? "No persisted activity yet. Every event here is derived from a record that already carries its own timestamp — nothing is invented."
        : `Derived from persisted timestamps, most recent first, bounded to ${DASHBOARD_ACTIVITY_LIMIT}. Not an exhaustive audit: it shows the newest records the Dashboard reads, not every observation INKORA holds.`,
    events: bounded,
    limit: DASHBOARD_ACTIVITY_LIMIT,
    unavailableSources: [...params.unavailableSources],
  };
}

/** One freshness entry, using the project's existing staleness threshold. */
function freshnessEntry(label: string, observedAt: string | null, now: string): FreshnessEntry {
  const age = elapsedHours(observedAt, now);
  return {
    label,
    observedAt,
    ageHours: age,
    stale: observedAt === null ? false : age !== null && age > STALE_OBSERVATION_HOURS,
  };
}

/** Builds the freshness section from timestamps the reads already carry. */
function buildFreshnessSection(params: {
  groups: readonly ScopeGroup[];
  watchlist: readonly DashboardWatchlistEntry[];
  newestSnapshots: readonly MarketplaceSnapshotRead[];
  sellerObservations: readonly SellerObservationRead[];
  now: string;
}): FreshnessSection {
  const latestAssessment = params.groups[0]?.scope.calculatedAt ?? null;
  const latestSupplier = params.groups.reduce<string | null>((newest, group) => {
    const observed = group.scope.supplierSnapshotObservedAt;
    if (observed === null) {
      return newest;
    }
    return newest === null || observed > newest ? observed : newest;
  }, null);
  const latestWatch = params.watchlist[0]?.updatedAt ?? null;
  const latestMarketplace = params.newestSnapshots[0]?.observedAt ?? null;
  const latestSeller = params.sellerObservations[0]?.observedAt ?? null;

  const entries: FreshnessEntry[] = [
    freshnessEntry("Latest opportunity evaluation", latestAssessment, params.now),
    freshnessEntry("Latest marketplace observation", latestMarketplace, params.now),
    freshnessEntry("Latest supplier observation", latestSupplier, params.now),
    freshnessEntry("Latest watchlist evaluation", latestWatch, params.now),
    freshnessEntry("Latest seller observation", latestSeller, params.now),
  ];

  return {
    status: entries.some((entry) => entry.observedAt !== null) ? "available" : "unavailable",
    entries,
    staleThresholdHours: STALE_OBSERVATION_HOURS,
    note:
      "Each entry is the newest timestamp the Dashboard read, with its age against the project's existing staleness threshold. Supplier coverage is scoped to assessed opportunities. No freshness window is invented here.",
  };
}

/**
 * Assembles the whole Dashboard read model from already-mapped reads.
 *
 * Deterministic: the only time it reads is the `now` it is given. Any rendered
 * Dashboard can be reproduced exactly from the same inputs, which is how every
 * section status, count and ordering is pinned by a unit test.
 *
 * The worst case is bounded and knowable in advance: the window is
 * `DASHBOARD_ASSESSMENT_WINDOW` rows, so every downstream section — summary,
 * ranking, attention, changes, coverage — operates on a fixed number of scopes,
 * and only the displayed-product snapshot read is driven by that count, capped by
 * `DASHBOARD_SNAPSHOT_READ_CAP`.
 */
export function assembleDashboard(reads: DashboardReads): DashboardData {
  const groups = groupScopes(reads.window);

  const watchedScopes = new Set<string>();
  for (const entry of reads.watchlist) {
    watchedScopes.add(
      scopeKey({
        marketplaceExternalId: entry.marketplaceExternalId,
        supplierExternalId: entry.supplierExternalId,
      }),
    );
  }

  const topOpportunities = buildTopOpportunitiesSection({
    groups,
    watchlist: reads.watchlist,
    marketInfo: reads.marketInfo,
    watchedScopes,
    filters: reads.filters,
    sort: reads.sort,
    limit: reads.limit,
  });

  const { section: attention, items } = buildAttentionSection({
    groups,
    watchlist: reads.watchlist,
    marketInfo: reads.marketInfo,
    watchedScopes,
  });

  const summary = buildSummarySection(
    groups,
    reads.watchlistCount,
    reads.assessmentCount,
    items.length,
  );

  const changes = buildChangesSection({
    groups,
    watchlist: reads.watchlist,
    marketInfo: reads.marketInfo,
  });

  const watchlist = buildWatchlistSection({
    watchlist: reads.watchlist,
    groups,
  });

  const coverage = buildCoverageSection(groups);

  const activity = buildActivitySection({
    window: reads.window,
    watchlist: reads.watchlist,
    newestSnapshots: reads.newestSnapshots,
    sellerObservations: reads.sellerObservations,
    unavailableSources: reads.unavailableSources,
  });

  const freshness = buildFreshnessSection({
    groups,
    watchlist: reads.watchlist,
    newestSnapshots: reads.newestSnapshots,
    sellerObservations: reads.sellerObservations,
    now: reads.now,
  });

  const warnings: string[] = [];
  const degraded = [
    summary,
    topOpportunities,
    attention,
    changes,
    watchlist,
    coverage,
    activity,
    freshness,
  ].some((section) => section.status === "unavailable");
  if (degraded) {
    warnings.push(
      "One or more sections report no evidence rather than a computed zero. Each section's status explains its own state.",
    );
  }

  return {
    marketplace: MARKETPLACE,
    supplier: SUPPLIER,
    hasIntelligence: groups.length > 0 || reads.watchlistCount > 0,
    summary,
    topOpportunities,
    attention,
    changes,
    watchlist,
    coverage,
    activity,
    freshness,
    warnings,
  };
}

