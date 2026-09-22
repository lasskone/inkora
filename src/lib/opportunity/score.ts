/**
 * Component scoring, weighted aggregation, gates, and evidence confidence.
 *
 * Everything here implements the model declared once in `types.ts`: the five
 * component weights, the band-derived caps, and the deliberately separate
 * confidence formula (docs/ARCHITECTURE.md §9.4–§9.6).
 *
 * ## Score versus confidence
 *
 * The **score** answers "if this opportunity is real, how good is it?" The
 * **confidence** answers "how much of that is actually known?" They are
 * different formulas over the same evidence and are reported side by side,
 * because a high calculated margin over weak evidence must never look
 * equivalent to the same margin over strong evidence.
 *
 * ## Gates
 *
 * A gate is a hard cap on the score, expressed against a band threshold so it
 * reads as "this opportunity cannot enter the HIGH band" rather than as an
 * arbitrary penalty. Identity gates before money: a profitable match to the
 * *wrong* product is worthless.
 *
 * Pure: identical inputs ⇒ identical output, and every intermediate value is
 * returned so the caller can explain the arithmetic exactly.
 */

import type {
  AppliedCap,
  ComponentName,
  ConfidenceLevel,
  EconomicsComponent,
  MatchComponent,
  OpportunityInput,
} from "./types";
import {
  CONFIDENCE_SLACK,
  CONFIDENCE_WEIGHTS,
  COMPONENT_WEIGHTS,
  DEMAND_CONFIDENCE_FACTORS,
  ECONOMICS_CONFIDENCE_PROXY,
  MARGIN_SATURATION_PERCENT,
  NO_MATCH_CONFIDENCE_PROXY,
  PARTIAL_ECONOMICS_FACTOR,
  REFERENCE_COST_FACTOR,
  SCALE_MAX,
  SCORE_CAPS,
  confidenceLevelFor,
} from "./types";
import type { DemandVerdict } from "./types";
import type { DataQualityAssessment } from "./types";
import { parseDecimalToCents } from "@/lib/economics/money";

/** The five component scores, on the 0–100 scale, before weighting. */
export type ComponentScores = Record<ComponentName, number>;

/** Every intermediate value of the confidence computation, for explanation. */
export interface ConfidenceBreakdown {
  confidence: number;
  level: ConfidenceLevel;
  /** Weighted blend of the three evidence proxies. */
  weightedBlend: number;
  /** The weakest hard evidence dimension. */
  weakestEvidence: number;
  /** The blend as limited by `CONFIDENCE_SLACK` above the weakest dimension. */
  slackLimited: number;
  /** The demand-verdict multiplier that was applied. */
  demandFactor: number;
}

/**
 * Builds the match component. A `null` candidate is a legitimate, fully
 * explainable input: it yields zero and is gated separately, so the assessment
 * says "no candidate was found" rather than silently scoring an absent match.
 */
export function assessMatchComponent(input: OpportunityInput): MatchComponent {
  const candidate = input.candidate;
  if (candidate === null) {
    return {
      confidence: 0,
      confidenceBand: "LOW",
      score: 0,
      explanation:
        "The matcher surfaced no supplier candidate for this listing, so no product identity could be established.",
      signals: [],
      contradictions: [],
      cappedByHardContradiction: false,
      supplierExternalId: "",
    };
  }

  const hard = candidate.contradictions.find(
    (contradiction) => contradiction.severity === "hard",
  );

  return {
    confidence: candidate.confidence,
    confidenceBand: candidate.confidenceBand,
    score: candidate.confidence,
    explanation: candidate.explanation,
    signals: [...candidate.signals].sort((a, b) => b.contribution - a.contribution),
    contradictions: [...candidate.contradictions].sort(
      (a, b) => (b.severity === "hard" ? 1 : 0) - (a.severity === "hard" ? 1 : 0),
    ),
    cappedByHardContradiction: hard !== undefined,
    supplierExternalId: candidate.supplierProduct.externalId,
  };
}

/**
 * Parses the economics engine's margin string into a plain percent number.
 *
 * The economics layer stores margin as a decimal string of *percent cents*
 * (`"12.34"` = 12.34%), so it parses to percent-cents and is divided by 100
 * here. Margin is never re-derived from prices — the economics engine owns that
 * figure, and it is carried verbatim.
 */
function marginAsPercent(marginPercent: string | null): number | null {
  const percentCents = parseDecimalToCents(marginPercent);
  if (percentCents === null) return null;
  return percentCents / 100;
}

/**
 * Builds the economics component: the quality of the money figures.
 *
 * The component never re-derives profit or margin. It *reads* the economics
 * engine's verdict (`COMPLETE` / `PARTIAL` / `UNAVAILABLE`) and scales the
 * margin into the 0–100 component scale, discounting it when the figure rests
 * on a non-definitive input.
 */
