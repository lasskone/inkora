/**
 * Previous-vs-current comparison for a manual re-evaluation
 * (docs/ARCHITECTURE.md §16.8).
 *
 * Pure by design — no `server-only`, no I/O — so every rule below is pinned by a
 * unit test without a database or a network:
 *
 *   - **Numeric** fields use `delta = current - previous`. Money is compared in
 *     integer minor units and rendered back through the project's money
 *     formatter, so no binary float ever touches a financial figure
 *     (docs/DATABASE.md §8).
 *   - **Categorical** fields are shown as `previous → current`.
 *   - A delta is produced **only** when both sides are present. A missing value
 *     is never coerced to zero and never silently omitted as "no change" — it is
 *     reported as unknown.
 *
 * Terminology is deliberate and enforced by the names used here: this is a
 * *change since the previous evaluation*, never a trend, growth or momentum.
 * Two observations cannot establish a direction of travel.
 */

import { formatCents, parseDecimalToCents } from "@/lib/economics/money";
import type { EconomicsResult } from "@/lib/economics/types";
import type { OpportunityAssessment } from "@/lib/opportunity/types";

import type {
  AssessmentComparison,
  CategoricalChange,
  ComparisonMoney,
  ComparisonSide,
  NumericDelta,
  PreviousObservation,
} from "./types";

/** Renders a percent number the way the economics layer renders margins. */
function formatPercent(value: number): string {
  return value.toFixed(2);
}

/** Renders an integer count (score points, confidence points). */
function formatPoints(value: number): string {
  return String(Math.round(value));
}

/**
 * Normalizes a freshly computed assessment (and the economics it was built on)
 * into the comparison side. The economics layer owns money; the assessment owns
 * score, confidence and verdicts.
 */
export function currentSide(
  assessment: OpportunityAssessment,
  economics: EconomicsResult | null,
): ComparisonSide {
  return {
    score: assessment.score,
    band: assessment.band,
    confidence: assessment.confidence,
    confidenceLevel: assessment.confidenceLevel,
    matchConfidence: assessment.components.match.confidence,
    economicsCompleteness: assessment.components.economics.completeness,
    money: {
      marketplacePriceCents: economics === null ? null : parseDecimalToCents(economics.itemPrice),
      supplierCostCents: economics === null ? null : parseDecimalToCents(economics.supplierProductCost),
      supplierShippingCents: economics === null ? null : parseDecimalToCents(economics.supplierShippingCost),
      landedCostCents: economics === null ? null : parseDecimalToCents(economics.landedSupplierCost),
      estimatedProfitCents:
        assessment.components.economics.estimatedProfit === null
          ? null
          : parseDecimalToCents(assessment.components.economics.estimatedProfit),
      marginPercent: assessment.components.economics.marginPercent,
    },
  };
}

/** Normalizes the stored previous observation into the comparison side. */
export function previousSide(previous: PreviousObservation): ComparisonSide {
  const assessment = previous.assessment;
  return {
    score: assessment.score,
    band: assessment.band,
    confidence: assessment.confidence,
    confidenceLevel: assessment.confidenceLevel,
    matchConfidence: assessment.components.match.confidence,
    economicsCompleteness: assessment.components.economics.completeness,
    money: previous.money,
  };
}

interface MoneyField {
  field: string;
  label: string;
  read: (money: ComparisonMoney) => number | null;
  /** Renders a minor-units value back to the decimal-string contract. */
  render: (value: number) => string;
}

const MONEY_FIELDS: readonly MoneyField[] = [
  { field: "marketplacePrice", label: "Marketplace price", read: (m) => m.marketplacePriceCents, render: formatCents },
  { field: "supplierCost", label: "Supplier product cost", read: (m) => m.supplierCostCents, render: formatCents },
  { field: "supplierShipping", label: "Supplier shipping", read: (m) => m.supplierShippingCents, render: formatCents },
  { field: "landedCost", label: "Landed cost", read: (m) => m.landedCostCents, render: formatCents },
  { field: "estimatedProfit", label: "Estimated profit", read: (m) => m.estimatedProfitCents, render: formatCents },
];

interface PercentField {
  field: string;
  label: string;
  read: (money: ComparisonMoney) => number | null;
}

const PERCENT_FIELDS: readonly PercentField[] = [
  { field: "marginPercent", label: "Margin", read: (m) => m.marginPercent },
];

