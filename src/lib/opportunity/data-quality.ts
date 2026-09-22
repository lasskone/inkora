/**
 * The **data quality** component: how complete and how fresh the evidence
 * underlying the whole assessment is.
 *
 * This is the component that makes an assessment honest about itself. It
 * contributes modestly to the score (weight 0.10) and *dominates* the
 * confidence, which is the mathematically correct place for evidence quality to
 * be expressed: an assessment built from stale or partial inputs cannot be a
 * high-confidence assessment no matter how good the arithmetic looks
 * (docs/ARCHITECTURE.md §9.3).
 *
 * Every dimension is checked and reported *by name*, so the user sees which fact
 * is weak rather than merely that something is.
 *
 * Pure: identical inputs ⇒ identical output.
 */

import type {
  DataQualityAssessment,
  DataQualityDimension,
  EconomicsCompleteness,
  OpportunityInput,
} from "./types";
import { STALE_OBSERVATION_HOURS } from "./types";
import { ageHours } from "./history-evidence";

/**
 * Weight each dimension contributes when the fact is *present*. Missing facts
 * subtract the same magnitude they would add, so evidence quality is symmetric
 * around neutral rather than silently one-sided.
 */
const DIMENSION_WEIGHTS = {
  marketplacePrice: 20,
  marketplaceShipping: 15,
  supplierCost: 15,
  economicsComplete: 20,
  matchEvidence: 10,
  evidenceFreshness: 15,
  historyDepth: 5,
} as const;

/**
 * Builds the data-quality component. Every input state yields a complete,
 * explainable result, and the component score is always within `[0, 100]`.
 */
export function assessDataQuality(input: OpportunityInput): DataQualityAssessment {
  const dimensions: DataQualityDimension[] = [];

  const product = input.marketplaceProduct;
  const currency = product.currency === null ? "" : ` ${product.currency}`;
  dimensions.push(
    product.price !== null
      ? present(
          "marketplacePricePresent",
          "Marketplace price present",
          `The listing carries a sale price of ${product.price}${currency}.`,
          DIMENSION_WEIGHTS.marketplacePrice,
        )
      : absent(
          "marketplacePricePresent",
          "Marketplace price present",
          "The listing carries no sale price, so no revenue can be established.",
          DIMENSION_WEIGHTS.marketplacePrice,
        ),
  );

  dimensions.push(
    product.shippingCost !== null
      ? present(
          "marketplaceShippingKnown",
          "Marketplace shipping known",
          `eBay returned a priced shipping option of ${product.shippingCost}, so the fee basis includes buyer-paid shipping.`,
          DIMENSION_WEIGHTS.marketplaceShipping,
        )
      : absent(
          "marketplaceShippingKnown",
          "Marketplace shipping known",
          "eBay returned no priced shipping option, so buyer-paid shipping is treated as $0.00 and margin is computed on the item price alone.",
          DIMENSION_WEIGHTS.marketplaceShipping,
        ),
  );

  const supplierCost = input.economics?.supplierProductCost ?? null;
  dimensions.push(
    supplierCost !== null
      ? present(
          "supplierCostKnown",
          "Supplier cost known",
          `The supplier cost was resolved at ${supplierCost}.`,
          DIMENSION_WEIGHTS.supplierCost,
        )
      : absent(
          "supplierCostKnown",
          "Supplier cost known",
          "No supplier cost could be resolved, so the money side of this assessment rests on nothing.",
          DIMENSION_WEIGHTS.supplierCost,
        ),
  );

  dimensions.push(economicsDimension(input.economics?.completeness ?? null));
  dimensions.push(matchDimension(input));
  dimensions.push(freshnessDimension(input));
  dimensions.push(historyDimension(input));

  const score = clamp(
    dimensions.reduce((total, dimension) => total + dimension.contribution, 0),
  );

  return {
    score,
    dimensions,
    evidence: dimensions
      .filter((dimension) => dimension.contribution > 0)
      .map((dimension) => dimension.detail),
    limitations: dimensions
      .filter((dimension) => dimension.contribution <= 0)
      .map((dimension) => dimension.detail),
  };
}

/** A dimension whose fact was found; it contributes its full weight. */
function present(
  name: string,
  label: string,
  detail: string,
  weight: number,
): DataQualityDimension {
  return { name, label, detail, contribution: weight };
}

