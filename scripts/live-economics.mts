/**
 * Live economics validation helper (run manually against a running server).
 *
 *   npx next start -p 3000
 *   node --import ./scripts/test-register.mjs ./scripts/live-economics.mts
 *
 * For each query it resolves a fresh eBay listing (eBay rotates results), runs
 * the bounded matcher, then computes economics for the top ranked candidate —
 * exercising the real CJ variant resolution and the real CJ freight endpoint.
 * The point is not to find profitable products; it is to prove that the money
 * layer reports real figures and honest completeness on live data.
 */

const BASE = "http://localhost:3000";

const CASES = [
  { label: "generic earbuds", q: "wireless earbuds" },
  { label: "model number", q: "anker soundcore life q30" },
  { label: "capacity 20oz", q: "20oz insulated tumbler" },
  { label: "multi-variant (apparel)", q: "mens cotton t shirt" },
  { label: "multi-variant (watch bands)", q: "apple watch band" },
];

/**
 * eBay rotates results between calls, so the first search hit can vanish before
 * the matcher re-resolves it. Try up to this many hits from the same search
 * before giving up on a query.
 */
const MAX_LISTING_ATTEMPTS = 3;

/**
 * The economics route replays the eBay search to re-prove the listing; eBay
 * reorders/rotates results between calls, so the same item can be missing from a
 * later 24-item window. Retry a few times before concluding it is gone.
 */
const ECONOMICS_ATTEMPTS = 5;

interface EconomicsResult {
  completeness: string;
  currency: string | null;
  itemPrice: string | null;
  buyerShipping: string | null;
  grossMarketplaceRevenue: string | null;
  supplierProductCost: string | null;
  supplierShippingCost: string | null;
  landedSupplierCost: string | null;
  marketplaceFee: string | null;
  estimatedProfit: string | null;
  marginPercent: string | null;
  supplierCostBasis: string | null;
  supplierShippingMethod: string | null;
  feeStatus: string;
  feeEngineVersion: string;
  warnings: string[];
  assumptions: string[];
  shippingQuotes: unknown[];
  provenance: Record<string, string>;
}
interface Candidate {
  confidence: number;
  confidenceBand: string;
  supplierProduct: { externalId: string; title: string };
}
interface MatchResponse {
  status: string;
  error?: string;
  code?: string;
  candidates: Candidate[];
}
interface EconomicsResponse {
  status: string;
  error?: string;
  code?: string;
  economics?: EconomicsResult;
  matchConfidenceBand?: string;
}

for (const testCase of CASES) {
  const searchParams = new URLSearchParams({ q: testCase.q });
  const searchResponse = await fetch(
    `${BASE}/api/marketplaces/ebay/search?${searchParams.toString()}`,
    { cache: "no-store" },
  );
  const searchPayload = (await searchResponse.json()) as {
    status: string;
    products?: Array<{ externalId: string; title: string; price: string | null }>;
  };
  const listings = searchPayload.products ?? [];

  console.log("=".repeat(78));
  console.log(`CASE: ${testCase.label}  (q: "${testCase.q}")`);
  if (listings.length === 0) {
    console.log("  eBay search returned no listings for this query; skipping.");
    continue;
  }

  // Walk the search results until one survives the matcher's re-resolve: eBay
  // rotates results, so the top hit can legitimately be gone a second later.
  let candidate: Candidate | null = null;
  let listing = listings[0];
  for (const attempt of listings.slice(0, MAX_LISTING_ATTEMPTS)) {
    const matchParams = new URLSearchParams({
      itemId: attempt.externalId,
      q: testCase.q,
    });
    const matchResponse = await fetch(
      `${BASE}/api/products/matches?${matchParams.toString()}`,
      { cache: "no-store" },
    );
    const matchPayload = (await matchResponse.json()) as MatchResponse;
    if (matchPayload.status === "ok" && matchPayload.candidates.length > 0) {
      listing = attempt;
      candidate = matchPayload.candidates[0];
      break;
    }
    console.log(
      `  listing ${attempt.externalId} did not resolve (${matchPayload.code ?? matchPayload.status}); trying next result`,
    );
  }

  if (candidate === null) {
    console.log("  no listing in the search window survived re-resolution; skipping.");
    continue;
  }

  console.log(
    `eBay ${listing.externalId} · ${candidate.confidenceBand} (${candidate.confidence}) -> CJ ${candidate.supplierProduct.externalId}`,
  );
  console.log(`  eBay title: ${listing.title}`);
  console.log(`  CJ title:   ${candidate.supplierProduct.title}`);

  const econParams = new URLSearchParams({
    itemId: listing.externalId,
    q: testCase.q,
    supplierProductId: candidate.supplierProduct.externalId,
  });

  // The economics route replays the search itself, so the item can rotate out of
  // that window between calls; retry rather than treating rotation as failure.
  let response: Response | null = null;
  let payload: EconomicsResponse | null = null;
  for (let attempt = 1; attempt <= ECONOMICS_ATTEMPTS; attempt++) {
    response = await fetch(`${BASE}/api/products/economics?${econParams.toString()}`, {
      cache: "no-store",
    });
    payload = (await response.json()) as EconomicsResponse;
    if (payload.status === "ok" || payload.code !== "ITEM_NOT_RESOLVED") break;
    console.log(`  economics attempt ${attempt}: item rotated out of the window; retrying`);
  }
  if (response === null || payload === null) continue;

  console.log(`HTTP ${response.status}  status: ${payload.status}  band: ${payload.matchConfidenceBand ?? "?"}`);
  if (payload.status !== "ok" || !payload.economics) {
    console.log(`  ERROR ${payload.code}: ${payload.error}`);
    continue;
  }

  const r = payload.economics;
  console.log(`completeness: ${r.completeness}  currency: ${r.currency}`);
  console.log(
    `  item ${r.itemPrice} + shipping ${r.buyerShipping} = revenue ${r.grossMarketplaceRevenue}`,
  );
  console.log(
    `  cj cost ${r.supplierProductCost} (${r.supplierCostBasis}) + cj shipping ${r.supplierShippingCost} via ${r.supplierShippingMethod} = landed ${r.landedSupplierCost}`,
  );
  console.log(
    `  fee ${r.marketplaceFee} (${r.feeStatus}, ${r.feeEngineVersion}) -> profit ${r.estimatedProfit} · margin ${r.marginPercent}%`,
  );
  console.log(`  freight quotes returned: ${r.shippingQuotes.length}`);
  console.log(`  warnings: ${r.warnings.length}`);
  for (const warning of r.warnings) console.log(`    - ${warning}`);
  console.log(`  assumptions: ${r.assumptions.length}`);
  for (const assumption of r.assumptions.slice(0, 4)) {
    console.log(`    - ${assumption}`);
  }
  console.log(
    `  provenance: ${Object.entries(r.provenance).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  );
}