interface PointField {
  field: string;
  label: string;
  read: (side: ComparisonSide) => number;
}

const POINT_FIELDS: readonly PointField[] = [
  { field: "score", label: "Opportunity Score", read: (s) => s.score },
  { field: "confidence", label: "Evidence confidence", read: (s) => s.confidence },
  { field: "matchConfidence", label: "Match confidence", read: (s) => s.matchConfidence },
];

interface CategoryField {
  field: string;
  label: string;
  read: (side: ComparisonSide) => string;
}

const CATEGORY_FIELDS: readonly CategoryField[] = [
  { field: "band", label: "Opportunity Band", read: (s) => s.band },
  { field: "confidenceLevel", label: "Evidence confidence level", read: (s) => s.confidenceLevel },
  { field: "economicsCompleteness", label: "Economics completeness", read: (s) => s.economicsCompleteness },
];


/**
 * Compares a fresh assessment with the immediately previous observation.
 *
 * `previous` is `null` on a first evaluation, which is reported honestly as
 * `noPrevious` rather than as a set of zero deltas.
 */
export function compareAssessments(
  previous: PreviousObservation | null,
  current: { assessment: OpportunityAssessment; economics: EconomicsResult | null },
): AssessmentComparison {
  if (previous === null) {
    return {
      previousCalculatedAt: null,
      currentCalculatedAt: current.assessment.calculatedAt,
      numeric: [],
      categorical: [],
      noPrevious: true,
    };
  }

  const before = previousSide(previous);
  const after = currentSide(current.assessment, current.economics);
  const numeric: NumericDelta[] = [];

  for (const field of MONEY_FIELDS) {
    numeric.push(
      moneyDelta(field.field, field.label, field.read(before.money), field.read(after.money), field.render),
    );
  }

  for (const field of PERCENT_FIELDS) {
    numeric.push(
      percentDelta(field.field, field.label, field.read(before.money), field.read(after.money)),
    );
  }

  for (const field of POINT_FIELDS) {
    numeric.push(pointDelta(field.field, field.label, field.read(before), field.read(after)));
  }

  const categorical: CategoricalChange[] = CATEGORY_FIELDS.map((field) => {
    const previousValue = field.read(before);
    const currentValue = field.read(after);
    return {
      field: field.field,
      label: field.label,
      previous: previousValue,
      current: currentValue,
      changed: previousValue !== currentValue,
    };
  });

  return {
    previousCalculatedAt: previous.assessment.calculatedAt,
    currentCalculatedAt: current.assessment.calculatedAt,
    numeric,
    categorical,
    noPrevious: false,
  };
}

/** A delta over integer minor units: never computed when a side is missing. */
function moneyDelta(
  field: string,
  label: string,
  previousValue: number | null,
  currentValue: number | null,
  render: (value: number) => string,
): NumericDelta {
  if (previousValue === null || currentValue === null) {
    return {
      field,
      label,
      previous: previousValue === null ? null : render(previousValue),
      current: currentValue === null ? null : render(currentValue),
      delta: null,
      direction: "unknown",
    };
  }

  const delta = currentValue - previousValue;
  return {
    field,
    label,
    previous: render(previousValue),
    current: render(currentValue),
    delta: render(delta),
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "unchanged",
  };
}

/** A delta over a percentage number. */
function percentDelta(
  field: string,
  label: string,
  previousValue: number | null,
  currentValue: number | null,
): NumericDelta {
  if (previousValue === null || currentValue === null) {
    return {
      field,
      label,
      previous: previousValue === null ? null : formatPercent(previousValue),
      current: currentValue === null ? null : formatPercent(currentValue),
      delta: null,
      direction: "unknown",
    };
  }

  const delta = Math.round((currentValue - previousValue) * 100) / 100;
  return {
    field,
    label,
    previous: formatPercent(previousValue),
    current: formatPercent(currentValue),
    delta: formatPercent(delta),
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "unchanged",
  };
}

/** A delta over an integer score/confidence point count. */
function pointDelta(
  field: string,
  label: string,
  previousValue: number,
  currentValue: number,
): NumericDelta {
  const delta = Math.round(currentValue - previousValue);
  return {
    field,
    label,
    previous: formatPoints(previousValue),
    current: formatPoints(currentValue),
    delta: formatPoints(delta),
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "unchanged",
  };
}
