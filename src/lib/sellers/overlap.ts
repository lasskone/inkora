/**
 * Deterministic cross-seller product-overlap evidence.
 *
 * A product appearing across *independent* sellers is marketplace evidence that
 * a single anomalous seller cannot provide (docs/MVP_SPEC.md §5 — seller
 * saturation). This module turns one bounded marketplace result window into an
 * explainable verdict about whether the listings in it describe one product
 * family, and how many distinct sellers hold it.
 *
 * What it is deliberately NOT:
 *
 * - It never counts a seller twice. Two listings from one seller are two
 *   listings, one independent seller.
 * - It never converts overlap into demand. "Three sellers list this" is listing
 *   presence; eBay does not expose units sold, and this module does not invent
 *   them.
 * - It never claims certainty. Confidence describes the *matching* only, is
 *   derived from named signals with signed contributions, and every cap that
 *   limited it is reported as a contradiction.
 *
 * Pure on purpose: every verdict is unit-testable with no network.
 */

import { extractProductTextFeatures } from "@/lib/matcher/text";
import type {
  CrossSellerEvidence,
  OverlapConfidenceBand,
  OverlapSignal,
} from "./types";
import {
  brandOf,
  buildDiscoveryQuery,
  familyKeyOf,
  identifiersOf,
  tokenSignature,
  tokenSimilarity,
} from "./fingerprint";

/**
 * One listing observed in the bounded discovery window. The minimal structural
 * shape the module needs; the scanner passes the marketplace search results it
 * already holds, so no second upstream call is required.
 */
export interface OverlapObservation {
  externalId: string;
  title: string;
  sellerName: string | null;
}

/** One candidate's comparison against the seed listing. */
interface OverlapComparison {
  observation: OverlapObservation;
  /** True when the evidence supports the same product family as the seed. */
  sameFamily: boolean;
  similarity: number;
  sharedIdentifiers: string[];
  brandAgreement: boolean;
  exactFamilyKey: boolean;
}

/** A contradiction and the ceiling it imposes on the confidence score. */
interface Contradiction {
  message: string;
  cap: number;
}

/** Signal contributions; every one is named so the score is auditable. */
const SIGNALS = {
  sharedIdentifier: 30,
  brandAgreement: 20,
  exactFamilyKey: 25,
  highSimilarity: 15,
  multipleIndependentSellers: 20,
  seedSellerCorroborated: 5,
} as const;

/** Caps applied by contradictions; the score can never exceed a triggered cap. */
const CAPS = {
  brandDisagreement: 40,
  weakTextualEvidence: 35,
  quantityMismatch: 55,
} as const;

const BAND_THRESHOLDS = { high: 75, medium: 45 } as const;

const SIMILARITY_FAMILY_THRESHOLD = 0.55;
const SIMILARITY_HIGH_THRESHOLD = 0.8;

/**
 * The bounded discovery query derived from a seed title, or `null` when the
 * title yields too little signal to search safely. Exposed here so this module
 * stays the single source of that derivation.
 */
export function discoveryQueryForSeed(title: string): string | null {
  return buildDiscoveryQuery(title);
}

/**
 * Computes the cross-seller evidence for one seed listing against a bounded
 * discovery window.
 *
 * The window size is echoed into the limitations as the number of results read,
 * because "how many sellers list this" can only ever be answered *within that
 * window*.
 */
