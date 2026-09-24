/**
 * Live Seller Scanner validation helper (run manually against a running server).
 *
 *   npm run build && npm run start
 *   node --import ./scripts/test-register.mjs ./scripts/live-seller-scanner.mts
 *
 * For real, deliberately un-cherry-picked seller + search-context pairs it asks
 * the Seller Scanner to compose a bounded seller-intelligence report end-to-end
 * — seller-scoped discovery, category intelligence, price distribution, product
 * concentration, recent listings, change detection, cross-seller overlap — and
 * prints what actually happened, section by section.
 *
 * The point is not to rank sellers. It is to prove, on live data, that the
 * scanner:
 *   - spends a bounded, auditable upstream budget per scan (`meta.upstreamCalls`);
 *   - treats every analysis as a sample and says so in prose (`limitations`);
 *   - degrades per component instead of losing the whole scan (`components`);
 *   - keeps observed catalog repetition distinct from any sales or demand claim;
 *   - refuses statistics rather than averaging across mixed currencies.
 *
 * Override the defaults with `SELLER_USERNAME` / `SELLER_QUERY`, e.g.
 *   $env:SELLER_USERNAME="musicmagpie"; $env:SELLER_QUERY="wireless earbuds"
 * then re-run the script. A second pair, and one deliberately unusable seller,
 * are included so the boundary's error vocabulary is exercised too.
 */

const BASE = "http://localhost:3000";
const SCAN_ENDPOINT = `${BASE}/api/sellers/scan`;

interface ScanPair {
  username: string;
  query: string;
}

const DEFAULT_USERNAME = process.env.SELLER_USERNAME ?? "musicmagpie";
const DEFAULT_QUERY = process.env.SELLER_QUERY ?? "wireless earbuds";

const PAIRS: ScanPair[] = [
  { username: DEFAULT_USERNAME, query: DEFAULT_QUERY },
  { username: DEFAULT_USERNAME, query: "sony wh-1000xm5" },
];

interface SellerScanLimits {
  sampleLimit: number;
  recentLimit: number;
  overlapWindow: number;
  overlapAnalyses: number;
}

interface SellerScan {
  seller: {
    externalSellerId: string;
    username: string | null;
    feedbackScore: number | null;
    feedbackPercentage: number | null;
    observedListingCount: number | null;
    sampledListingCount: number;
  };
  observedAt: string;
  listingSample: {
    sampledCount: number;
    observedTotal: number | null;
    limit: number;
    offset: number;
    contextQuery: string;
  };
  categories: {
    dominantCategory: { categoryId: string; categoryName: string; sharePercent: number } | null;
    distinctCategoryCount: number;
    sampledListingCount: number;
    limitation: string;
  };
  pricing: {
    currency: string | null;
    pricedCount: number;
    unpricedCount: number;
    min: string | null;
    max: string | null;
    median: string | null;
    mean: string | null;
    mixedCurrencies: boolean;
    currencies: string[];
    limitation: string | null;
  };
  concentration: {
    distinctTitleFamilies: number;
    maxFamilyCount: number;
    topFamilySharePercent: number;
    catalogBreadth: string;
    repeatedFamilies: Array<{ sampleTitle: string; listingCount: number }>;
    limitation: string;
  };
  recentListings: Array<{ externalId: string; title: string; price: string | null }> | null;
  listingChanges: {
    histories: Array<{
      externalId: string;
      title: string;
      status: string;
      changes: Array<{ kind: string; from: string | null; to: string | null }>;
    }>;
    availability: string;
    note: string;
  };
  crossSellerEvidence: Array<{
    seed: { title: string };
    discoveryQuery: string;
    observedListings: number;
    independentSellers: number;
    seedSellerPresent: boolean;
    confidenceBand: string;
    confidence: number;
    signals: Array<{ name: string; contribution: number }>;
    contradictions: string[];
  }>;
  components: Array<{ component: string; status: string; message?: string }>;
  limitations: string[];
  meta: {
    version: string;
    environment: string;
    limits: SellerScanLimits;
    upstreamCalls: { ebaySearch: number; supabaseWrites: number };
    elapsedMs: number;
  };
}

interface ScanSuccess {
  status: "ok";
  scan: SellerScan;
  timestamp: string;
}

interface ScanError {
  status: "error";
  error: string;
  code: string;
  timestamp: string;
  detail?: string;
}

type ScanResponse = ScanSuccess | ScanError;

