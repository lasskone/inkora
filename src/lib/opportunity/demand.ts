/**
 * The **demand** component: how much demand evidence exists, and what it
 * supports.
 *
 * This is the component INKORA is least able to support from official data, and
 * it is written accordingly (docs/ARCHITECTURE.md §9.1, docs/API_INTEGRATIONS.md
 * §2). The eBay Browse API used by the product scanner returns no units sold,
 * no sales velocity, no conversion rate, no revenue, and no demand history — so
 * the engine derives none of those, and offers no "HIGH demand" verdict at all.
 *
 * What can legitimately be observed is *listing persistence*: the listing was
 * present and priced across observations separated in time. That is consistent
 * with a listing that is genuinely being offered, and it is not evidence of
 * volume. This module says exactly that, in the verdict, the evidence lines,
 * and the limitations — never implying more.
 *
 * Sourcing evidence (how many supplier candidates were found) is carried here
 * but contributes **nothing to the score**: being able to *source* a product is
 * not evidence that anyone *buys* it. Conflating the two is the classic
 * supply-side error, so the two are kept separate by construction.
 *
 * Pure: identical inputs ⇒ identical output.
 */

import type {
  DemandAssessment,
  DemandVerdict,
  ListingPersistenceEvidence,
  OpportunityInput,
  SourcingEvidence,
} from "./types";
import {
  DEMAND_CONFIDENCE_FACTORS,
  DEMAND_SCORES,
  MEANINGFUL_PERSISTENCE_HOURS,
} from "./types";
import { selectUsablePriceObservations } from "./history-evidence";

/** Human-readable label for each verdict, used in generated explanations. */
const VERDICT_LABELS: Record<DemandVerdict, string> = {
  SUPPORTING: "listing persistence supports ongoing demand",
  WEAKLY_SUPPORTING: "listing persistence weakly supports ongoing demand",
  INSUFFICIENT_EVIDENCE: "no demand evidence",
};

/**
 * Derives the demand verdict from usable price observations.
 *
 * - No usable observations, or only one → `INSUFFICIENT_EVIDENCE`. One snapshot
 *   is a single fact about one moment; it supports nothing about demand.
 * - Two or more separated observations → at least `WEAKLY_SUPPORTING`.
 * - `SUPPORTING` additionally requires the price to have held *and* the span to
 *   reach `MEANINGFUL_PERSISTENCE_HOURS`: a listing that kept its price over a
 *   meaningful span is a meaningfully different fact from one seen twice in an
 *   hour.
 */
function deriveVerdict(
  persistence: ListingPersistenceEvidence | null,
): DemandVerdict {
  if (persistence === null) return "INSUFFICIENT_EVIDENCE";
  if (persistence.observations < 2) return "INSUFFICIENT_EVIDENCE";
  if (persistence.priceStable && persistence.spanHours >= MEANINGFUL_PERSISTENCE_HOURS) {
    return "SUPPORTING";
  }
  return "WEAKLY_SUPPORTING";
}

/**
 * Builds the demand component. Never throws and never returns a partial object:
 * every input state — including no history at all — produces a complete,
 * explainable verdict.
 */
export function assessDemand(input: OpportunityInput): DemandAssessment {
  const usable = selectUsablePriceObservations(
    input.history,
    input.limits.maxPriceObservations,
  );

  const persistence: ListingPersistenceEvidence | null =
    usable.observations.length >= 2
      ? {
          observations: usable.observations.length,
          spanHours: usable.spanHours,
          priceStable: isPriceStable(usable.observations),
        }
      : null;

  const verdict = deriveVerdict(persistence);
  const evidence: string[] = [];
  const limitations: string[] = [];

  if (persistence === null) {
    evidence.push(
      usable.observations.length === 0
        ? "No persisted marketplace observations were available for this listing."
        : "Only one persisted marketplace observation was available, which is a single fact about one moment.",
    );
  } else {
    evidence.push(
      `The listing was observed ${persistence.observations} times, ` +
        `separated by at least one hour, spanning ${formatSpan(persistence.spanHours)}.`,
    );
    evidence.push(
      persistence.priceStable
        ? "The observed price was identical across every usable observation."
        : "The observed price changed between observations.",
    );
  }

  // The API limitation is stated on every assessment, because it is the reason
  // no volume claim is ever made — including on the ones that look strongest.
  limitations.push(
    "The eBay APIs Inkora uses return no units sold, sales velocity, conversion rate, or demand history, so no volume or revenue estimate is possible.",
  );
  limitations.push(
    "Listing persistence is consistent with ongoing availability, not proof of sales: an unsold listing can persist indefinitely.",
  );
  if (verdict === "WEAKLY_SUPPORTING") {
    limitations.push(
      `Persistence was observed over less than ${MEANINGFUL_PERSISTENCE_HOURS} hours, which is too short a span to read as stable demand.`,
    );
  }
  if (input.history === null) {
    limitations.push(
      "No persisted history exists yet for this listing, so this is a first assessment.",
    );
  }

  return {
    verdict,
    score: DEMAND_SCORES[verdict],
    evidence,
    limitations,
    listingPersistence: persistence,
    sourcing: buildSourcing(input),
  };
}

/** Builds the sourcing evidence block, which contributes nothing to the score. */
function buildSourcing(input: OpportunityInput): SourcingEvidence {
  return {
    queries: input.supplierQueries.length,
    candidateCount: input.supplierCandidateCount,
    note: "Sourcing evidence proves the product is sourceable; it is not demand and contributes nothing to the score.",
  };
}

/** Multiplier applied to confidence for this verdict (see `DEMAND_CONFIDENCE_FACTORS`). */
export function demandConfidenceFactor(verdict: DemandVerdict): number {
  return DEMAND_CONFIDENCE_FACTORS[verdict];
}

/** Human-readable phrase for the verdict, for use in generated explanations. */
export function demandVerdictLabel(verdict: DemandVerdict): string {
  return VERDICT_LABELS[verdict];
}

/** Whether every usable observation reports the same price. */
function isPriceStable(observations: { priceCents: number | null }[]): boolean {
  const known = observations
    .map((observation) => observation.priceCents)
    .filter((value): value is number => value !== null);
  if (known.length === 0) return false;
  return known.every((value) => value === known[0]);
}

/** Renders an hour span as a deterministic human-readable phrase. */
function formatSpan(hours: number): string {
  if (hours <= 0) return "no measurable time";
  if (hours < 48) return `${Math.round(hours * 10) / 10} hours`;
  return `${Math.round((hours / 24) * 10) / 10} days`;
}