export function computeCrossSellerEvidence(args: {
  seed: { externalId: string; title: string };
  sellerName: string | null;
  window: OverlapObservation[];
  discoveryQuery: string;
  observedAt: string;
}): CrossSellerEvidence {
  const seedKey = familyKeyOf(args.seed.title);
  const seedTokens = tokenSignature(args.seed.title);
  const seedBrand = brandOf(args.seed.title);
  const seedIdentifiers = new Set(identifiersOf(args.seed.title));

  const comparisons: OverlapComparison[] = args.window.map((observation) =>
    compareAgainstSeed({
      observation,
      seedKey,
      seedTokens,
      seedBrand,
      seedIdentifiers,
    }),
  );

  const matches = comparisons.filter((comparison) => comparison.sameFamily);
  const sellerNames = distinctSellers(matches);

  const signals: OverlapSignal[] = [];
  const contradictions: Contradiction[] = [];
  const limitations: string[] = [];

  const best = strongestMatch(matches);
  collectSignals({ best, sellerNames, seedBrand, signals, sellerName: args.sellerName });
  collectContradictions({
    best,
    matches,
    seedTitle: args.seed.title,
    seedBrand,
    contradictions,
  });

  const raw = signals.reduce((total, signal) => total + signal.contribution, 0);
  const capped = contradictions.reduce(
    (value, contradiction) => Math.min(value, contradiction.cap),
    raw,
  );
  const confidence = clamp(Math.round(capped), 0, 100);

  collectLimitations({
    seedIdentifiers: seedIdentifiers.size,
    windowSize: args.window.length,
    matches,
    limitations,
  });

  return {
    productFamilyKey: seedKey ?? "unfingerprintable",
    seed: { externalId: args.seed.externalId, title: args.seed.title },
    discoveryQuery: args.discoveryQuery,
    observedListings: matches.length,
    independentSellers: sellerNames.length,
    sellerNames,
    seedSellerPresent:
      args.sellerName !== null && sellerNames.includes(args.sellerName),
    confidenceBand: bandFor(confidence),
    confidence,
    signals,
    contradictions: contradictions.map((contradiction) => contradiction.message),
    limitations,
    observedAt: args.observedAt,
  };
}

// --- signal collection ------------------------------------------------------

function collectSignals(args: {
  best: OverlapComparison | null;
  sellerNames: string[];
  seedBrand: string | null;
  sellerName: string | null;
  signals: OverlapSignal[];
}): void {
  const { best, signals } = args;

  if (best !== null) {
    if (best.sharedIdentifiers.length > 0) {
      signals.push({
        name: "shared-identifier",
        detail: `A model/specification token is shared verbatim (${best.sharedIdentifiers.slice(0, 3).join(", ")}), the strongest identity signal a title carries.`,
        contribution: SIGNALS.sharedIdentifier,
      });
    }
    if (best.brandAgreement) {
      signals.push({
        name: "brand-agreement",
        detail: `Both the seed and the matching listings identify the same brand (${args.seedBrand}).`,
        contribution: SIGNALS.brandAgreement,
      });
    }
    if (best.exactFamilyKey) {
      signals.push({
        name: "exact-family-fingerprint",
        detail: "At least one listing shares the deterministic product-family fingerprint (brand, identifiers and token set).",
        contribution: SIGNALS.exactFamilyKey,
      });
    } else if (best.similarity >= SIMILARITY_HIGH_THRESHOLD) {
      signals.push({
        name: "high-textual-similarity",
        detail: `Token similarity of the closest listing is ${(best.similarity * 100).toFixed(0)}%.`,
        contribution: SIGNALS.highSimilarity,
      });
    }
  }

  if (args.sellerNames.length >= 2) {
    signals.push({
      name: "multiple-independent-sellers",
      detail: `${args.sellerNames.length} distinct sellers hold matching listings; listings from one seller are counted once.`,
      contribution: SIGNALS.multipleIndependentSellers,
    });
  }

  if (args.sellerName !== null && args.sellerNames.includes(args.sellerName)) {
    signals.push({
      name: "seed-seller-corroborated",
      detail: "The scanned seller's own listings appear in the discovery window, confirming the query is on-topic.",
      contribution: SIGNALS.seedSellerCorroborated,
    });
  }
}

// --- contradiction collection ------------------------------------------------

function collectContradictions(args: {
  best: OverlapComparison | null;
  matches: OverlapComparison[];
  seedTitle: string;
  seedBrand: string | null;
  contradictions: Contradiction[];
}): void {
  if (brandContradicted(args.matches, args.seedBrand)) {
    args.contradictions.push({
      message: "A matching listing names a different brand than the seed, so the overlap may span two products.",
      cap: CAPS.brandDisagreement,
    });
  }
  if (quantityContradicted(args.seedTitle, args.matches)) {
    args.contradictions.push({
      message: "Pack or quantity specifiers differ between the seed and a matching listing (a 3-pack is not a single unit).",
      cap: CAPS.quantityMismatch,
    });
  }
  if (args.best === null || args.best.similarity < SIMILARITY_FAMILY_THRESHOLD) {
    args.contradictions.push({
      message: "No listing in the window reached the textual-evidence threshold, so the overlap is unproven.",
      cap: CAPS.weakTextualEvidence,
    });
  }
}
// --- comparison internals ----------------------------------------------------

