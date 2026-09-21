/**
 * Deterministic, explainable candidate scoring.
 *
 * Given one normalized `MarketplaceProduct` and one normalized
 * `SupplierProduct`, this module produces a confidence on a stable 0–100 scale
 * together with the exact signals and contradictions that produced it. Same
 * inputs always yield the same outputs — no randomness, no LLM, no network.
 *
 * Design constraints (see docs/ARCHITECTURE.md §8):
 *
 * - **Conservative.** Precision beats recall. Generic keyword overlap can never
 *   reach MEDIUM or HIGH on its own; strong contradictions impose hard ceilings.
 * - **Price is never identity evidence.** Marketplace price and supplier cost
 *   serve different purposes and are deliberately ignored here.
 * - **No invented attributes.** A signal only fires on features actually
 *   extracted from the two titles; absent features simply do not fire.
 * - **Explainable.** The numeric score is meaningless without its signals, so
 *   both are always returned together.
 */

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { SupplierProduct } from "@/lib/supplier/types";
import type {
  ConfidenceBand,
  MatchContradiction,
  MatchSignal,
} from "./types";
import {
  extractProductTextFeatures,
  type ProductTextFeatures,
  type UnitValue,
} from "./text";

// --- Confidence scale and bands --------------------------------------------

/** A V1 match is at best a strong candidate — never `EXACT` or `GUARANTEED`. */
export const CONFIDENCE_MAX = 100;

/** Minimum shared meaningful tokens before a match may be rated above LOW. */
export const MIN_STRONG_OVERLAP = 3;

/** Confidence ceilings imposed by hard contradictions. */
export const CAP_GENERIC_OVERLAP = 30;
export const CAP_MODEL_CONFLICT = 25;
export const CAP_UNIT_CONFLICT = 30;
export const CAP_BRAND_CONFLICT = 20;

/** Band thresholds on the 0–100 scale. */
export const HIGH_BAND_THRESHOLD = 70;
export const MEDIUM_BAND_THRESHOLD = 45;

/**
 * Maps a confidence to its band. Documented and stable: HIGH ≥ 70,
 * MEDIUM 45–69, LOW < 45. No candidate is ever labelled exact.
 */
export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= HIGH_BAND_THRESHOLD) return "HIGH";
  if (confidence >= MEDIUM_BAND_THRESHOLD) return "MEDIUM";
  return "LOW";
}

// --- Signal weights ---------------------------------------------------------

const WEIGHT_TOKEN_SIMILARITY = 60;
const WEIGHT_DISTINCTIVE_AGREEMENT = 30;
const WEIGHT_UNIT_AGREEMENT = 15;
const WEIGHT_QUANTITY_AGREEMENT = 10;
const WEIGHT_BRAND_AGREEMENT = 8;
const PENALTY_QUANTITY_CONFLICT = 12;

/** The pure scoring result, before it is wrapped in a `MatchCandidate`. */
export interface ScoreResult {
  confidence: number;
  confidenceBand: ConfidenceBand;
  signals: MatchSignal[];
  contradictions: MatchContradiction[];
  explanation: string;
}

/**
 * Scores one marketplace product against one supplier candidate.
 *
 * Everything the function needs comes from the two titles, so missing optional
 * fields (no sku, no image, no category) simply mean the corresponding signal
 * does not fire — they never cause a failure or a guess.
 */
