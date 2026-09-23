/**
 * Live Opportunity Scanner validation helper (run manually against a running
 * server).
 *
 *   npm run build && npm run start
 *   node --import ./scripts/test-register.mjs ./scripts/live-scanner.mts
 *
 * For three real, deliberately un-cherry-picked queries it asks the scanner to
 * deep-evaluate a bounded batch of live eBay listings end-to-end — discovery,
 * matcher, economics, Opportunity Engine, persistence, ranking — and prints what
 * actually happened, item by item.
 *
 * The point is not to find profitable products. It is to prove, on live data,
 * that the scanner:
 *   - spends a bounded, auditable upstream budget per scan;
 *   - reports a real score and a separately computed confidence for each item;
 *   - isolates failures per listing instead of losing the whole scan;
 *   - reports persistence honestly (until the `opportunity_observations`
 *     migration lands, an item's `persistence.status` may read `failed` while
 *     its assessment is still returned in full — see docs/DATABASE.md §1.3);
 *   - ranks deterministically, with the tie-breakers visible in the output.
 */

const BASE = "http://localhost:3000";
const SCAN_ENDPOINT = `${BASE}/api/scanner/scan`;

/**
 * Un-cherry-picked queries spanning the shapes the scanner must survive:
 * generic, model-number-specific, and a multi-variant category.
 */
const QUERIES = [
  "wireless earbuds",
  "anker soundcore life q30",
  "mens cotton t shirt",
];

interface ScanItem {
  discoveryIndex: number;
  marketplaceProduct: {
    externalId: string;
    title: string;
    price: string | null;
    currency: string | null;
  } | null;
  requestedItemId?: string;
  candidate: {
    confidence: number;
    confidenceBand: string;
    supplierProduct: { externalId: string; title: string; supplierPrice: string | null };
  } | null;
  economics: {
    estimatedProfit: string | null;
    marginPercent: string | null;
    completeness: string;
  } | null;
  assessment: {
    score: number;
    band: string;
    confidence: number;
    confidenceLevel: string;
    headline: string;
    caveats: string[];
  } | null;
  outcome: string;
  failureCode?: string;
  failureMessage?: string;
  persistence?: { status: string; inserted?: boolean; message?: string };
  durationMs: number;
}

interface ScanResponse {
  status: string;
  error?: string;
  code?: string;
  meta: {
    scannerVersion: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    query: string;
    mode: string;
    discoveryCount: number;
    selectedCount: number;
    evaluatedCount: number;
    failedCount: number;
    destinationLabel: string;
    limits: {
      discoveryLimit: number;
      maxEvaluations: number;
      concurrency: number;
      deadlineMs: number;
    };
  };
  results: ScanItem[];
  failures: ScanItem[];
  timestamp: string;
}

async function postJson(body: unknown): Promise<ScanResponse> {
  const response = await fetch(SCAN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = (await response.json()) as ScanResponse;
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} (${payload.code ?? "unknown"}): ${payload.error ?? "no message"}`,
    );
  }
  return payload;
}

function printItem(item: ScanItem, rank?: number): void {
  const rankPrefix = rank === undefined ? "  " : `#${rank} `;
  const title = item.marketplaceProduct?.title ?? item.requestedItemId ?? "unknown";
  console.log(`${rankPrefix}${title}`);
  console.log(`     outcome: ${item.outcome}`);
  if (item.assessment) {
    console.log(
      `     score ${item.assessment.score}/100 (${item.assessment.band}) · confidence ${item.assessment.confidence}/100 (${item.assessment.confidenceLevel})`,
    );
    console.log(`     headline: ${item.assessment.headline}`);
  }
  if (item.candidate) {
    console.log(
      `     candidate: ${item.candidate.supplierProduct.title} — ${item.candidate.supplierProduct.supplierPrice} · match ${item.candidate.confidence}/100 (${item.candidate.confidenceBand})`,
    );
  }
  if (item.economics) {
    console.log(
      `     economics: ${item.economics.completeness} · profit ${item.economics.estimatedProfit ?? "—"} · margin ${item.economics.marginPercent ?? "—"}%`,
    );
  }
  if (item.failureMessage) {
    console.log(`     failure: ${item.failureCode ?? "—"} — ${item.failureMessage}`);
  }
  if (item.persistence) {
    const insert =
      item.persistence.status === "ok"
        ? ` · inserted=${item.persistence.inserted}`
        : item.persistence.status === "failed"
          ? ` · ${item.persistence.message ?? "no detail"}`
          : "";
    console.log(`     persistence: ${item.persistence.status}${insert}`);
  }
  console.log(`     took ${item.durationMs}ms`);
}

async function runOne(
  query: string,
  mode: "batch" | "manual",
  itemIds?: string[],
): Promise<void> {
  console.log("");
  console.log("=".repeat(78));
  console.log(`QUERY: ${query}   (mode: ${mode})`);
  console.log("=".repeat(78));

  try {
    const payload = await postJson(
      itemIds ? { query, mode, itemIds } : { query, mode },
    );
    const { meta } = payload;

    console.log(
      `scan ${payload.status} · ${meta.scannerVersion} · ${meta.durationMs}ms wall-clock`,
    );
    console.log(
      `budget: discovery ${meta.limits.discoveryLimit} · evaluations ${meta.limits.maxEvaluations} · concurrency ${meta.limits.concurrency} · deadline ${meta.limits.deadlineMs}ms`,
    );
    console.log(
      `counts: ${meta.discoveryCount} discovered · ${meta.selectedCount} selected · ${meta.evaluatedCount} assessed · ${meta.failedCount} failed · ${meta.destinationLabel}`,
    );
    console.log(`window: ${meta.startedAt} → ${meta.completedAt}`);

    console.log("");
    console.log("-- ranked verdicts --");
    if (payload.results.length === 0) {
      console.log("  (none)");
    }
    payload.results.forEach((item, index) => printItem(item, index + 1));

    if (payload.failures.length > 0) {
      console.log("");
      console.log("-- failures (isolated, reported per item) --");
      payload.failures.forEach((item) => printItem(item));
    }
  } catch (error) {
    console.error(
      `SCAN FAILED for "${query}":`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function main(): Promise<void> {
  console.log("Opportunity Scanner V1 — live validation");
  console.log(`Target: ${SCAN_ENDPOINT}`);
  console.log("Queries are deliberately un-cherry-picked.");

  // Batch mode: the server picks the batch deterministically.
  for (const query of QUERIES) {
    await runOne(query, "batch");
  }

  // Manual mode: pick real ids from the last discovery window of the last query
  // so the browser→server id path is exercised against live, rotating results.
  const discovery = await fetch(
    `${BASE}/api/marketplaces/ebay/search?q=${encodeURIComponent(QUERIES[QUERIES.length - 1])}`,
    { cache: "no-store" },
  );
  const discoveryPayload = (await discovery.json()) as {
    products: Array<{ externalId: string }>;
  };
  const manualIds = discoveryPayload.products
    .slice(0, 3)
    .map((product) => product.externalId);
  // Plus one that cannot resolve, to prove the scanner reports it instead of
  // matching blindly or aborting the batch.
  manualIds.push("v1|definitely-not-in-this-window");

  await runOne(QUERIES[QUERIES.length - 1], "manual", manualIds);
}

void main();

