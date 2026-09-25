/**
 * Pure assembly of the Product Detail read model (docs/ARCHITECTURE.md §18).
 *
 * This function is deterministic: it never reads the clock, never touches the
 * network, and never reaches a database. `now` arrives as an input, so any
 * rendered page can be replayed exactly in a unit test from fixtures alone.
 *
 * The assembly owns **no intelligence** — it selects, normalizes and labels
 * facts the persistence layer already stored. Every section computes its own
 * status so a missing supplier, match or economics observation degrades that
 * section alone and never the page (§18.5).
 */

import type { OpportunityAssessment } from "@/lib/opportunity/types";
import { COMPONENT_WEIGHTS, STALE_OBSERVATION_HOURS } from "@/lib/opportunity/types";
import type { Provenance } from "@/lib/marketplace/types";
import type { ShippingQuote } from "@/lib/supplier/types";
import type {
  EconomicsCompleteness,
  EconomicsProvenance,
  FeeBreakdownComponent,
  ShippingDestination,
  SupplierCostBasis,
} from "@/lib/economics/types";
import type {
  EconomicsObservationHistoryEntry,
  MarketplaceSnapshotHistoryEntry,
  MatchObservationHistoryEntry,
} from "@/types/product-history";
import { buildChangeSummary, elapsedHours } from "./change-summary";
import type {
  AssessmentHistoryEntry,
  ChangeSummary,
  CompetitionSection,
  EconomicsSection,
  FreshnessEntry,
  FreshnessSection,
  HistorySection,
  HistorySeries,
  MarketSection,
  MatchSection,
  OpportunitySection,
  ProductDetail,
  SupplierSection,
  WatchlistSection,
} from "./types";

/** One persisted supplier product observation, already mapped from its row. */
export interface SupplierSnapshotRead {
  title: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  category: string | null;
  /** Catalogue-level reference cost, decimal string, or `null`. */
  referenceCost: string | null;
  currency: string | null;
  availableInventory: number | null;
  warehouseCountry: string | null;
  shippingOrigin: string | null;
  provenance: Provenance;
  observedAt: string;
}

/**
 * The latest economics observation, mapped back to the money contract.
 *
 * This mirrors `EconomicsResult` but keeps nullable every field the persisted
 * row does not actually store: the economics *composition* version and the
 * selected shipping transit time are not columns on `economics_observations`,
 * so they are read as `null` rather than invented
 * (docs/DATABASE.md §6.7 — only what was written is read back).
 */
export interface LatestEconomicsRead {
  calculatedAt: string;
  itemPrice: string | null;
  buyerShipping: string | null;
  grossMarketplaceRevenue: string | null;
  currency: string | null;
  supplierProductCost: string | null;
  supplierCostBasis: SupplierCostBasis | null;
  supplierShippingCost: string | null;
  supplierShippingMethod: string | null;
  /** Not persisted as a column; always `null` when read back. */
  supplierShippingTransitTime: string | null;
  shippingQuotes: ShippingQuote[];
  shippingDestination: ShippingDestination | null;
  landedSupplierCost: string | null;
  marketplaceFee: string | null;
  feeBreakdown: FeeBreakdownComponent[];
  feeEngineVersion: string;
  feeRuleSource: string;
  estimatedProfit: string | null;
  marginPercent: string | null;
  completeness: EconomicsCompleteness;
  /** Not persisted as a column; `null` when read back. */
  economicsEngineVersion: string | null;
  assumptions: string[];
  warnings: string[];
  provenance: EconomicsProvenance | null;
}

