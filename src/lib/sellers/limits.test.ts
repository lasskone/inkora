/**
 * Unit tests for the server-enforced seller scanner bounds.
 *
 * The limits are a contract: a client request can never exceed them, and the
 * pure clamping helpers are the whole reason the boundary is testable without
 * a network. See `src/lib/sellers/limits.ts`.
 */

import { describe, it } from "node:test";

import assert from "node:assert/strict";

import {
  SELLER_OVERLAP_ANALYSES_DEFAULT,
  SELLER_OVERLAP_ANALYSES_MAX,
  SELLER_OVERLAP_WINDOW_DEFAULT,
  SELLER_OVERLAP_WINDOW_MAX,
  SELLER_RECENT_DEFAULT,
  SELLER_RECENT_MAX,
  SELLER_SAMPLE_DEFAULT,
  SELLER_SAMPLE_MAX,
  clampOverlapAnalyses,
  clampOverlapWindow,
  clampRecentLimit,
  clampSampleLimit,
  snapOffset,
} from "./limits";

describe("clampSampleLimit", () => {
  it("falls back to the default when the request carries no usable value", () => {
    assert.equal(clampSampleLimit(undefined), SELLER_SAMPLE_DEFAULT);
    assert.equal(clampSampleLimit(Number.NaN), SELLER_SAMPLE_DEFAULT);
    assert.equal(clampSampleLimit(Number.POSITIVE_INFINITY), SELLER_SAMPLE_DEFAULT);
  });

  it("truncates a fractional request rather than rounding it up", () => {
    assert.equal(clampSampleLimit(24.9), 24);
  });

  it("raises a request above the ceiling to the documented maximum", () => {
    assert.equal(clampSampleLimit(500), SELLER_SAMPLE_MAX);
  });

  it("raises a request below the floor to one rather than accepting zero", () => {
    assert.equal(clampSampleLimit(0), 1);
    assert.equal(clampSampleLimit(-12), 1);
  });

  it("passes a valid request through untouched", () => {
    assert.equal(clampSampleLimit(12), 12);
  });
});

describe("clampRecentLimit", () => {
  it("falls back to the default for an unusable request", () => {
    assert.equal(clampRecentLimit(undefined), SELLER_RECENT_DEFAULT);
  });

  it("caps at the recent-listing maximum", () => {
    assert.equal(clampRecentLimit(100), SELLER_RECENT_MAX);
  });

  it("truncates and floors a fractional low request", () => {
    assert.equal(clampRecentLimit(0.9), 1);
    assert.equal(clampRecentLimit(3.7), 3);
  });
});

describe("clampOverlapWindow", () => {
  it("falls back to the default for an unusable request", () => {
    assert.equal(clampOverlapWindow(undefined), SELLER_OVERLAP_WINDOW_DEFAULT);
  });

  it("caps at the discovery-window maximum", () => {
    assert.equal(clampOverlapWindow(9999), SELLER_OVERLAP_WINDOW_MAX);
  });

  it("truncates a fractional request", () => {
    assert.equal(clampOverlapWindow(50.5), 50);
  });
});

describe("clampOverlapAnalyses", () => {
  it("falls back to the default for an unusable request", () => {
    assert.equal(clampOverlapAnalyses(undefined), SELLER_OVERLAP_ANALYSES_DEFAULT);
  });

  it("caps at the hard maximum, which a client can never raise", () => {
    assert.equal(clampOverlapAnalyses(99), SELLER_OVERLAP_ANALYSES_MAX);
  });

  it("allows zero analyses, since overlap is an opt-in cost", () => {
    assert.equal(clampOverlapAnalyses(0), 0);
    assert.equal(clampOverlapAnalyses(-1), 0);
  });

  it("truncates a fractional request", () => {
    assert.equal(clampOverlapAnalyses(2.9), 2);
  });
});

describe("snapOffset", () => {
  it("starts at the first page for any unusable or non-positive value", () => {
    assert.equal(snapOffset(undefined, SELLER_SAMPLE_DEFAULT), 0);
    assert.equal(snapOffset(Number.NaN, SELLER_SAMPLE_DEFAULT), 0);
    assert.equal(snapOffset(0, SELLER_SAMPLE_DEFAULT), 0);
    assert.equal(snapOffset(-40, SELLER_SAMPLE_DEFAULT), 0);
  });

  it("snaps an unaligned offset down onto the pagination grid", () => {
    assert.equal(snapOffset(1, 24), 0);
    assert.equal(snapOffset(7, 24), 0);
    assert.equal(snapOffset(24, 24), 24);
    assert.equal(snapOffset(25, 24), 24);
    assert.equal(snapOffset(50, 24), 48);
  });

  it("falls back to the default page size when the limit is unusable", () => {
    assert.equal(snapOffset(48, 0), SELLER_SAMPLE_DEFAULT * 2);
  });

  it("never reports an offset beyond the marketplace window maximum", () => {
    assert.equal(snapOffset(100_000, SELLER_SAMPLE_DEFAULT), 9999);
  });
});