function compareAgainstSeed(args: {
  observation: OverlapObservation;
  seedKey: string | null;
  seedTokens: Set<string>;
  seedBrand: string | null;
  seedIdentifiers: Set<string>;
}): OverlapComparison {
  const observationKey = familyKeyOf(args.observation.title);
  const observationTokens = tokenSignature(args.observation.title);
  const observationBrand = brandOf(args.observation.title);
  const observationIdentifiers = identifiersOf(args.observation.title);

  const sharedIdentifiers = observationIdentifiers.filter((identifier) =>
    args.seedIdentifiers.has(identifier),
  );

  const similarity = tokenSimilarity(args.seedTokens, observationTokens);
  const brandAgreement =
    args.seedBrand !== null &&
    observationBrand !== null &&
    args.seedBrand === observationBrand;
  const exactFamilyKey = args.seedKey !== null && args.seedKey === observationKey;

  return {
    observation: args.observation,
    sameFamily:
      exactFamilyKey ||
      (sharedIdentifiers.length > 0 && brandAgreement) ||
      similarity >= SIMILARITY_FAMILY_THRESHOLD,
    similarity,
    sharedIdentifiers,
    brandAgreement,
    exactFamilyKey,
  };
}

/** The match carrying the strongest combined evidence, deterministically. */
function strongestMatch(matches: OverlapComparison[]): OverlapComparison | null {
  if (matches.length === 0) return null;
  return matches.reduce((best, current) => {
    const bestScore = scoreComparison(best);
    const currentScore = scoreComparison(current);
    if (currentScore !== bestScore) {
      return currentScore > bestScore ? current : best;
    }
    return current.observation.externalId < best.observation.externalId
      ? current
      : best;
  });
}

/** A deterministic ordering key for "which match is strongest". */
function scoreComparison(comparison: OverlapComparison): number {
  return (
    (comparison.exactFamilyKey ? 1000 : 0) +
    comparison.sharedIdentifiers.length * 100 +
    (comparison.brandAgreement ? 50 : 0) +
    Math.round(comparison.similarity * 100)
  );
}

/**
 * Distinct seller identities among the matches. A seller appearing many times is
 * counted once — two listings from one seller is not two independent sellers.
 */
function distinctSellers(matches: OverlapComparison[]): string[] {
  const names = new Set<string>();
  for (const match of matches) {
    if (match.observation.sellerName !== null) {
      names.add(match.observation.sellerName.trim().toLowerCase());
    }
  }
  return [...names].sort();
}

function brandContradicted(
  matches: OverlapComparison[],
  seedBrand: string | null,
): boolean {
  if (seedBrand === null) return false;
  return matches.some((match) => {
    const matchBrand = brandOf(match.observation.title);
    return matchBrand !== null && matchBrand !== seedBrand;
  });
}

/**
 * Detects a pack/quantity divergence between the seed and any match, because a
 * "3 pack" and a single unit are not the same offer even when the product is.
 */
function quantityContradicted(
  seedTitle: string,
  matches: OverlapComparison[],
): boolean {
  const seedQuantities = extractQuantities(seedTitle);
  if (seedQuantities.length === 0) return false;
  return matches.some((match) => {
    const matchQuantities = extractQuantities(match.observation.title);
    if (matchQuantities.length === 0) return false;
    return !sameSet(seedQuantities, matchQuantities);
  });
}

function extractQuantities(title: string): number[] {
  return [...extractProductTextFeatures(title).quantities].sort((a, b) => a - b);
}

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function bandFor(confidence: number): OverlapConfidenceBand {
  if (confidence >= BAND_THRESHOLDS.high) return "HIGH";
  if (confidence >= BAND_THRESHOLDS.medium) return "MEDIUM";
  return "LOW";
}

function clamp(value: number, floor: number, ceiling: number): number {
  return Math.min(Math.max(value, floor), ceiling);
}


function collectLimitations(args: {
  seedIdentifiers: number;
  windowSize: number;
  matches: OverlapComparison[];
  limitations: string[];
}): void {
  if (args.seedIdentifiers === 0) {
    args.limitations.push(
      "The seed title exposes no model/specification identifier, so matching rests on brand and token similarity, which is weaker evidence.",
    );
  }
  args.limitations.push(
    `Evidence covers the bounded discovery window of ${args.windowSize} listings; sellers beyond the window are not counted, and this is not a demand or sales measure.`,
  );
  if (args.matches.some((match) => match.observation.sellerName === null)) {
    args.limitations.push(
      "At least one matching listing carries no seller identifier, so it cannot contribute to the independent-seller count.",
    );
  }
}