/** Everything the persistence layer handed the builder, all newest-first. */
export interface ProductDetailReads {
  /** ISO 8601 UTC — injected by the service, never read here. */
  now: string;
  marketplaceExternalId: string;
  /** The query whose replayed window re-resolves this listing, when known. */
  replayQuery: string | null;
  /** Supplier in scope, or `null` for a marketplace-only view. */
  supplierExternalId: string | null;
  marketplaceSnapshots: MarketplaceSnapshotHistoryEntry[];
  matchObservations: MatchObservationHistoryEntry[];
  economicsObservations: EconomicsObservationHistoryEntry[];
  /** Full persisted assessment documents for this scope. */
  assessments: OpportunityAssessment[];
  supplierSnapshots: SupplierSnapshotRead[];
  /** The latest economics observation, with its full breakdown and provenance. */
  latestEconomics: LatestEconomicsRead | null;
  watched: {
    /** Active entry id for this exact scope, or `null` when none exists. */
    entryId: string | null;
    archived: boolean;
  };
  /** The bound actually applied to each history read. */
  historyLimit: number;
}

/** Hours between two ISO timestamps; `null` when either side is unusable. */
export { elapsedHours };

/** Whether an observation is older than the existing staleness threshold. */
function isStale(observedAt: string | null, now: string): boolean {
  const age = elapsedHours(observedAt, now);
  return age !== null && age > STALE_OBSERVATION_HOURS;
}

/**
 * Derives a section status from whether evidence exists and whether it is
 * fresh. A section is `stale` only when the project's existing threshold says
 * so; Product Detail invents no freshness window of its own.
 */
function statusFor(observed: boolean, stale: boolean, partial: boolean): MarketSection["status"] {
  if (!observed) {
    return "unavailable";
  }
  if (stale) {
    return "stale";
  }
  return partial ? "partial" : "available";
}

function isAbsent<T>(value: T | null | undefined): boolean {
  return value === null || value === undefined;
}


// ---------------------------------------------------------------------------
// Section builders — each independent, each honest about its own gaps
// ---------------------------------------------------------------------------

function buildMarketSection(
  snapshots: MarketplaceSnapshotHistoryEntry[],
  now: string,
): MarketSection {
  const latest = snapshots[0] ?? null;
  const unsupported = [
    "Buying options, category and listing creation date are not part of the persisted marketplace observation, so they are not shown here.",
  ];
  if (latest === null) {
    return { status: "unavailable", snapshot: null, unsupported };
  }
  // A snapshot with no price at all is present but incomplete.
  return {
    status: statusFor(true, isStale(latest.observedAt, now), isAbsent(latest.price)),
    snapshot: latest,
    unsupported,
  };
}

function buildCompetitionSection(
  assessments: OpportunityAssessment[],
): CompetitionSection {
  const competition = assessments[0]?.components.competition ?? null;
  if (competition === null) {
    return {
      status: "unavailable",
      evidence: null,
      query: null,
      limitations: [
        "No assessment is stored for this scope yet, so no competition evidence has been recorded.",
      ],
    };
  }
  return {
    status: competition.verdict === "INSUFFICIENT_EVIDENCE" ? "partial" : "available",
    evidence: competition,
    query: competition.query,
    limitations: competition.caveats,
  };
}

function buildSupplierSection(reads: ProductDetailReads): SupplierSection {
  const snapshot = reads.supplierSnapshots[0] ?? null;
  const economics = reads.economicsObservations[0] ?? null;
  const latest = reads.latestEconomics;

  const section: SupplierSection = {
    status: "unavailable",
    supplier: "cj",
    externalId: reads.supplierExternalId,
    title: snapshot?.title ?? null,
    imageUrl: snapshot?.imageUrl ?? null,
    productUrl: snapshot?.productUrl ?? null,
    category: snapshot?.category ?? null,
    referenceCost: snapshot?.referenceCost ?? null,
    currency: snapshot?.currency ?? null,
    availableInventory: snapshot?.availableInventory ?? null,
    warehouseCountry: snapshot?.warehouseCountry ?? null,
    shippingOrigin: snapshot?.shippingOrigin ?? null,
    observedAt: snapshot?.observedAt ?? null,
    provenance: snapshot?.provenance ?? null,
    costBasis: latest?.supplierCostBasis ?? economics?.supplierCostBasis ?? null,
    productCost: latest?.supplierProductCost ?? economics?.supplierProductCost ?? null,
    shippingMethod: latest?.supplierShippingMethod ?? null,
    shippingCost: latest?.supplierShippingCost ?? null,
    transitTime: latest?.supplierShippingTransitTime ?? null,
    shippingQuotes: latest?.shippingQuotes ?? [],
    usWarehouseInventory: usWarehouseVerdict(snapshot),
  };

  if (snapshot === null && economics === null && latest === null) {
    return section;
  }

  // A supplier section without a confirmed US warehouse, or one whose cost is a
  // reference rather than a resolved variant, is evidence but not confirmation.
  const partial =
    section.usWarehouseInventory === null ||
    (latest?.supplierCostBasis ?? economics?.supplierCostBasis ?? null) !== "SELECTED_VARIANT";
  section.status = partial ? "partial" : "available";
  return section;
}

