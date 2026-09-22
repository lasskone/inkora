/**
 * Provider-independent Opportunity Engine V1 — type declarations.
 *
 * The Opportunity Engine answers one question:
 *
 *   Given the evidence currently available, how interesting is this
 *   marketplace × supplier opportunity, and why?
 *
 * It is a deterministic, versioned, explainable assessment. It is NOT an AI
 * opinion, and it is NOT a guarantee of profitability or future sales
 * (docs/ARCHITECTURE.md §9, docs/MVP_SPEC.md).
 *
 * Five independent, inspectable components feed one bounded score:
 *
 * ```text
 *   Marketplace demand evidence
 *   Marketplace competition evidence
 *   Product-match confidence
 *   Economic quality
 *   Data quality / completeness
 *           ↓
 *   Deterministic Opportunity Assessment (score + band)
 *   Evidence confidence                        (separate number, see below)
 * ```
 *
 * ## Score versus confidence — mandatory separation
 *
 * The **score** is *attractiveness under the current model*: "if this
 * opportunity is real, how good is it?" The **confidence** is *how much the
 * available evidence supports the assessment*: "how much of that is actually
 * known?" They are computed by different formulas and are reported side by
 * side, because a high calculated margin over weak evidence must never look
 * equivalent to the same margin over strong evidence.
 *
 * This module is pure type declarations plus named constants on purpose: no
 * `server-only`, no I/O, so the whole model is unit-testable with Node's
 * built-in runner and the same shapes serve the browser UI.
 */

import type {
  MarketplaceId,
  MarketplaceProduct,
  MarketplaceSearchResult,
} from "@/lib/marketplace/types";
import type {
  ConfidenceBand,
  MatchCandidate,
  MatchContradiction,
  MatchSignal,
} from "@/lib/matcher/types";
import type { SupplierId } from "@/lib/supplier/types";

/**
 * The economics layer's own completeness and cost-basis vocabularies are
 * re-exported here so consumers of the Opportunity Engine never have to reach
 * into `@/lib/economics/types` for the two words an assessment speaks.
 */
export type {
  EconomicsCompleteness,
  SupplierCostBasis,
} from "@/lib/economics/types";
import type {
  EconomicsCompleteness,
  EconomicsResult,
  SupplierCostBasis,
} from "@/lib/economics/types";

/**
 * Version of the Opportunity Engine logic that produced an assessment.
 *
 * Bumped whenever a component formula, a weight, a cap, a band threshold, or a
 * confidence rule changes. Persisted with every assessment so a historical
 * score stays attributable to the exact logic that produced it and is never
 * silently re-meaningful under newer code (docs/DATABASE.md §7).
 */
export const OPPORTUNITY_ENGINE_VERSION = "opportunity-v1";

/** 0 (no evidence of attractiveness) to 100 (strongest evidence under the current model). */
export const SCALE_MAX = 100;
export const SCALE_MIN = 0;

/**
 * Band thresholds on the 0–100 scale, deliberately identical to the Product
 * Matcher's (docs/ARCHITECTURE.md §8) so one scale reads the same everywhere:
 *
 * - `HIGH`   — ≥ 70
 * - `MEDIUM` — 45–69
 * - `LOW`    — < 45
 *
 * A HIGH score means *strong evidence under INKORA's current deterministic
 * model*. It is not a prediction of commercial success.
 */
export const HIGH_BAND_THRESHOLD = 70;
export const MEDIUM_BAND_THRESHOLD = 45;

export function bandForScore(score: number): OpportunityBand {
  if (score >= HIGH_BAND_THRESHOLD) return "HIGH";
  if (score >= MEDIUM_BAND_THRESHOLD) return "MEDIUM";
  return "LOW";
}

/** Attractiveness band of the opportunity score. */
export type OpportunityBand = "LOW" | "MEDIUM" | "HIGH";

/** Band of the *evidence confidence*, computed independently from the score. */
export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";


// ---------------------------------------------------------------------------
// Weights — declared once, used everywhere, never hidden
// ---------------------------------------------------------------------------

/** Component names, in the order they aggregate. */
export type ComponentName =
  | "economics"
  | "match"
  | "competition"
  | "demand"
  | "dataQuality";