async function postScan(body: unknown): Promise<ScanResponse> {
  const response = await fetch(SCAN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = (await response.json()) as ScanResponse;
  return payload;
}

function rule(): void {
  console.log("-".repeat(78));
}

function printScan(scan: SellerScan): void {
  const { seller } = scan;
  rule();
  console.log(
    `seller: ${seller.username ?? seller.externalSellerId} (${seller.externalSellerId})`,
  );
  console.log(
    `  feedback: ${seller.feedbackScore ?? "—"} · ${seller.feedbackPercentage ?? "—"}%` +
      ` · observed listings ${seller.observedListingCount ?? "—"} · sampled ${seller.sampledListingCount}`,
  );
  console.log(`  observed at ${scan.observedAt}`);

  const { listingSample } = scan;
  rule();
  console.log(
    `sample: ${listingSample.sampledCount} of ${listingSample.observedTotal ?? "—"} listings` +
      ` (limit ${listingSample.limit}, offset ${listingSample.offset}) for "${listingSample.contextQuery}"`,
  );

  const { categories } = scan;
  console.log(
    `categories: ${categories.distinctCategoryCount} distinct` +
      (categories.dominantCategory
        ? ` · dominant ${categories.dominantCategory.categoryName} (${categories.dominantCategory.sharePercent}%)`
        : " · no dominant category"),
  );
  console.log(`  ${categories.limitation}`);

  const { pricing } = scan;
  console.log(
    `pricing: ${pricing.pricedCount} priced / ${pricing.unpricedCount} unpriced` +
      ` · ${pricing.mixedCurrencies ? `mixed ${pricing.currencies.join(", ")}` : pricing.currency ?? "—"}`,
  );
  console.log(
    `  min ${pricing.min ?? "—"} · median ${pricing.median ?? "—"} · mean ${pricing.mean ?? "—"} · max ${pricing.max ?? "—"}`,
  );
  if (pricing.limitation) {
    console.log(`  ${pricing.limitation}`);
  }

  const { concentration } = scan;
  console.log(
    `concentration: ${concentration.distinctTitleFamilies} title families · breadth ${concentration.catalogBreadth}` +
      ` · top family ${concentration.topFamilySharePercent}%`,
  );
  concentration.repeatedFamilies.slice(0, 3).forEach((family) => {
    console.log(`  ×${family.listingCount}  ${family.sampleTitle}`);
  });
  console.log(`  ${concentration.limitation}`);

  console.log(
    `recent listings: ${scan.recentListings === null ? "unavailable (no creation date)" : scan.recentListings.length}`,
  );
  scan.recentListings?.slice(0, 3).forEach((listing) => {
    console.log(`  ${listing.price ?? "—"}  ${listing.title}`);
  });

  const { listingChanges } = scan;
  console.log(`changes: ${listingChanges.availability} · ${listingChanges.note}`);
  const changed = listingChanges.histories.filter(
    (history) => history.status !== "unchanged",
  );
  changed.slice(0, 3).forEach((history) => {
    console.log(`  ${history.status}  ${history.title}`);
    history.changes.forEach((change) => {
      console.log(`    ${change.kind}: ${change.from ?? "—"} → ${change.to ?? "—"}`);
    });
  });

  console.log(`cross-seller overlap: ${scan.crossSellerEvidence.length} analyses`);
  scan.crossSellerEvidence.slice(0, 3).forEach((evidence) => {
    console.log(
      `  ${evidence.confidenceBand} (${evidence.confidence}) · ${evidence.observedListings} listings` +
        ` / ${evidence.independentSellers} sellers · seed present ${evidence.seedSellerPresent}`,
    );
    console.log(`    seed: ${evidence.seed.title}`);
    console.log(`    query: "${evidence.discoveryQuery}"`);
    evidence.signals.forEach((signal) => {
      console.log(`    signal ${signal.contribution >= 0 ? "+" : ""}${signal.contribution}  ${signal.name}`);
    });
    evidence.contradictions.forEach((contradiction) => {
      console.log(`    contradiction: ${contradiction}`);
    });
  });

  console.log("components:");
  scan.components.forEach((component) => {
    console.log(`  ${component.status.padEnd(11)} ${component.component}${component.message ? ` — ${component.message}` : ""}`);
  });

  const { meta } = scan;
  console.log(
    `meta: ${meta.version} · ${meta.environment} · ${meta.elapsedMs}ms` +
      ` · ${meta.upstreamCalls.ebaySearch} eBay searches / ${meta.upstreamCalls.supabaseWrites} writes`,
  );
  console.log(
    `bounds: sample ${meta.limits.sampleLimit} · recent ${meta.limits.recentLimit}` +
      ` · overlap ${meta.limits.overlapAnalyses} analyses × ${meta.limits.overlapWindow} window`,
  );

  console.log("limitations:");
  scan.limitations.forEach((limitation) => console.log(`  - ${limitation}`));
}

async function runOne(pair: ScanPair): Promise<void> {
  console.log("");
  console.log("=".repeat(78));
  console.log(`SELLER: ${pair.username}   CONTEXT: ${pair.query}`);
  console.log("=".repeat(78));

  try {
    const payload = await postScan(pair);

    if (payload.status === "error") {
      console.log(`ERROR ${payload.code}: ${payload.error}`);
      if (payload.detail) {
        console.log(`  detail: ${payload.detail}`);
      }
      return;
    }

    printScan(payload.scan);
  } catch (error) {
    console.error(
      `SCAN FAILED for "${pair.username}":`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function main(): Promise<void> {
  console.log("Seller Scanner V1 — live validation");
  console.log(`Target: ${SCAN_ENDPOINT}`);
  console.log("Pairs are deliberately un-cherry-picked.");

  for (const pair of PAIRS) {
    await runOne(pair);
  }

  // A seller identifier the allowlist rejects, to prove the boundary reports it
  // instead of coercing, escaping, or silently scanning someone else.
  await runOne({ username: "not a valid handle!", query: DEFAULT_QUERY });

  // A search context with no usable characters, to prove the query bound is
  // enforced at the same boundary.
  await runOne({ username: DEFAULT_USERNAME, query: "   " });
}

void main();