/**
 * Derives the US-warehouse verdict from persisted facts only.
 *
 * An *available* product is not evidence of US inventory
 * (docs/API_INTEGRATIONS.md §3.2), so a positive verdict requires a persisted
 * US warehouse with stock. Anything else is `null` — unknown, never zero.
 */
function usWarehouseVerdict(
  snapshot: SupplierSnapshotRead | null,
): SupplierSection["usWarehouseInventory"] {
  if (snapshot === null || snapshot.availableInventory === null) {
    return null;
  }
  if (snapshot.warehouseCountry === "US") {
    return snapshot.availableInventory > 0 ? "CONFIRMED_AVAILABLE" : "CONFIRMED_NONE";
  }
  return null;
}


function buildMatchSection(
  reads: ProductDetailReads,
  economicsCompleteness: EconomicsSection["completeness"],
): MatchSection {
  const assessment = reads.assessments[0] ?? null;
  const matchComponent = assessment?.components.match ?? null;
  const matchObservation = reads.matchObservations[0] ?? null;

  const confidence = matchComponent?.confidence ?? matchObservation?.confidence ?? null;
  const band = matchComponent?.confidenceBand ?? matchObservation?.confidenceBand ?? null;

  const lowMatchWithEconomics =
    band === "LOW" && economicsCompleteness !== null && economicsCompleteness !== "UNAVAILABLE";

  if (confidence === null || band === null) {
    return {
      status: "unavailable",
      confidence: null,
      confidenceBand: null,
      explanation: null,
      supplierExternalId: reads.supplierExternalId,
      signals: [],
      contradictions: [],
      cappedByHardContradiction: false,
      matcherVersion: matchObservation?.matcherVersion ?? null,
      economicsReferToPossibleDifferentProduct: false,
      caveats: [
        "No matcher verdict is stored for this scope yet. An evaluation reports how confident INKORA is that the marketplace and supplier products are the same physical item.",
      ],
    };
  }

  const caveats: string[] = [];
  if (band === "LOW") {
    caveats.push(
      "The match confidence is LOW. INKORA cannot show that the marketplace listing and the supplier candidate are the same physical product.",
    );
  }
  if (lowMatchWithEconomics) {
    caveats.push(
      "Economics are shown despite a LOW match confidence — the profit and margin figures may describe a different physical product, not this one.",
    );
  }

  return {
    // The assessment carries the matcher's full reasoning; a bare match
    // observation carries only the score, so signals are then absent.
    status: matchComponent === null || band === "LOW" ? "partial" : "available",
    confidence,
    confidenceBand: band,
    explanation: matchComponent?.explanation ?? null,
    supplierExternalId: matchComponent?.supplierExternalId ?? reads.supplierExternalId,
    signals: matchComponent?.signals ?? [],
    contradictions: matchComponent?.contradictions ?? [],
    cappedByHardContradiction: matchComponent?.cappedByHardContradiction ?? false,
    matcherVersion: matchObservation?.matcherVersion ?? null,
    economicsReferToPossibleDifferentProduct: lowMatchWithEconomics,
    caveats,
  };
}

