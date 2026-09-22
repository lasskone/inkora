/**
 * Distilling persisted history into bounded, honest evidence.
 *
 * The Opportunity Engine never touches the observation tables. The route reads
 * them and hands the engine a `HistoryEvidenceSummary`; this module is the only
 * place that decides which of those rows are *usable as evidence*.
 *
 * The rules are deliberately conservative (docs/ARCHITECTURE.md §9):
 *
 * - Two snapshots taken minutes apart are **one** observation seen twice, so
 *   observations must be separated by `MIN_TREND_GAP_HOURS` to count as two.
 * - Only *persistence* is ever read from history. No trend is fitted, no rate
 *   is extrapolated, and nothing is forecast — a stored price is a fact about
 *   the moment it was stored, never a statement about the future.
 * - Everything is bounded by `OpportunityLimits`, so an assessment can never
 *   have used more history than the input declares.
 *
 * Pure: identical inputs ⇒ identical output, no I/O, no clock.
 */

import type {
  HistoryEvidenceSummary,
  PriceObservation,
} from "./types";
import { MIN_TREND_GAP_HOURS, STALE_OBSERVATION_HOURS } from "./types";

/** Observations that survive the separation rule, and the span they cover. */
export interface UsablePriceObservations {
  observations: PriceObservation[];
  /** Hours between the first and last usable observation (`0` when fewer than two). */
  spanHours: number;
}

/**
 * Hours between two ISO 8601 timestamps. Returns `0` when either timestamp
 * cannot be parsed rather than fabricating an interval, and never a negative
 * number — the caller supplied history is oldest-first, so a negative result
 * means bad input and is clamped rather than trusted.
 */
export function elapsedHours(earlier: string, later: string): number {
  const start = Date.parse(earlier);
  const end = Date.parse(later);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, (end - start) / 3_600_000);
}

/**
 * Age of a stored observation relative to the assessment's anchor timestamp,
 * in hours. Staleness is measured against `input.now` — never against the real
 * clock — so an assessment stays reproducible.
 */
export function ageHours(observedAt: string, now: string): number {
  return elapsedHours(observedAt, now);
}

/** Whether a stored observation is too old to describe the listing's current state. */
export function isStaleSnapshot(observedAt: string, now: string): boolean {
  return ageHours(observedAt, now) > STALE_OBSERVATION_HOURS;
}

/**
 * Selects the observations that count as *separated* evidence.
 *
 * Walks the summary's already-oldest-first list and keeps an observation only
 * when it stands at least `MIN_TREND_GAP_HOURS` after the last one kept, which
 * also collapses any duplicate timestamp. When the bounded result would still
 * exceed `maxObservations`, the first usable observation is kept (so the span
 * is preserved) alongside the most recent ones.
 */
export function selectUsablePriceObservations(
  history: HistoryEvidenceSummary | null,
  maxObservations: number,
): UsablePriceObservations {
  if (history === null || history.priceObservations.length === 0) {
    return { observations: [], spanHours: 0 };
  }

  const separated: PriceObservation[] = [];
  for (const observation of history.priceObservations) {
    if (separated.length === 0) {
      separated.push(observation);
      continue;
    }
    const previous = separated[separated.length - 1];
    if (elapsedHours(previous.observedAt, observation.observedAt) >= MIN_TREND_GAP_HOURS) {
      separated.push(observation);
    }
  }

  const bounded =
    separated.length <= maxObservations
      ? separated
      : [separated[0], ...separated.slice(separated.length - maxObservations + 1)];

  const spanHours =
    bounded.length >= 2
      ? elapsedHours(bounded[0].observedAt, bounded[bounded.length - 1].observedAt)
      : 0;

  return { observations: bounded, spanHours };
}