/**
 * Aggregation weights of the five components into the opportunity score.
 *
 * The sum is exactly 1.0. Rationale, from the evidence the V1 pipeline
 * actually produces:
 *
 * - **economics 0.40** — the only component built from official, auditable
 *   money figures on both sides of the trade. It is the hardest quantitative
 *   evidence Inkora has, so it dominates.
 * - **match 0.25** — identity risk: a profitable match to the *wrong* product
 *   is worthless, so product identity must materially move the score. It is
 *   not 0.40 because the matcher's confidence is itself text-only and
 *   estimated, so it cannot outrank arithmetic over official prices.
 * - **competition 0.15** — real but sampled and query-context-dependent
 *   (see `CompetitionAssessment`), so it is weighted lightly.
 * - **demand 0.10** — V1 has essentially no legitimate demand signal from the
 *   official eBay API, so this weight is deliberately small: it leaves room
 *   for the component to exist (and to grow when real demand evidence is
 *   built) without letting absence of evidence dominate the score.
 * - **dataQuality 0.10** — evidence quality enters attractiveness modestly;
 *   its main effect is on **confidence**, which is the honest place to express
 *   uncertainty.
 *
 * These are deliberately *not* tuned against live examples; they are a
 * documented starting model. Changing any of them requires a new engine
 * version, because every persisted score is attributed to this version.
 */
export const COMPONENT_WEIGHTS = {
  economics: 0.4,
  match: 0.25,
  competition: 0.15,
  demand: 0.1,
  dataQuality: 0.1,
} as const satisfies Record<ComponentName, number>;

/**
 * Confidence weights. Competition and demand do **not** appear: a highly
 * contested market with no demand evidence can still be *well evidenced*, and
 * confidence measures the evidence, not the desirability. Demand evidence
 * enters confidence through `DEMAND_CONFIDENCE_FACTORS` instead.
 */
export const CONFIDENCE_WEIGHTS = {
  economics: 0.35,
  match: 0.35,
  dataQuality: 0.3,
} as const;

/**
 * How many confidence points the assessment may exceed its weakest hard
 * evidence dimensions. No amount of arithmetic certainty about the money can
 * compensate for being uncertain *which product* is being costed, so a LOW
 * match caps overall trust; the same reasoning applies to incomplete economics
 * and to thin evidence quality.
 */
export const CONFIDENCE_SLACK = 20;

/**
 * Multiplier applied to the confidence when demand evidence is missing or
 * weak. Demand is the dimension V1 can least support from official data, so an
 * assessment with no demand evidence is reported as markedly less trustworthy
 * — never as "no demand exists".
 */
export const DEMAND_CONFIDENCE_FACTORS = {
  SUPPORTING: 1,
  WEAKLY_SUPPORTING: 0.85,
  INSUFFICIENT_EVIDENCE: 0.6,
} as const satisfies Record<DemandVerdict, number>;

/**
 * Hard score caps imposed by the conservative gates (see `assess.ts`). Each is
 * derived from the band thresholds rather than chosen freely, so a gate can be
 * explained as "this candidate cannot enter the HIGH band" or "cannot enter
 * the MEDIUM band" instead of as an arbitrary number.
 */
export const SCORE_CAPS = {
  /** A LOW-confidence match can never receive an unqualified HIGH or MEDIUM assessment. */
  LOW_MATCH: MEDIUM_BAND_THRESHOLD - 1,
  /** Economics that cannot produce a profit figure cannot be attractive. */
  UNAVAILABLE_ECONOMICS: MEDIUM_BAND_THRESHOLD - 1,
  /** A confirmed loss is not an opportunity, even with a perfect match. */
  NEGATIVE_COMPLETE_PROFIT: MEDIUM_BAND_THRESHOLD - 1,
  /** Incomplete economics may be worth investigating, but not rated HIGH. */
  PARTIAL_ECONOMICS: HIGH_BAND_THRESHOLD - 1,
} as const;


// ---------------------------------------------------------------------------
// Component thresholds
// ---------------------------------------------------------------------------

/**
 * Margin percentage at which the economics component saturates. Chosen against
 * the economics layer's own model: eBay's managed-payments final value fee
 * alone consumes roughly 13–15% of a typical sale, so a 30% margin is a strong
 * but not implausible result. Below it the component scales linearly; above it,
 * extra margin adds nothing, which keeps the engine from chasing outliers.
 */