function buildEconomicsSection(reads: ProductDetailReads): EconomicsSection {
  const latest = reads.latestEconomics;
  if (latest === null) {
    return {
      status: "unavailable",
      completeness: null,
      sellingPrice: null,
      buyerShipping: null,
      grossRevenue: null,
      supplierProductCost: null,
      supplierShippingCost: null,
      landedCost: null,
      marketplaceFee: null,
      feeComponents: [],
      feeEngineVersion: null,
      feeRuleSource: null,
      economicsEngineVersion: null,
      estimatedProfit: null,
      marginPercent: null,
      currency: null,
      assumptions: [],
      warnings: [
        "No economics calculation is stored for this scope yet. An evaluation computes landed cost, fees, profit and margin deterministically.",
      ],
      provenance: null,
      calculatedAt: null,
    };
  }

  return {
    status: latest.completeness === "COMPLETE" ? "available" : "partial",
    completeness: latest.completeness,
    sellingPrice: latest.itemPrice,
    buyerShipping: latest.buyerShipping,
    grossRevenue: latest.grossMarketplaceRevenue,
    supplierProductCost: latest.supplierProductCost,
    supplierShippingCost: latest.supplierShippingCost,
    landedCost: latest.landedSupplierCost,
    marketplaceFee: latest.marketplaceFee,
    feeComponents: latest.feeBreakdown.map((component) => ({
      name: component.name,
      label: component.label,
      amount: component.amount,
      rate: component.rate,
      status: component.status,
      note: component.note,
    })),
    feeEngineVersion: latest.feeEngineVersion,
    feeRuleSource: latest.feeRuleSource,
    economicsEngineVersion: latest.economicsEngineVersion,
    estimatedProfit: latest.estimatedProfit,
    marginPercent: latest.marginPercent,
    currency: latest.currency,
    assumptions: latest.assumptions,
    warnings: latest.warnings,
    provenance: provenanceSummary(latest.provenance),
    calculatedAt: latest.calculatedAt,
  };
}

/** Maps the persisted per-component provenance, or `null` when absent. */
function provenanceSummary(source: EconomicsProvenance | null) {
  if (source === null) {
    return null;
  }
  return {
    itemPrice: source.itemPrice,
    buyerShipping: source.buyerShipping,
    supplierProductCost: source.supplierProductCost,
    supplierShippingCost: source.supplierShippingCost,
    marketplaceFee: source.marketplaceFee,
    estimatedProfit: source.estimatedProfit,
    marginPercent: source.marginPercent,
  };
}


function buildOpportunitySection(
  assessments: OpportunityAssessment[],
): OpportunitySection {
  const assessment = assessments[0] ?? null;
  if (assessment === null) {
    return {
      status: "unavailable",
      score: null,
      band: null,
      confidence: null,
      confidenceLevel: null,
      engineVersion: null,
      calculatedAt: null,
      factors: [],
      caps: [],
      explanation: [],
      caveats: [
        "No opportunity assessment is stored for this scope yet. An evaluation produces a deterministic, versioned score with its full reasoning.",
      ],
      components: {
        economics: null,
        match: null,
        competition: null,
        demand: null,
        dataQuality: null,
      },
      componentWeights: null,
      inputs: null,
      demand: null,
    };
  }

  return {
    status: "available",
    score: assessment.score,
    band: assessment.band,
    confidence: assessment.confidence,
    confidenceLevel: assessment.confidenceLevel,
    engineVersion: assessment.engineVersion,
    calculatedAt: assessment.calculatedAt,
    factors: assessment.factors,
    caps: assessment.caps,
    explanation: assessment.explanation,
    caveats: assessment.caveats,
    components: {
      economics: {
        score: assessment.components.economics.score,
        completeness: assessment.components.economics.completeness,
      },
      match: {
        score: assessment.components.match.score,
        confidence: assessment.components.match.confidence,
      },
      competition: {
        score: assessment.components.competition.score,
        intensity: assessment.components.competition.intensity,
        verdict: assessment.components.competition.verdict,
      },
      demand: {
        score: assessment.components.demand.score,
        verdict: assessment.components.demand.verdict,
      },
      dataQuality: { score: assessment.components.dataQuality.score },
    },
    componentWeights: { ...COMPONENT_WEIGHTS },
    inputs: { ...assessment.inputs },
    demand: assessment.components.demand,
  };
}