export function scoreCandidate(
  marketplaceProduct: MarketplaceProduct,
  supplierProduct: SupplierProduct,
): ScoreResult {
  const market = extractProductTextFeatures(marketplaceProduct.title);
  const supplier = extractProductTextFeatures(supplierProduct.title);

  const sharedTokens = intersection(market.tokens, supplier.tokens);
  const unionTokens = union(market.tokens, supplier.tokens);

  const signals: MatchSignal[] = [];
  const contradictions: MatchContradiction[] = [];

  // --- A. Token similarity (Jaccard over meaningful tokens) -----------------
  const jaccard =
    unionTokens.size === 0 ? 0 : sharedTokens.size / unionTokens.size;

  if (sharedTokens.size > 0) {
    signals.push({
      name: "tokenSimilarity",
      label: "Title token similarity",
      contribution: Math.round(WEIGHT_TOKEN_SIMILARITY * jaccard),
      detail: `${sharedTokens.size} of ${unionTokens.size} meaningful title tokens shared (Jaccard ${jaccard.toFixed(2)}).`,
    });
  }

  // --- B. Distinctive-token agreement ---------------------------------------
  const sharedIdentifiers = intersection(
    market.identifiers,
    supplier.identifiers,
  );
  const identifierBase = Math.min(
    market.identifiers.length,
    supplier.identifiers.length,
  );

  if (identifierBase > 0 && sharedIdentifiers.size > 0) {
    // Weight each shared identifier by its specificity: a short token such as
    // `q30` is ambiguous and collides with unrelated products, while a long
    // model number such as `wh1000xm5` is near-unique evidence.
    const contribution = Math.min(
      WEIGHT_DISTINCTIVE_AGREEMENT,
      [...sharedIdentifiers].reduce(
        (sum, identifier) => sum + identifierWeight(identifier),
        0,
      ),
    );
    signals.push({
      name: "distinctiveTokenAgreement",
      label: "Distinctive token agreement",
      contribution,
      detail:
        `Shares ${sharedIdentifiers.size} of ${identifierBase} high-information identifier(s)` +
        ` (${[...sharedIdentifiers].slice(0, 4).join(", ") || "none"}).`,
    });
  }


  // --- C. Numeric / unit agreement ------------------------------------------
  const sharedUnits = sharedUnitValues(market.units, supplier.units);
  if (sharedUnits.length > 0) {
    const agreement =
      sharedUnits.length / Math.min(market.units.length, supplier.units.length);
    signals.push({
      name: "unitAgreement",
      label: "Specification agreement",
      contribution: Math.round(WEIGHT_UNIT_AGREEMENT * agreement),
      detail: `Matching specification values: ${sharedUnits.map((unit) => unit.raw).join(", ")}.`,
    });
  }

  // --- D. Quantity / count agreement ----------------------------------------
  const sharedQuantity = sharedQuantityValue(
    market.quantities,
    supplier.quantities,
  );
  if (sharedQuantity !== null) {
    signals.push({
      name: "quantityAgreement",
      label: "Quantity / count agreement",
      contribution: WEIGHT_QUANTITY_AGREEMENT,
      detail: `Both titles describe a pack/count of ${sharedQuantity}.`,
    });
  } else if (market.quantities.length > 0 && supplier.quantities.length > 0) {
    contradictions.push({
      name: "quantityConflict",
      label: "Quantity / count conflict",
      severity: "soft",
      cap: 0,
      detail: `Marketplace title implies a pack/count of ${market.quantities.join(", ")}; supplier title implies ${supplier.quantities.join(", ")}.`,
    });
  }

  // --- E. Brand agreement ----------------------------------------------------
  if (market.brand !== null && supplier.brand !== null) {
    if (market.brand === supplier.brand) {
      signals.push({
        name: "brandAgreement",
        label: "Brand agreement",
        contribution: WEIGHT_BRAND_AGREEMENT,
        detail: `Both titles name the same brand: ${market.brand}.`,
      });
    } else {
      contradictions.push({
        name: "brandConflict",
        label: "Brand conflict",
        severity: "hard",
        cap: CAP_BRAND_CONFLICT,
        detail: `Marketplace title names brand "${market.brand}"; supplier title names "${supplier.brand}".`,
      });
    }
  }

  // --- Contradictions --------------------------------------------------------
  // Model-number disagreement is the most serious identity conflict: both
  // titles carry identifiers and none of them is shared.
  if (identifierBase > 0 && sharedIdentifiers.size === 0) {
    contradictions.push({
      name: "modelConflict",
      label: "Model / identifier conflict",
      severity: "hard",
      cap: CAP_MODEL_CONFLICT,
      detail:
        `Marketplace identifiers (${market.identifiers.slice(0, 3).join(", ") || "none"})` +
        ` share none with the supplier's (${supplier.identifiers.slice(0, 3).join(", ") || "none"}).`,
    });
  }

  const conflictingUnits = conflictingUnitValues(market.units, supplier.units);
  if (conflictingUnits.length > 0) {
    contradictions.push({
      name: "unitConflict",
      label: "Specification conflict",
      severity: "hard",
      cap: CAP_UNIT_CONFLICT,
      detail: conflictingUnits
        .map(
          (entry) =>
            `marketplace ${entry.market.raw} vs supplier ${entry.supplier.raw}`,
        )
        .join("; "),
    });
  }


  // --- Confidence assembly ---------------------------------------------------
  const positive = signals.reduce(
    (sum, signal) => sum + signal.contribution,
    0,
  );
  let confidence = Math.min(positive, CONFIDENCE_MAX);

  // Hard contradictions impose ceilings; the most damaging one wins.
  for (const contradiction of contradictions) {
    if (contradiction.severity === "hard") {
      confidence = Math.min(confidence, contradiction.cap);
    }
  }

  // Generic overlap alone must never climb above LOW.
  if (sharedTokens.size < MIN_STRONG_OVERLAP) {
    confidence = Math.min(confidence, CAP_GENERIC_OVERLAP);
  }

  // Soft contradictions subtract points.
  const softPenalty = contradictions
    .filter((contradiction) => contradiction.severity === "soft")
    .reduce((sum) => sum + PENALTY_QUANTITY_CONFLICT, 0);
  confidence = Math.max(0, confidence - softPenalty);

  const rounded = Math.round(confidence);
  const band = confidenceBand(rounded);

  return {
    confidence: rounded,
    confidenceBand: band,
    signals: [...signals].sort(
      (left, right) => right.contribution - left.contribution,
    ),
    contradictions: [...contradictions].sort(
      (left, right) => rankSeverity(left) - rankSeverity(right),
    ),
    explanation: buildExplanation(rounded, band, signals, contradictions),
  };
}

