/**
 * Unit tests for the deterministic product-family fingerprints.
 *
 * The fingerprint is what lets the scanner treat two differently-worded titles
 * as one product family, so the tests assert the invariants that make it
 * trustworthy: determinism, order invariance, and refusal of signal-free input.
 * See `src/lib/sellers/fingerprint.ts`.
 */

import { describe, it } from "node:test";

import assert from "node:assert/strict";

import {
  brandOf,
  buildDiscoveryQuery,
  familyKeyOf,
  familySampleTitle,
  identifiersOf,
  tokenSignature,
  tokenSimilarity,
} from "./fingerprint";

const HEADPHONES = "Sony WH-1000XM5 Wireless Noise Cancelling Headphones";

describe("familyKeyOf", () => {
  it("is deterministic for the same title", () => {
    assert.equal(familyKeyOf(HEADPHONES), familyKeyOf(HEADPHONES));
  });

  it("is invariant to word order, because the token set is sorted", () => {
    assert.equal(
      familyKeyOf(HEADPHONES),
      familyKeyOf("Headphones Cancelling Noise Wireless Sony WH-1000XM5"),
    );
  });

  it("is null when the title carries no usable token", () => {
    assert.equal(familyKeyOf(""), null);
    assert.equal(familyKeyOf("   "), null);
    assert.equal(familyKeyOf("!!! ???"), null);
  });

  it("composes the named signals in a fixed, readable layout", () => {
    const key = familyKeyOf(HEADPHONES);
    assert.ok(key !== null);
    assert.ok(key.startsWith("b:"));
    assert.ok(key.includes("|i:"));
    assert.ok(key.includes("|u:"));
    assert.ok(key.includes("|t:"));
  });

  it("keeps the compact model token in the key", () => {
    const key = familyKeyOf(HEADPHONES);
    assert.ok(key !== null && key.includes("wh1000xm5"));
  });

  it("distinguishes two products that share words but not identity", () => {
    assert.notEqual(
      familyKeyOf(HEADPHONES),
      familyKeyOf("Sony WH-1000XM4 Wireless Noise Cancelling Headphones"),
    );
  });
});

describe("tokenSignature", () => {
  it("unions the meaningful tokens and identifiers, deduplicated", () => {
    const signature = tokenSignature(HEADPHONES);
    assert.ok(signature.has("sony"));
    assert.ok(signature.has("wh1000xm5"));
    assert.ok(signature.has("headphone"));
  });

  it("is order invariant, matching the family key's contract", () => {
    assert.deepEqual(
      [...tokenSignature(HEADPHONES)].sort(),
      [...tokenSignature("Headphones Sony WH-1000XM5 Wireless Noise Cancelling")].sort(),
    );
  });
});

describe("brandOf", () => {
  it("identifies a single lexicon brand, case insensitively", () => {
    assert.equal(brandOf(HEADPHONES), "sony");
    assert.equal(brandOf("sony headphones"), "sony");
  });

  it("reports an unknown brand as null rather than guessing", () => {
    assert.equal(brandOf("NoName Wireless Earbuds"), null);
  });

  it("reports an ambiguous pair of brands as null", () => {
    assert.equal(brandOf("Sony Bose Wireless Headphones"), null);
  });
});

describe("identifiersOf", () => {
  it("keeps compact model tokens and drops pure words", () => {
    const identifiers = identifiersOf(HEADPHONES);
    assert.ok(identifiers.includes("wh1000xm5"));
    assert.ok(!identifiers.includes("sony"));
  });
});

describe("familySampleTitle", () => {
  it("returns the listing's own title, never a synthesized label", () => {
    assert.equal(familySampleTitle({ title: HEADPHONES }), HEADPHONES);
  });
});

describe("buildDiscoveryQuery", () => {
  it("leads with the identifier, which is a needle-in-haystack query", () => {
    const query = buildDiscoveryQuery(HEADPHONES);
    assert.ok(query !== null);
    assert.equal(query.split(" ")[0], "wh1000xm5");
  });

  it("is bounded in both token count and character length", () => {
    const query = buildDiscoveryQuery(
      "Sony WH-1000XM5 Wireless Active Noise Cancelling Over Ear Bluetooth Headphones With Microphone",
    );
    assert.ok(query !== null);
    assert.ok(query.split(" ").length <= 6);
    assert.ok(query.length <= 64);
  });

  it("is refused when the title yields too little signal to search safely", () => {
    assert.equal(buildDiscoveryQuery("Headphones"), null);
    assert.equal(buildDiscoveryQuery(""), null);
  });
});

describe("tokenSimilarity", () => {
  it("scores identical sets at one", () => {
    assert.equal(tokenSimilarity(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  });

  it("is zero against an empty set, since similarity to nothing is meaningless", () => {
    assert.equal(tokenSimilarity(new Set(["a"]), new Set()), 0);
    assert.equal(tokenSimilarity(new Set(), new Set()), 0);
  });

  it("is symmetric and equals the intersection-over-union", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["b", "c"]);
    assert.equal(tokenSimilarity(a, b), 1 / 3);
    assert.equal(tokenSimilarity(a, b), tokenSimilarity(b, a));
  });

  it("is zero for disjoint sets", () => {
    assert.equal(tokenSimilarity(new Set(["a"]), new Set(["b"])), 0);
  });
});