/** Summarizes one persisted assessment for the timeline. */
function toAssessmentHistoryEntry(
  assessment: OpportunityAssessment,
): AssessmentHistoryEntry {
  return {
    calculatedAt: assessment.calculatedAt,
    score: assessment.score,
    band: assessment.band,
    confidence: assessment.confidence,
    confidenceLevel: assessment.confidenceLevel,
    economicsCompleteness: assessment.components.economics.completeness,
    profit: assessment.components.economics.estimatedProfit,
    marginPercent:
      assessment.components.economics.marginPercent === null
        ? null
        : String(assessment.components.economics.marginPercent),
    matchConfidence: assessment.components.match.confidence,
    engineVersion: assessment.engineVersion,
    caveats: assessment.caveats,
  };
}


/** Earliest observation timestamp across every kind, or `null` when none. */
function firstObservedAt(reads: ProductDetailReads): string | null {
  const timestamps = [
    reads.marketplaceSnapshots[reads.marketplaceSnapshots.length - 1]?.observedAt ?? null,
    reads.supplierSnapshots[reads.supplierSnapshots.length - 1]?.observedAt ?? null,
    reads.assessments[reads.assessments.length - 1]?.calculatedAt ?? null,
  ].filter((value): value is string => value !== null);
  return timestamps.length === 0 ? null : timestamps.reduce((a, b) => (a < b ? a : b));
}

/** Latest observation timestamp across every kind, or `null` when none. */
function lastObservedAt(reads: ProductDetailReads): string | null {
  const timestamps = [
    reads.marketplaceSnapshots[0]?.observedAt ?? null,
    reads.supplierSnapshots[0]?.observedAt ?? null,
    reads.assessments[0]?.calculatedAt ?? null,
    reads.latestEconomics?.calculatedAt ?? null,
  ].filter((value): value is string => value !== null);
  return timestamps.length === 0 ? null : timestamps.reduce((a, b) => (a > b ? a : b));
}

function buildHistorySection(reads: ProductDetailReads): HistorySection {
  const assessments = reads.assessments.map(toAssessmentHistoryEntry);

  const series: HistorySeries = {
    status:
      reads.marketplaceSnapshots.length === 0 && assessments.length === 0
        ? "unavailable"
        : "available",
    marketplaceSnapshots: reads.marketplaceSnapshots,
    matchObservations: reads.matchObservations,
    economicsObservations: reads.economicsObservations,
    assessments,
    firstSeenAt: firstObservedAt(reads),
    lastSeenAt: lastObservedAt(reads),
    limit: reads.historyLimit,
    note: `Observations are shown most recent first, bounded at ${reads.historyLimit} per kind. Missing points are never interpolated — an absent row means Inkora did not observe that fact then.`,
  };

  const changes: ChangeSummary = buildChangeSummary({
    marketplaceSnapshots: reads.marketplaceSnapshots,
    economicsObservations: reads.economicsObservations,
    matchObservations: reads.matchObservations,
    assessments,
    supplierStock: reads.supplierSnapshots.map((snapshot) => ({
      availableInventory: snapshot.availableInventory,
      observedAt: snapshot.observedAt,
    })),
  });

  return {
    status: series.status === "unavailable" ? "unavailable" : changes.status,
    series,
    changes,
  };
}