export const MARGIN_SATURATION_PERCENT = 30;

/**
 * Multiplier applied to the economics component when the economics verdict is
 * `PARTIAL`: the profit figure exists but rests on a non-definitive input, so
 * it is worth materially less than a `COMPLETE` figure.
 */
export const PARTIAL_ECONOMICS_FACTOR = 0.6;

/**
 * Multiplier applied when the supplier cost is a *reference* rather than the
 * cost of the identified variant (see `SupplierCostBasis` in
 * `@/lib/economics/types`). A reference cost can overstate or understate the
 * true cost, so the economics built on it are discounted.
 */
export const REFERENCE_COST_FACTOR = 0.7;

/** Price band, as a fraction of the listing's own price, counted as "similarly priced". */
export const SIMILAR_PRICE_BAND = { low: 0.5, high: 2 } as const;

/**
 * Minimum separation, in hours, between two observations before they may count
 * as *two* observations for evidence purposes. Two snapshots minutes apart are
 * the same observation seen twice — the persistence layer's deduplication
 * policy already collapses identical ones, and this guard keeps near-identical
 * ones from being reported as a trend.
 */
export const MIN_TREND_GAP_HOURS = 1;

/**
 * Age, in hours, after which a persisted marketplace observation is treated as
 * stale for data-quality purposes. A snapshot this old describes the past, not
 * the listing's current state, so it costs evidence quality rather than being
 * presented as current. No forecasting is attempted.
 */
export const STALE_OBSERVATION_HOURS = 72;

/**
 * Minimum span, in hours, between the earliest and latest usable observations
 * before listing persistence can be read as `SUPPORTING` rather than merely
 * `WEAKLY_SUPPORTING`. Two snapshots an hour apart prove the listing was listed
 * twice; they do not prove it has been listed for long.
 */
export const MEANINGFUL_PERSISTENCE_HOURS = 24;

/**
 * Component score for each demand verdict. Zero points are ever manufactured:
 * `INSUFFICIENT_EVIDENCE` contributes nothing, so an assessment with no demand
 * evidence is not rewarded for having none and is not punished for lacking it.
 */
export const DEMAND_SCORES = {
  SUPPORTING: 100,
  WEAKLY_SUPPORTING: 50,
  INSUFFICIENT_EVIDENCE: 0,
} as const satisfies Record<DemandVerdict, number>;

/**
 * Aggregation weights of the three sub-measures of competition intensity:
 *
 * - **breadth 0.50** — the provider's own result count, the broadest available
 *   signal of how many listings compete for this query.
 * - **crowding 0.30** — distinct sellers among the inspected listings: many
 *   sellers mean many independent competitors, not one merchant multi-listing.
 * - **priceProximity 0.20** — offers priced near this listing are the
 *   alternatives a buyer would actually compare against.
 */
export const COMPETITION_INTENSITY_WEIGHTS = {
  breadth: 0.5,
  crowding: 0.3,
  priceProximity: 0.2,
} as const;

/** Competition-intensity thresholds, in the same 0–100 units as `intensity`. */
export const COMPETITION_VERDICT_THRESHOLDS = {
  /** Below this, competition appears limited. */
  limited: 35,
  /** At or above this, competition appears broad. */
  broad: 65,
} as const;

/**
 * How trustworthy the *money figures* are, per economics completeness. This is
 * a confidence proxy, not a score: it feeds `confidence` only, never `score`
 * (the score's economics component is `assessEconomicsComponent`).
 */
export const ECONOMICS_CONFIDENCE_PROXY = {
  COMPLETE: 100,
  PARTIAL: 60,
  UNAVAILABLE: 15,
} as const satisfies Record<EconomicsCompleteness, number>;

/**
 * Confidence proxy for the match dimension when the matcher surfaced no
 * candidate at all: nothing is known about which product would be sourced, so
 * the assessment cannot be trusted regardless of how good the money looks.
 */
export const NO_MATCH_CONFIDENCE_PROXY = 0;

/**
 * Band of an evidence-confidence value. Uses the same thresholds as the score
 * deliberately: one scale reads the same everywhere, and a `LOW`-confidence
 * assessment should read as plainly as a `LOW` score.
 */
