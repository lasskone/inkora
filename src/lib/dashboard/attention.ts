/**
 * Needs Attention — deterministic conditions the existing engines already
 * recorded (docs/ARCHITECTURE.md §19.5).
 *
 * This module invents **nothing**. It is a fixed list of named conditions, each
 * defined by a boolean expression over fields a persisted assessment already
 * carries. There is no priority score, no weighting, no severity level and no
 * ranking by "importance": the reasons are reported in a fixed order, and an
 * item's position in the section comes from the Opportunity Engine's own score
 * under the same ladder every other list uses.
 *
 * The reasons, with their exact definitions:
 *
 *   `low-match-profitable`            — a pair scope with a LOW-confidence match
 *                                       that still records a profit. The money may
 *                                       describe the wrong product.
 *   `low-evidence-strong-score`       — a score at or above the MEDIUM band resting
 *                                       on LOW evidence confidence. The verdict is
 *                                       only as good as its evidence.
 *   `economics-unavailable`           — the economics layer could not compute, so
 *                                       no profit or margin is known at all.
 *   `economics-partial`               — the economics layer computed on partial
 *                                       inputs, so some figures are reference
 *                                       values rather than confirmed ones.
 *   `negative-profit`                 — a confirmed loss. A stored loss is a real
 *                                       result and is reported, never clamped.
 *   `no-supplier-candidate`           — a marketplace-only assessment: the matcher
 *                                       found no candidate, so the verdict is the
 *                                       LOW-capped one and sourcing is unsolved.
 *   `supplier-availability-unknown`   — a pair scope whose assessment recorded no
 *                                       supplier observation, so availability is
 *                                       unknown rather than confirmed.
 *   `watch-changed`                   — an actively watched scope whose latest
 *                                       assessment differs materially from its
 *                                       immediately previous one.
 *
 * Pure by design — no `server-only`, no I/O — so every condition is pinned by a
 * unit test from fixtures alone.
 */

import { MEDIUM_BAND_THRESHOLD } from "@/lib/opportunity/types";
import type {
  AttentionReason,
  AttentionReasonCode,
  ScopeAssessment,
} from "./types";
import { profitCents, scopeKey } from "./sorting";

/** Whether one scope's latest assessment materially differs from its previous one. */
export interface ChangeEvidence {
  previous: ScopeAssessment | null;
}

/**
 * The reasons that apply to one scope, in the fixed order the section renders.
 *
 * Order is a presentation choice, not a ranking: it is deliberately the order the
 * definitions are documented in above, so the list reads the same way every time
 * and no reason is ever implicitly promoted over another.
 */
const REASON_ORDER: readonly AttentionReasonCode[] = [
  "low-match-profitable",
  "low-evidence-strong-score",
  "economics-unavailable",
  "economics-partial",
  "negative-profit",
  "no-supplier-candidate",
  "supplier-availability-unknown",
  "watch-changed",
];

const REASON_MESSAGES: Record<AttentionReasonCode, string> = {
  "low-match-profitable":
    "Records a profit against only a LOW-confidence product match — the money figures may describe the wrong product.",
  "low-evidence-strong-score":
    "Scores at or above the MEDIUM band on LOW evidence confidence — the verdict rests on thin evidence.",
  "economics-unavailable":
    "Economics could not be computed, so no profit or margin is known for this opportunity.",
  "economics-partial":
    "Economics are PARTIAL — some costs are reference values rather than confirmed ones.",
  "negative-profit":
    "The estimated profit is negative — this opportunity currently costs money per unit.",
  "no-supplier-candidate":
    "No supplier candidate was found, so this is the marketplace-only verdict, hard-capped at LOW. Sourcing is unsolved.",
  "supplier-availability-unknown":
    "A supplier candidate is in scope but no supplier observation was stored for it, so availability is unknown.",
  "watch-changed":
    "This watched opportunity changed since its previous evaluation.",
};

/**
 * The threshold this module uses for "strong score" — the band threshold the
 * Opportunity Engine already defines. Re-exported so the UI labels it identically
 * and the tests can assert against the same number.
 */
export const STRONG_SCORE_THRESHOLD = MEDIUM_BAND_THRESHOLD;

/** Whether a scope's latest assessment materially differs from its previous one. */
export function assessmentChanged(
  current: ScopeAssessment,
  evidence: ChangeEvidence,
): boolean {
  const previous = evidence.previous;
  if (previous === null) {
    return false;
  }
  return (
    previous.score !== current.score ||
    previous.band !== current.band ||
    previous.confidence !== current.confidence ||
    previous.confidenceLevel !== current.confidenceLevel ||
    previous.matchConfidence !== current.matchConfidence ||
    previous.economicsCompleteness !== current.economicsCompleteness ||
    previous.estimatedProfit !== current.estimatedProfit ||
    previous.marginPercent !== current.marginPercent
  );
}

/**
 * Derives every attention reason that applies to one scope.
 *
 * Returns an empty list when none applies — which is the honest "nothing needs
 * attention here", not a missing section.
 */
export function deriveAttentionReasons(
  scope: ScopeAssessment,
  evidence: ChangeEvidence,
  watchedScopes: ReadonlySet<string>,
): AttentionReason[] {
  const codes: AttentionReasonCode[] = [];

  const profit = profitCents(scope);
  const isPair = scope.supplierExternalId !== null;

  if (isPair && scope.matchConfidenceBand === "LOW" && profit !== null && profit > 0) {
    codes.push("low-match-profitable");
  }

  if (scope.band !== "LOW" && scope.confidenceLevel === "LOW") {
    codes.push("low-evidence-strong-score");
  }

  if (scope.economicsCompleteness === "UNAVAILABLE") {
    codes.push("economics-unavailable");
  } else if (scope.economicsCompleteness === "PARTIAL") {
    codes.push("economics-partial");
  }

  if (profit !== null && profit < 0) {
    codes.push("negative-profit");
  }

  if (!isPair) {
    codes.push("no-supplier-candidate");
  } else if (scope.supplierSnapshotObservedAt === null) {
    codes.push("supplier-availability-unknown");
  }

  if (watchedScopes.has(scopeKey(scope)) && assessmentChanged(scope, evidence)) {
    codes.push("watch-changed");
  }

  return codes
    .sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b))
    .map((code) => ({ code, message: REASON_MESSAGES[code] }));
}

/** True when any attention reason applies — used for the summary card count. */
export function hasAttentionReasons(
  scope: ScopeAssessment,
  evidence: ChangeEvidence,
  watchedScopes: ReadonlySet<string>,
): boolean {
  return deriveAttentionReasons(scope, evidence, watchedScopes).length > 0;
}