function buildWatchlistSection(reads: ProductDetailReads): WatchlistSection {
  const isPair = reads.supplierExternalId !== null;
  if (reads.watched.entryId === null) {
    return {
      status: "available",
      entryId: null,
      isPair,
      archived: false,
      note: isPair
        ? "This marketplace × supplier pair is not on the watchlist. A NULL supplier would be a different scope, not a wildcard."
        : "This listing is not watched. A marketplace-only watch is a distinct scope from any pairing of the same listing.",
    };
  }
  return {
    status: "available",
    entryId: reads.watched.entryId,
    isPair,
    archived: reads.watched.archived,
    note: reads.watched.archived
      ? "This scope was archived. Its assessment history is kept, and the scope can be watched again."
      : "This scope is being watched. A re-evaluation is the only way to get fresh numbers, and it is a deliberate, bounded action.",
  };
}

function freshnessEntry(label: string, observedAt: string | null, now: string): FreshnessEntry {
  return {
    label,
    observedAt,
    ageHours: elapsedHours(observedAt, now),
    stale: observedAt === null ? false : isStale(observedAt, now),
  };
}

function buildFreshnessSection(reads: ProductDetailReads): FreshnessSection {
  const entries: FreshnessEntry[] = [
    freshnessEntry("Marketplace observed", reads.marketplaceSnapshots[0]?.observedAt ?? null, reads.now),
    freshnessEntry("Match assessed", reads.matchObservations[0]?.calculatedAt ?? null, reads.now),
    freshnessEntry("Supplier checked", reads.supplierSnapshots[0]?.observedAt ?? null, reads.now),
    freshnessEntry("Economics calculated", reads.latestEconomics?.calculatedAt ?? null, reads.now),
    freshnessEntry("Opportunity calculated", reads.assessments[0]?.calculatedAt ?? null, reads.now),
    freshnessEntry("History updated", lastObservedAt(reads), reads.now),
  ];

  return {
    status: entries.some((entry) => entry.observedAt !== null) ? "available" : "unavailable",
    entries,
    staleThresholdHours: STALE_OBSERVATION_HOURS,
    note: `Each figure is an observation from the moment it was made. Entries older than ${STALE_OBSERVATION_HOURS} hours are labelled stale because they describe the past, not the listing's present state — no threshold is invented here.`,
  };
}


/**
 * Assembles the Product Detail read model from persisted observations.
 *
 * Pure and total: identical inputs always yield identical output, so the whole
 * page is fixture-testable. `observed` is `false` only when Inkora has no
 * persisted observation of any kind for this listing — the page then renders
 * an honest "never observed" state and offers a deliberate evaluation rather
 * than a fabricated one.
 */
export function buildProductDetail(reads: ProductDetailReads): ProductDetail {
  const economics = buildEconomicsSection(reads);
  const match = buildMatchSection(reads, economics.completeness);
  const history = buildHistorySection(reads);
  const market = buildMarketSection(reads.marketplaceSnapshots, reads.now);

  const observed =
    reads.marketplaceSnapshots.length > 0 ||
    reads.assessments.length > 0 ||
    reads.economicsObservations.length > 0 ||
    reads.matchObservations.length > 0;

  const warnings: string[] = [];
  if (!observed) {
    warnings.push(
      "Inkora has never stored an observation for this listing. Nothing on this page is a live claim about the product until an evaluation runs.",
    );
  }
  if (reads.supplierExternalId !== null && reads.supplierSnapshots.length === 0) {
    warnings.push(
      "A supplier product is in scope for this view but no supplier observation is stored for it yet, so the supplier section reports what it can and marks the rest unavailable.",
    );
  }
  if (market.status === "stale") {
    warnings.push(
      `The latest marketplace observation is older than ${STALE_OBSERVATION_HOURS} hours, so the market section describes the past rather than the listing's present state.`,
    );
  }

  return {
    marketplace: "ebay",
    marketplaceExternalId: reads.marketplaceExternalId,
    replayQuery: reads.replayQuery,
    supplierExternalId: reads.supplierExternalId,
    observed,
    market,
    competition: buildCompetitionSection(reads.assessments),
    supplier: buildSupplierSection(reads),
    match,
    economics,
    opportunity: buildOpportunitySection(reads.assessments),
    history,
    watchlist: buildWatchlistSection(reads),
    freshness: buildFreshnessSection(reads),
    warnings,
  };
}
