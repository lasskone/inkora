/**
 * Unit tests for the cross-seller product-overlap evidence.
 *
 * Confidence is a score over named, signed signals with explicit caps, so the
 * tests exercise the arithmetic that makes a verdict reproducible — including
 * the caps that a contradiction imposes. See `src/lib/sellers/overlap.ts`.
 */

import { describe, it } from "node:test";

import assert from "node:assert/strict";

import {
  type OverlapObservation,
  computeCrossSellerEvidence,
  discoveryQueryForSeed,
} from "./overlap";

const XM5 = "Sony WH-1000XM5 Wireless Noise Cancelling Headphones";
const NOW = "2026-02-01T00:00:00Z";

function observation(
  externalId: string,
  title: string,
  sellerName: string | null,
): OverlapObservation {
  return { externalId, title, sellerName };
}

/** The evidence for a seed against one window, with the seed's own seller named. */
function evidence(args: {
  seedTitle: string;
  sellerName?: string | null;
  window: OverlapObservation[];
}) {
  return computeCrossSellerEvidence({
    seed: { externalId: "seed", title: args.seedTitle },
    sellerName: args.sellerName ?? null,
    window: args.window,
    discoveryQuery: "wh1000xm5",
    observedAt: NOW,
  });
}

describe("computeCrossSellerEvidence", () => {
  it("scores an exact family match from another seller as high confidence", () => {
    const result = evidence({
      seedTitle: XM5,
      window: [observation("w1", XM5, "other-shop")],
    });

    assert.equal(result.observedListings, 1);
    assert.equal(result.independentSellers, 1);
    assert.deepEqual(result.sellerNames, ["other-shop"]);
    assert.equal(result.confidence, 75);
    assert.equal(result.confidenceBand, "HIGH");
    assert.equal(result.seedSellerPresent, false);
    assert.ok(result.productFamilyKey.startsWith("b:"));
  });

  it("names every signal that contributed to the score", () => {
    const result = evidence({
      seedTitle: XM5,
      window: [observation("w1", XM5, "other-shop")],
    });

    const names = result.signals.map((signal) => signal.name);
    assert.ok(names.includes("shared-identifier"));
    assert.ok(names.includes("brand-agreement"));
    assert.ok(names.includes("exact-family-fingerprint"));

    const total = result.signals.reduce(
      (sum, signal) => sum + signal.contribution,
      0,
    );
    assert.equal(total, result.confidence);
  });

  it("counts the seed's own seller once, and corroborates the query topic", () => {
    const result = evidence({
      seedTitle: XM5,
      sellerName: "inkora-store",
      window: [
        observation("w1", XM5, "inkora-store"),
        observation("w2", XM5, "other-shop"),
      ],
    });

    assert.equal(result.observedListings, 2);
    assert.equal(result.independentSellers, 2);
    assert.deepEqual(result.sellerNames, ["inkora-store", "other-shop"]);
    assert.equal(result.seedSellerPresent, true);
    assert.equal(result.confidence, 100);
    assert.equal(result.confidenceBand, "HIGH");

    const names = result.signals.map((signal) => signal.name);
    assert.ok(names.includes("multiple-independent-sellers"));
    assert.ok(names.includes("seed-seller-corroborated"));
  });

  it("reports zero confidence when nothing in the window matches", () => {
    const result = evidence({
      seedTitle: XM5,
      window: [observation("w1", "Anker Soundcore Earbuds", "other-shop")],
    });

    assert.equal(result.observedListings, 0);
    assert.equal(result.independentSellers, 0);
    assert.equal(result.confidence, 0);
    assert.equal(result.confidenceBand, "LOW");
    assert.ok(
      result.contradictions.some((message) =>
        message.includes("textual-evidence threshold"),
      ),
    );
  });

  it("caps the score when a matching listing names a different brand", () => {
    const result = evidence({
      seedTitle: "Sony Wireless Over Ear Headphones",
      window: [
        observation("w1", "Sony Wireless Over Ear Headphones", "seller-a"),
        observation("w2", "Bose Wireless Over Ear Headphones", "seller-b"),
      ],
    });

    assert.equal(result.observedListings, 2);
    assert.equal(result.confidence, 40);
    assert.equal(result.confidenceBand, "LOW");
    assert.ok(
      result.contradictions.some((message) => message.includes("different brand")),
    );
  });

  it("caps the score when pack quantities disagree", () => {
    const result = evidence({
      seedTitle: "Sony WH-1000XM5 Headphones 3 pack",
      window: [
        observation("w1", "Sony WH-1000XM5 Headphones 2 pack", "seller-b"),
      ],
    });

    assert.equal(result.observedListings, 1);
    assert.equal(result.confidence, 50);
    assert.equal(result.confidenceBand, "MEDIUM");
    assert.ok(
      result.contradictions.some((message) =>
        message.includes("Pack or quantity"),
      ),
    );
  });

  it("echoes the bounded discovery window as a limitation", () => {
    const result = evidence({
      seedTitle: "Sony Wireless Over Ear Headphones",
      window: [observation("w1", "Sony Wireless Over Ear Headphones", "shop")],
    });

    assert.ok(
      result.limitations.some((message) =>
        message.includes("bounded discovery window of 1 listings"),
      ),
    );
    assert.ok(
      result.limitations.some((message) =>
        message.includes("no model/specification identifier"),
      ),
    );
  });

  it("never converts overlap into a demand or sales measure", () => {
    const result = evidence({
      seedTitle: XM5,
      window: [observation("w1", XM5, "other-shop")],
    });
    assert.ok(
      result.limitations.some((message) =>
        message.includes("not a demand or sales measure"),
      ),
    );
    assert.equal(result.observedAt, NOW);
  });
});

describe("discoveryQueryForSeed", () => {
  it("derives the same bounded query the fingerprint module builds", () => {
    assert.ok(discoveryQueryForSeed(XM5) !== null);
    assert.equal(discoveryQueryForSeed("Headphones"), null);
  });
});