export function confidenceLevelFor(confidence: number): ConfidenceLevel {
  if (confidence >= HIGH_BAND_THRESHOLD) return "HIGH";
  if (confidence >= MEDIUM_BAND_THRESHOLD) return "MEDIUM";
  return "LOW";
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

/**
 * One checked dimension of evidence quality, with its own signed contribution.
 * Named dimensions keep the UI honest: the user sees *which* fact is weak, not
 * just that something is.
 */
export interface DataQualityDimension {
  /** Stable machine name, e.g. `marketplacePricePresent`. */
  name: string;
  /** Human-readable label, e.g. `Marketplace price present`. */
  label: string;
  /** Points contributed to the data-quality component; may be negative. */
  contribution: number;
  /** What was observed, in human-readable form. */
  detail: string;
}

/**
 * The **data quality** component: how complete and how fresh the evidence
 * underlying the whole assessment is.
 *
 * This is the component that makes an assessment honest about itself. It
 * contributes modestly to the score (its weight is 0.10) and *dominates* the
 * confidence, which is the mathematically correct place for evidence quality to
 * be expressed: an assessment built from stale, partial inputs cannot be a
 * high-confidence assessment no matter how good the arithmetic looks.
 */
export interface DataQualityAssessment {
  /** Contribution to the opportunity score (0–100). */
  score: number;
  /** Every checked dimension, in the order checked. */
  dimensions: DataQualityDimension[];
  /** What was complete and current. */
  evidence: string[];
  /** What was missing, stale, or unverifiable. */
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Explainability primitives
// ---------------------------------------------------------------------------

/**
 * One deterministic, human-readable reason the assessment came out as it did.
 * Every cap, gate, and weight the engine applies produces one of these, so no
 * score is ever an unexplained number.
 */
export interface OpportunityFactor {
  /** Stable machine name, e.g. `negativeCompleteProfitGate`. */
  name: string;
  /** Human-readable label, e.g. `Confirmed loss`. */
  label: string;
  /** Signed effect on the final score. */
  contribution: number;
  /** What happened, and why it matters. */
  detail: string;
}

/**
 * A hard cap that was actually applied. Caps are expressed against band
 * thresholds rather than as free numbers, so each one reads as "this
 * opportunity cannot enter the HIGH band" instead of as an arbitrary penalty.
 */
export interface AppliedCap {
  name: string;
  label: string;
  /** The cap value that was applied, on the 0–100 scale. */
  cap: number;
  /** Why the cap exists and what it protects against. */
  reason: string;
}


// ---------------------------------------------------------------------------
// Demand
// ---------------------------------------------------------------------------

/**
 * Honest verdict on how much *demand* evidence exists for this opportunity.
 *
 * V1 deliberately offers no "HIGH demand" verdict: the official eBay APIs
 * Inkora uses do not return units sold, sales velocity, conversion rate,
 * revenue, or demand history, so no such figure is ever derived. What the
 * engine can legitimately observe is that a listing remained listed and priced
 * across sufficiently separated observations, which is weak support at best.
 *
 * - `INSUFFICIENT_EVIDENCE` — nothing in the available evidence speaks to
 *   demand. This is the *preferred* answer when in doubt, and it is the common
 *   case on a first evaluation.
 * - `WEAKLY_SUPPORTING`     — the listing persisted across separated
 *   observations, which is consistent with ongoing listing but proves nothing
 *   about volume.
 * - `SUPPORTING`            — the listing persisted *and* held its price across
 *   a meaningful span. Still not a volume claim.
 */
export type DemandVerdict =
  | "INSUFFICIENT_EVIDENCE"
  | "WEAKLY_SUPPORTING"
  | "SUPPORTING";

export interface DemandAssessment {
  verdict: DemandVerdict;
  /**
   * Contribution to the opportunity score (0–100). Deliberately small in V1:
   * zero when the verdict is `INSUFFICIENT_EVIDENCE`, because no demand points
   * are ever manufactured.
   */
  score: number;
  /** What was actually observed, in human-readable form. */
  evidence: string[];
  /** What could not be observed, and why it is not estimated. */
  limitations: string[];
  /**
   * Persistence of the listing across separated observations, or `null` when
   * there are too few observations to say anything.
   */
  listingPersistence: ListingPersistenceEvidence | null;
  /**
   * Supplier-side sourcing evidence. This is explicitly **not** demand: the
   * number of supplier candidates the matcher surfaced proves the product is
   * sourceable, and says nothing about how many end-customers buy it. It
   * contributes nothing to `score` and is carried only so the UI can state it
   * honestly under its own label.
   */
  sourcing: SourcingEvidence;
}

export interface ListingPersistenceEvidence {
  /** Distinct, sufficiently separated marketplace observations. */
  observations: number;
  /** Hours between the earliest and latest usable observation. */
  spanHours: number;
  /** Whether every usable observation reported the same price. */
  priceStable: boolean;
}

export interface SourcingEvidence {
  /** Supplier search queries the matcher generated for the listing. */
  queries: number;
  /** Distinct supplier candidates those queries surfaced. */
  candidateCount: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Competition
// ---------------------------------------------------------------------------

/**
 * Honest verdict on how much *competition* evidence exists, and what it
 * suggests. Competition metrics are always relative to the **search context**
 * that produced them: a result count for "wireless earbuds" and one for "Anker
 * Soundcore Life Q30" are not comparable numbers, so the query is carried with
 * the assessment and is part of the persisted record.
 *
 * - `INSUFFICIENT_EVIDENCE` — neither a result count nor usable seller/price
 *   structure could be observed.
 * - `APPEARS_LIMITED`       — the observable evidence suggests few competing
 *   listings and few distinct sellers in the sampled window.
 * - `APPEARS_MODERATE`      — a meaningful but not saturated field.
 * - `APPEARS_BROAD`         — the sampled window is crowded with listings,
 *   distinct sellers, and similarly priced offers.
 *
 * "Appears" is the operative word: every figure below comes from one sampled
 * page of one query, not from a census of the market.
 */
export type CompetitionVerdict =
  | "INSUFFICIENT_EVIDENCE"
  | "APPEARS_LIMITED"
  | "APPEARS_MODERATE"
  | "APPEARS_BROAD";

export interface CompetitionAssessment {
  verdict: CompetitionVerdict;
  /**
   * Competition intensity, 0–100, higher meaning *more* competition. This is
   * the raw component; its contribution to the opportunity score is the
   * inverse, because more competition is worse for a new entrant.
   */
  intensity: number;
  /** Contribution to the opportunity score (0–100), `100 - intensity`. */
  score: number;
  /** The search query that produced this evidence — without it the numbers are meaningless. */
  query: string;
  /** Provider-reported total result count for that query, or `null` when the provider gave none. */
  searchResultTotal: number | null;
  /** Listings in the sampled window that were actually inspected. */
  sampleSize: number;
  /** Distinct sellers among those listings whose seller identifier was observable. */
  distinctSellers: number;
  /** Listings in the sample priced within `SIMILAR_PRICE_BAND` of this listing. */
  similarlyPricedListings: number;
  /** Listings in the sample in NEW condition, when condition is observable. */
  newConditionListings: number;
  /** What the figures above can and cannot be used for. */
  caveats: string[];
}


// ---------------------------------------------------------------------------
// Match component
// ---------------------------------------------------------------------------

/**
 * The **match** component: how confident the Product Matcher is that the
 * marketplace listing and the supplier candidate are the same item.
 *
 * Identity comes *before* money in the assessment: if the match is wrong, the
 * profit figure computed against it belongs to a different product. That is why
 * a LOW-confidence match is a hard cap (`SCORE_CAPS.LOW_MATCH`) rather than a
 * mere point deduction.
 */
export interface MatchComponent {
  /** The matcher's deterministic confidence (0–100). */
  confidence: number;
  confidenceBand: ConfidenceBand;
  /** Contribution to the opportunity score (0–100). */
  score: number;
  /** The matcher's own human-readable verdict, carried verbatim. */
  explanation: string;
  /** Positive signals, most contributing first. */
  signals: MatchSignal[];
  /** Negative signals, most damaging first. */
  contradictions: MatchContradiction[];
  /**
   * Whether a `hard` contradiction capped the matcher's confidence. Surfaced
   * separately because it is a different kind of fact from a low score: the
   * matcher found *evidence against* the match, not merely a lack of evidence
   * for it.
   */
  cappedByHardContradiction: boolean;
  /** Stable supplier identity the match was made against. */
  supplierExternalId: string;
}

// ---------------------------------------------------------------------------
// Economics component
// ---------------------------------------------------------------------------

/**
 * The **economics** component: the quality of the money figures, derived from
 * the economics engine's own completeness verdict rather than from a second,
 * competing model of profitability (docs/ARCHITECTURE.md §10).
 *
 * The profit and margin figures themselves are *not* re-derived here — they are
 * the economics engine's, carried verbatim — so one number always has one
 * accountable source.
 */
export interface EconomicsComponent {
  completeness: EconomicsCompleteness;
  /**
   * Estimated profit as a decimal-string money value, or `null` when
   * `completeness === "UNAVAILABLE"`. May be negative: a stored loss is a real
   * result and is never clamped to zero.
   */
  estimatedProfit: string | null;
  /** Estimated margin in percent, or `null` when not computable. */
  marginPercent: number | null;
  /** What the supplier cost actually represents — definitive or reference. */
  supplierCostBasis: SupplierCostBasis | null;
  /** Contribution to the opportunity score (0–100). */
  score: number;
  /** Deterministic, human-readable reason this component received this value. */
  rationale: string;
  /** Economics warnings, carried verbatim so they reach the UI unchanged. */
  warnings: string[];
  /** Stated assumptions the figures depend on. */
  assumptions: string[];
  /** Version of the economics composition that produced the figures. */
  economicsEngineVersion: string;
  /** Version of the fee rules that were applied. */
  feeEngineVersion: string;
}

// ---------------------------------------------------------------------------
// History evidence
// ---------------------------------------------------------------------------

/**
 * One sufficiently separated price observation, used only as *evidence of
 * persistence*, never as a trend or a forecast.
 */
export interface PriceObservation {
  /** When Inkora observed this price (ISO 8601 UTC). */
  observedAt: string;
  /** Observed price in integer minor units, or `null` when the provider gave none. */
  priceCents: number | null;
}

/**
 * Bounded summary of a prior opportunity assessment for the same marketplace ×
 * supplier pair, so the current one can be shown *in context* rather than as a
 * standalone verdict.
 */
export interface PriorAssessmentSummary {
  score: number;
  band: OpportunityBand;
  confidence: number;
  engineVersion: string;
  calculatedAt: string;
}

/**
 * What Inkora has already observed about this listing, distilled from the
 * persisted observation tables (docs/DATABASE.md §6).
 *
 * The Opportunity Engine never reads the observation tables directly: the route
 * hands it this summary, which keeps the engine pure, deterministic, and
 * unit-testable with no database. Every field is bounded, and every figure is
 * explicitly an observation from a point in time — never a statement about the
 * present, and never an extrapolation into the future.
 */
export interface HistoryEvidenceSummary {
  /** Persisted marketplace snapshots available for the listing. */
  snapshotCount: number;
  /** Persisted matcher verdicts available. */
  matchObservationCount: number;
  /** Persisted economics calculations available. */
  economicsObservationCount: number;
  /** First time Inkora saw this listing, or `null` when never persisted. */
  firstSeenAt: string | null;
  /** Most recent time Inkora saw this listing, or `null` when never persisted. */
  lastSeenAt: string | null;
  /**
   * Price observations usable as evidence of persistence: deduplicated and
   * separated by at least `MIN_TREND_GAP_HOURS`, oldest first.
   */
  priceObservations: PriceObservation[];
  /** Prior assessments for the same pair, most recent first. */
  priorAssessments: PriorAssessmentSummary[];
}


// ---------------------------------------------------------------------------
// Engine input
// ---------------------------------------------------------------------------

/**
 * Hard bounds on the evidence the engine is allowed to consume. Declared in the
 * input — not read from configuration inside the engine — so a unit test pins
 * exactly how much history any assessment could have used
 * (docs/API_INTEGRATIONS.md §4).
 */
export interface OpportunityLimits {
  /** Maximum prior assessments considered for context. */
  maxPriorAssessments: number;
  /** Maximum price observations considered as persistence evidence. */
  maxPriceObservations: number;
  /** Maximum listings inspected from the competition sample window. */
  maxCompetitionSample: number;
}

/**
 * The competition evidence for one listing, taken from the *same* search window
 * the product scanner already fetched. Replaying it is deliberate: V1 spends
 * **zero additional eBay API calls** on competition evidence, which keeps the
 * engine inside the scanner's existing rate-limit budget
 * (docs/API_INTEGRATIONS.md §3).
 *
 * The query is mandatory: a result count without its query is not a comparable
 * number, so it is persisted as part of the assessment.
 */
export interface CompetitionEvidence {
  /** The marketplace query that produced this result window. */
  query: string;
  /** The window itself, already normalized. */
  searchResult: MarketplaceSearchResult;
}

/**
 * Everything the deterministic engine needs. Every input is a normalized,
 * provider-independent value or an explicit `null`: the engine never reaches
 * back out to a provider, a database, or the clock, which is what makes any
 * assessment reproducible from this object alone.
 */
export interface OpportunityInput {
  /** The marketplace listing being assessed. */
  marketplaceProduct: MarketplaceProduct;
  /**
   * The best matcher candidate for this listing, or `null` when the matcher
   * surfaced no candidate at all. `null` is a legitimate, fully explainable
   * input: it caps the assessment at `SCORE_CAPS.LOW_MATCH`.
   */
  candidate: MatchCandidate | null;
  /** Economics computed for that candidate, or `null` when they were not computed. */
  economics: EconomicsResult | null;
  /** Supplier queries the matcher generated for this listing (sourcing evidence). */
  supplierQueries: string[];
  /** Distinct supplier candidates those queries surfaced. */
  supplierCandidateCount: number;
  /** Competition evidence replayed from the scanner's own search window. */
  competition: CompetitionEvidence | null;
  /** Bounded persisted history for the listing, or `null` when none exists. */
  history: HistoryEvidenceSummary | null;
  /** ISO 8601 UTC timestamp the assessment is anchored to (freshness is measured against this). */
  now: string;
  limits: OpportunityLimits;
}

// ---------------------------------------------------------------------------
// The assessment
// ---------------------------------------------------------------------------

/**
 * A complete, self-explaining Opportunity Engine V1 assessment.
 *
 * Everything needed to understand, re-derive, and challenge the verdict is in
 * this object: the five components, every factor that moved the score, every
 * cap that was applied, the input provenance, and an explicit list of what the
 * assessment does *not* mean. It is persisted whole, so a historical assessment
 * remains fully auditable even after the engine moves on to a new version
 * (docs/DATABASE.md §7).
 */
export interface OpportunityAssessment {
  /** Logic version that produced this assessment. */
  engineVersion: string;
  /** ISO 8601 UTC timestamp of the assessment. */
  calculatedAt: string;

  // --- Identity of the opportunity --------------------------------------

  marketplace: MarketplaceId;
  marketplaceExternalId: string;
  supplier: SupplierId;
  supplierExternalId: string;

  // --- Attractiveness: what the score says -------------------------------

  /** Weighted score, 0–100, after every cap has been applied. */
  score: number;
  band: OpportunityBand;

  // --- Confidence: how much the evidence supports it ---------------------

  /** Evidence confidence, 0–100. Computed independently from `score`. */
  confidence: number;
  confidenceLevel: ConfidenceLevel;

  // --- The five components, each fully inspectable -----------------------

  components: {
    economics: EconomicsComponent;
    match: MatchComponent;
    competition: CompetitionAssessment;
    demand: DemandAssessment;
    dataQuality: DataQualityAssessment;
  };

  // --- Explainability ----------------------------------------------------

  /** Every deterministic reason the score moved, in the order it moved. */
  factors: OpportunityFactor[];
  /** Every hard cap applied, in the order applied. Empty when none applied. */
  caps: AppliedCap[];
  /** One deterministic headline sentence. */
  headline: string;
  /** Ordered, human-readable explanation the UI renders as-is. */
  explanation: string[];
  /** What this assessment does NOT mean. Always shown alongside the score. */
  caveats: string[];

  // --- Where the inputs came from ---------------------------------------

  /** Stable references to the inputs, so an assessment is traceable to evidence. */
  inputs: {
    marketplaceSnapshotObservedAt: string | null;
    supplierSnapshotObservedAt: string | null;
    economicsCalculatedAt: string | null;
    competitionQuery: string | null;
    historyAvailable: boolean;
  };
}