export function assessEconomicsComponent(input: OpportunityInput): EconomicsComponent {
  const economics = input.economics;

  if (economics === null || economics.completeness === "UNAVAILABLE") {
    return {
      completeness: economics?.completeness ?? "UNAVAILABLE",
      estimatedProfit: null,
      marginPercent: null,
      supplierCostBasis: economics?.supplierCostBasis ?? null,
      score: 0,
      rationale:
        economics === null
          ? "Economics were not computed for this candidate, so the component contributes nothing."
          : "A component actionable profit requires is missing, so no profit figure exists and the component contributes nothing.",
      warnings: economics?.warnings ?? [],
      assumptions: economics?.assumptions ?? [],
      economicsEngineVersion: economics?.economicsEngineVersion ?? "",
      feeEngineVersion: economics?.feeEngineVersion ?? "",
    };
  }

  const profitCents = parseDecimalToCents(economics.estimatedProfit);
  const margin = marginAsPercent(economics.marginPercent);
  const basis = economics.supplierCostBasis;

  // A loss is a loss: the component contributes nothing, whether or not the
  // inputs that produced it were definitive.
  if (profitCents !== null && profitCents < 0) {
    return {
      completeness: economics.completeness,
      estimatedProfit: economics.estimatedProfit,
      marginPercent: margin,
      supplierCostBasis: basis,
      score: 0,
      rationale: `Estimated profit is ${economics.estimatedProfit}, which is negative, so the economics component contributes nothing.`,
      warnings: economics.warnings,
      assumptions: economics.assumptions,
      economicsEngineVersion: economics.economicsEngineVersion,
      feeEngineVersion: economics.feeEngineVersion,
    };
  }

  const saturated =
    margin === null
      ? 0
      : Math.max(0, Math.min(100, (margin / MARGIN_SATURATION_PERCENT) * 100));

  // Non-definitive inputs discount the figure rather than discarding it: a
  // reference cost is still evidence, just weaker evidence.
  const factors: number[] = [];
  if (economics.completeness === "PARTIAL") factors.push(PARTIAL_ECONOMICS_FACTOR);
  if (basis !== "SELECTED_VARIANT") factors.push(REFERENCE_COST_FACTOR);

  const score = Math.round(factors.reduce((acc, factor) => acc * factor, saturated));

  const rationale = buildEconomicsRationale(economics.completeness, basis, margin, score);

  return {
    completeness: economics.completeness,
    estimatedProfit: economics.estimatedProfit,
    marginPercent: margin,
    supplierCostBasis: basis,
    score,
    rationale,
    warnings: economics.warnings,
    assumptions: economics.assumptions,
    economicsEngineVersion: economics.economicsEngineVersion,
    feeEngineVersion: economics.feeEngineVersion,
  };
}

/** Deterministic, human-readable reason the economics component received its value. */
function buildEconomicsRationale(
  completeness: "COMPLETE" | "PARTIAL",
  basis: import("./types").SupplierCostBasis | null,
  margin: number | null,
  score: number,
): string {
  const parts: string[] = [];
  parts.push(
    margin === null
      ? "No margin could be computed, so the component scores zero."
      : `Margin is ${margin}% of revenue, scaled against the ${MARGIN_SATURATION_PERCENT}% saturation point.`,
  );
  if (completeness === "PARTIAL") {
    parts.push(
      `Economics are PARTIAL, so the figure is discounted to ${Math.round(PARTIAL_ECONOMICS_FACTOR * 100)}% of the scaled margin.`,
    );
  }
  if (basis !== "SELECTED_VARIANT") {
    parts.push(
      `Supplier cost is a ${basis === "CATALOG_MINIMUM" ? "catalogue minimum" : "variant reference"} rather than a resolved variant's cost, so it is further discounted to ${Math.round(REFERENCE_COST_FACTOR * 100)}%.`,
    );
  }
  parts.push(`Component score: ${score}/100.`);
  return parts.join(" ");
}

/**
 * The conservative gates. Each returns an `AppliedCap` describing a condition
 * the assessment cannot recover from, with the cap expressed against a band
 * threshold so it reads as "cannot enter band X".
 *
 * Order matters only for the explanation: every gate that fires is reported,
 * and the effective cap is the minimum of them all.
 */
