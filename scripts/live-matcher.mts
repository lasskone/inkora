/**
 * Live matcher validation helper (run manually against a running server).
 *
 *   node --import ./scripts/test-register.mjs ./scripts/live-matcher.mts
 *
 * Selects real eBay listings across four shapes — generic keyword, model
 * number, capacity, and pack count — resolving a fresh listing for each query
 * (eBay rotates results), then runs the matcher route on each and prints the
 * generated queries, candidate counts, and the ranked verdicts.
 */
const BASE = "http://localhost:3000";

const CASES = [
  { label: "generic earbuds", q: "wireless earbuds" },
  { label: "model number", q: "anker soundcore life q30" },
  { label: "capacity 20oz", q: "20oz insulated tumbler" },
  { label: "pack count", q: "usb c cable 3 pack" },
];

interface Signal {
  name: string;
  contribution: number;
  detail: string;
}
interface Contradiction {
  name: string;
  severity: string;
  cap: number;
  detail: string;
}
interface Candidate {
  confidence: number;
  confidenceBand: string;
  explanation: string;
  usWarehouseInventory: string | null;
  signals: Signal[];
  contradictions: Contradiction[];
  supplierProduct: {
    externalId: string;
    sku: string | null;
    title: string;
    supplierPrice: string | null;
    imageUrl: string | null;
  };
  foundByQueries: string[];
}
interface MatchResponse {
  status: string;
  error?: string;
  code?: string;
  marketplaceProduct: { title: string; price: string | null };
  queries: Array<{ query: string; count: number; failure: string | null }>;
  candidates: Candidate[];
}

for (const testCase of CASES) {
  // Resolve a fresh listing for this query, so the matcher always has a real,
  // currently-visible eBay item to work on. No limit is sent: this mirrors the
  // Product Scanner's own request (the route default page size), so the
  // matcher's re-resolve sees the same window.
  const searchParams = new URLSearchParams({ q: testCase.q });
  const searchResponse = await fetch(
    `${BASE}/api/marketplaces/ebay/search?${searchParams.toString()}`,
    { cache: "no-store" },
  );
  const searchPayload = (await searchResponse.json()) as {
    status: string;
    products?: Array<{ externalId: string }>;
  };
  const itemId = searchPayload.products?.[0]?.externalId;

  console.log("=".repeat(78));
  console.log(`CASE: ${testCase.label}  (q: "${testCase.q}")`);
  if (!itemId) {
    console.log(`  eBay search returned no listings for this query; skipping.`);
    continue;
  }

  const params = new URLSearchParams({ itemId, q: testCase.q });
  const response = await fetch(`${BASE}/api/products/matches?${params.toString()}`, {
    cache: "no-store",
  });
  const payload = (await response.json()) as MatchResponse;

  console.log(`eBay itemId: ${itemId}`);
  console.log(`eBay title: ${payload.marketplaceProduct?.title ?? "?"}`);
  console.log(`HTTP ${response.status}  status: ${payload.status}`);

  if (payload.status !== "ok") {
    console.log(`  ERROR ${payload.code}: ${payload.error}`);
    continue;
  }

  console.log("Generated CJ queries:");
  for (const query of payload.queries) {
    console.log(
      `  - "${query.query}" -> ${query.count} candidates${query.failure ? ` FAILURE: ${query.failure}` : ""}`,
    );
  }
  console.log(`Ranked candidates: ${payload.candidates.length}`);
  for (const [index, candidate] of payload.candidates.slice(0, 3).entries()) {
    console.log(
      `  #${index + 1} [${candidate.confidence}/${candidate.confidenceBand}] ${candidate.supplierProduct.title}`,
    );
    console.log(
      `      cost: ${candidate.supplierProduct.supplierPrice ?? "n/a"} · US inventory: ${candidate.usWarehouseInventory ?? "not queried"}`,
    );
    for (const signal of candidate.signals.slice(0, 3)) {
      console.log(`      +${signal.contribution} ${signal.name}: ${signal.detail}`);
    }
    for (const contradiction of candidate.contradictions) {
      console.log(
        `      - ${contradiction.severity} cap ${contradiction.cap} ${contradiction.name}: ${contradiction.detail}`,
      );
    }
    console.log(`      explanation: ${candidate.explanation}`);
  }

  const bands = payload.candidates.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.confidenceBand] = (acc[candidate.confidenceBand] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `Band distribution: ${Object.entries(bands).map(([band, count]) => `${band}=${count}`).join(", ") || "none"}`,
  );
}