function rankSeverity(contradiction: MatchContradiction): number {
  return contradiction.severity === "hard" ? 0 : 1;
}

/**
 * Deterministic, human-readable summary: band first, then the strongest signals
 * and the contradictions, so a human reviewer can immediately see *why*.
 */
function buildExplanation(
  confidence: number,
  band: ConfidenceBand,
  signals: MatchSignal[],
  contradictions: MatchContradiction[],
): string {
  const parts: string[] = [`${confidence}/100 (${band} confidence)`];

  const hard = contradictions.filter((entry) => entry.severity === "hard");
  if (hard.length > 0) {
    parts.push(
      `capped by ${hard
        .map((entry) => entry.label.toLowerCase())
        .join(" and ")}`,
    );
  }

  const topSignals = [...signals]
    .sort((left, right) => right.contribution - left.contribution)
    .slice(0, 2);
  if (topSignals.length > 0) {
    parts.push(topSignals.map((signal) => sentence(signal.detail)).join("; "));
  }

  if (contradictions.length > 0) {
    parts.push(
      `concerns: ${contradictions
        .map((entry) => sentence(entry.detail))
        .join("; ")}`,
    );
  } else if (topSignals.length === 0) {
    parts.push("no meaningful title-token overlap; treated as unrelated");
  }

  return `${parts.map(sentence).join(" — ")}.`;
}

/** Ensures one trailing full stop and no doubling when fragments are joined. */
function sentence(fragment: string): string {
  return fragment.trim().replace(/[.\s]+$/, "");
}

// --- Comparison helpers ------------------------------------------------------

/**
 * Evidence weight of one shared identifier, by length. Short alphanumeric
 * tokens (`q30`) are ambiguous and collide with unrelated products; long model
 * numbers (`wh1000xm5`) are near-unique. Tiers keep the model understandable
 * rather than a continuous formula.
 */
function identifierWeight(identifier: string): number {
  const length = identifier.length;
  if (length >= 7) return 15;
  if (length >= 5) return 12;
  if (length === 4) return 8;
  return 5;
}

function intersection(left: string[], right: string[]): Set<string> {
  const rightSet = new Set(right);
  return new Set(left.filter((token) => rightSet.has(token)));
}

function union(left: string[], right: string[]): Set<string> {
  return new Set([...left, ...right]);
}

/** Two unit values agree when the unit and the value both match. */
function sharedUnitValues(left: UnitValue[], right: UnitValue[]): UnitValue[] {
  return left.filter((entry) =>
    right.some(
      (other) => other.unit === entry.unit && other.value === entry.value,
    ),
  );
}

/** Same unit, materially different value. Tolerates rounding noise only. */
function conflictingUnitValues(
  left: UnitValue[],
  right: UnitValue[],
): Array<{ market: UnitValue; supplier: UnitValue }> {
  const conflicts: Array<{ market: UnitValue; supplier: UnitValue }> = [];

  for (const market of left) {
    for (const supplier of right) {
      if (supplier.unit !== market.unit) continue;
      if (Math.abs(supplier.value - market.value) < 0.01) continue;
      conflicts.push({ market, supplier });
    }
  }

  return conflicts;
}

function sharedQuantityValue(left: number[], right: number[]): number | null {
  for (const value of left) {
    if (right.includes(value)) return value;
  }
  return null;
}

export type { ProductTextFeatures };