export function evaluateGates(input: OpportunityInput): AppliedCap[] {
  const caps: AppliedCap[] = [];
  const candidate = input.candidate;
  const economics = input.economics;

  if (candidate === null) {
    caps.push({
      name: "noCandidateGate",
      label: "No supplier candidate",
      cap: SCORE_CAPS.LOW_MATCH,
      reason:
        "The matcher surfaced no candidate, so no product identity could be established. The assessment cannot be rated above LOW regardless of any other evidence.",
    });
  } else if (candidate.confidenceBand === "LOW") {
    caps.push({
      name: "lowMatchGate",
      label: "Low-confidence match",
      cap: SCORE_CAPS.LOW_MATCH,
      reason:
        "The matcher's confidence is LOW, so the profit figure may belong to a different product. The assessment cannot be rated above LOW.",
    });
  }

  if (economics === null || economics.completeness === "UNAVAILABLE") {
    caps.push({
      name: "unavailableEconomicsGate",
      label: "Economics unavailable",
      cap: SCORE_CAPS.UNAVAILABLE_ECONOMICS,
      reason:
        "A component actionable profit requires is missing, so there is no profit figure to be attractive with. The assessment cannot be rated above LOW.",
    });
  } else if (economics.completeness === "PARTIAL") {
    caps.push({
      name: "partialEconomicsGate",
      label: "Incomplete economics",
      cap: SCORE_CAPS.PARTIAL_ECONOMICS,
      reason:
        "The profit figure rests on a non-definitive input, so it is worth investigating but not worth a HIGH rating.",
    });
  }

  const profitCents =
    economics === null ? null : parseDecimalToCents(economics.estimatedProfit);
  if (
    economics !== null &&
    economics.completeness === "COMPLETE" &&
    profitCents !== null &&
    profitCents < 0
  ) {
    caps.push({
      name: "negativeCompleteProfitGate",
      label: "Confirmed loss",
      cap: SCORE_CAPS.NEGATIVE_COMPLETE_PROFIT,
      reason:
        "Complete, definitive economics show a loss on this opportunity. A confirmed loss is not an opportunity, so the assessment cannot be rated above LOW.",
    });
  }

  return caps;
}

/**
 * The weighted contribution each component makes to the score.
 *
 * Each contribution is individually rounded to an integer, and the raw score is
 * the sum of those integers. That keeps the explanation arithmetic exact: the
 * component factors plus the cap factor always sum to the reported score.
 */
export interface ComponentContribution {
  name: ComponentName;
  /** Weighted, rounded contribution to the raw score (may be 0, never negative). */
  contribution: number;
}

/** Computes the weighted contributions of all five components. */
export function componentContributions(
  components: ComponentScores,
): ComponentContribution[] {
  return (Object.keys(COMPONENT_WEIGHTS) as ComponentName[]).map((name) => ({
    name,
    contribution: Math.max(0, Math.round(COMPONENT_WEIGHTS[name] * components[name])),
  }));
}

/**
 * Combines the five components into the raw score.
 *
 * Deliberately simple — a weighted sum — because the model's judgement lives in
 * the components and the gates, not in a clever aggregation. Any change to these
 * weights requires a new engine version.
 */
export function aggregateScore(components: ComponentScores): number {
  const weighted = componentContributions(components).reduce(
    (total, contribution) => total + contribution.contribution,
    0,
  );
  return Math.max(0, Math.min(SCALE_MAX, weighted));
}

/**
 * Evidence confidence: how much the available evidence supports the assessment.
 *
 * Competition and demand are deliberately absent from this formula. Confidence
 * measures the *evidence*, not the desirability: a highly contested market with
 * no demand history can still be well evidenced. Demand enters through its
 * verdict multiplier instead, because absent demand evidence genuinely makes an
 * assessment less trustworthy — while saying nothing about how contested the
 * market is.
 */
export function computeConfidence(input: {
  economicsCompleteness: EconomicsComponent["completeness"];
  matchConfidence: number;
  dataQuality: DataQualityAssessment;
  demandVerdict: DemandVerdict;
}): ConfidenceBreakdown {
  const economicsProxy =
    input.economicsCompleteness === "UNAVAILABLE"
      ? ECONOMICS_CONFIDENCE_PROXY.UNAVAILABLE
      : ECONOMICS_CONFIDENCE_PROXY[input.economicsCompleteness];
  const matchProxy = input.matchConfidence <= 0 ? NO_MATCH_CONFIDENCE_PROXY : input.matchConfidence;
  const dataQualityProxy = input.dataQuality.score;

  const weightedBlend = Math.round(
    economicsProxy * CONFIDENCE_WEIGHTS.economics +
      matchProxy * CONFIDENCE_WEIGHTS.match +
      dataQualityProxy * CONFIDENCE_WEIGHTS.dataQuality,
  );
  const weakestEvidence = Math.min(economicsProxy, matchProxy, dataQualityProxy);
  const slackLimited = Math.min(weightedBlend, weakestEvidence + CONFIDENCE_SLACK);
  const demandFactor = DEMAND_CONFIDENCE_FACTORS[input.demandVerdict];
  const confidence = Math.max(
    0,
    Math.min(SCALE_MAX, Math.round(slackLimited * demandFactor)),
  );

  return {
    confidence,
    level: confidenceLevelFor(confidence),
    weightedBlend,
    weakestEvidence,
    slackLimited: Math.round(slackLimited),
    demandFactor,
  };
}