/** A dimension whose fact was missing or unusable; it subtracts the same weight. */
function absent(
  name: string,
  label: string,
  detail: string,
  weight: number,
): DataQualityDimension {
  return { name, label, detail, contribution: -weight };
}

/** Completeness of the economics result, the largest single quality lever. */
function economicsDimension(
  completeness: EconomicsCompleteness | null,
): DataQualityDimension {
  if (completeness === "COMPLETE") {
    return present(
      "economicsComplete",
      "Economics complete",
      "Every component actionable profit requires is present and definitive, so the profit figure is defensible.",
      DIMENSION_WEIGHTS.economicsComplete,
    );
  }
  if (completeness === "PARTIAL") {
    return {
      name: "economicsComplete",
      label: "Economics complete",
      detail:
        "Profit is computable but rests on a non-definitive input, so the figure is a reference rather than a settled result.",
      contribution: 0,
    };
  }
  return absent(
    "economicsComplete",
    "Economics complete",
    completeness === null
      ? "Economics were not computed for this candidate, so there is no profit figure to assess."
      : "A component actionable profit requires is missing, so no profit figure exists at all.",
    DIMENSION_WEIGHTS.economicsComplete,
  );
}

/** Whether the matcher produced a candidate, and whether it found evidence against one. */
function matchDimension(input: OpportunityInput): DataQualityDimension {
  const candidate = input.candidate;
  if (candidate === null) {
    return absent(
      "matchEvidence",
      "Match evidence",
      "The matcher surfaced no supplier candidate for this listing, so which product would be sourced is unknown.",
      DIMENSION_WEIGHTS.matchEvidence,
    );
  }
  const hard = candidate.contradictions.some(
    (contradiction) => contradiction.severity === "hard",
  );
  if (hard) {
    return absent(
      "matchEvidence",
      "Match evidence",
      "The matcher found hard evidence against this match, so the candidate's identity is actively contradicted rather than merely unproven.",
      DIMENSION_WEIGHTS.matchEvidence,
    );
  }
  return present(
    "matchEvidence",
    "Match evidence",
    `The matcher surfaced a candidate at ${candidate.confidence}/100 confidence with no hard contradiction.`,
    DIMENSION_WEIGHTS.matchEvidence,
  );
}

/** Freshness of the marketplace snapshot the assessment is built on. */
function freshnessDimension(input: OpportunityInput): DataQualityDimension {
  const age = ageHours(input.marketplaceProduct.fetchedAt, input.now);
  if (age <= STALE_OBSERVATION_HOURS) {
    return present(
      "evidenceFresh",
      "Evidence fresh",
      `The marketplace snapshot is ${Math.round(age * 10) / 10} hours old, within the ${STALE_OBSERVATION_HOURS}-hour freshness window.`,
      DIMENSION_WEIGHTS.evidenceFreshness,
    );
  }
  return absent(
    "evidenceFresh",
    "Evidence fresh",
    `The marketplace snapshot is ${Math.round(age * 10) / 10} hours old, older than the ${STALE_OBSERVATION_HOURS}-hour freshness window, so it describes the recent past rather than the listing's current state.`,
    DIMENSION_WEIGHTS.evidenceFreshness,
  );
}

/**
 * How much persisted history backs the assessment. No history is the *normal*
 * first-evaluation state, so it is neutral — never a penalty — and depth simply
 * adds credit.
 */
function historyDimension(input: OpportunityInput): DataQualityDimension {
  const snapshots = input.history?.snapshotCount ?? 0;
  if (snapshots >= 2) {
    return present(
      "historyDepth",
      "History depth",
      `${snapshots} persisted marketplace observations exist for this listing, so persistence could actually be evaluated.`,
      DIMENSION_WEIGHTS.historyDepth,
    );
  }
  return {
    name: "historyDepth",
    label: "History depth",
    detail:
      snapshots === 1
        ? "Only one persisted marketplace observation exists, which is a single fact about one moment and supports nothing about persistence."
        : "This is a first assessment: no persisted history exists yet, so persistence could not be evaluated. This is expected on a first run, not a defect.",
    contribution: 0,
  };
}

/** Clamps a data-quality total to the 0–100 component scale. */
function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

