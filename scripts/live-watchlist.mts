/**
 * Live Watchlist validation helper (run manually against a running server).
 *
 *   npm run build && npm run start
 *   node --import ./scripts/test-register.mjs ./scripts/live-watchlist.mts
 *
 * It takes one real, deliberately un-cherry-picked eBay x CJ opportunity that the
 * scanner has just evaluated end-to-end, and walks the whole watchlist contract
 * against live Supabase storage:
 *
 *   save (inserted) -> repeat save (reused, same id) -> list (present, filters
 *   echo) -> history (>= 1 stored observation) -> re-evaluate (fresh verdict,
 *   comparison against the previous observation, persisted) -> re-evaluate again
 *   (deltas) -> marketplace-only save of the same listing (a *different* entry:
 *   a pair and a marketplace-only watch are two distinct scopes) -> a safe
 *   not-found re-evaluation (reported, not thrown) -> archive (entry gone from
 *   the list, history kept) -> re-evaluation of an archived scope (refused, not
 *   implied) -> re-save of the freed scope (inserted again).
 *
 * Every entry this script creates is archived at the end, so a validation run
 * leaves the watchlist as it found it. The point is not to build a watchlist; it
 * is to prove that the boundary's invariants hold on live, rotating data.
 */

const BASE = "http://localhost:3000";
const SCAN_ENDPOINT = `${BASE}/api/scanner/scan`;
const LIST_ENDPOINT = `${BASE}/api/watchlist`;

/**
 * Un-cherry-picked queries spanning the shapes the scanner must survive. The
 * script walks them in order until one yields an evaluated marketplace x
 * supplier pair, because a watch can only be saved for a scope the scanner has
 * already observed.
 */
const QUERIES = [
  "wireless earbuds",
  "anker soundcore life q30",
  "mens cotton t shirt",
];

// --- Boundary contracts (mirrors src/types/watchlist.ts; kept local on purpose)

interface WatchlistEntryRow {
  id: string;
  marketplaceExternalId: string;
  supplierExternalId: string | null;
  replayQuery: string;
  label: string | null;
}
interface WatchlistEntryDetail {
  entry: WatchlistEntryRow;
  marketplace: { title: string | null; price: string | null; currency: string | null; observedAt: string | null } | null;
  supplier: { title: string | null; referenceCost: string | null; currency: string | null; observedAt: string | null } | null;
  assessment: {
    score: number;
    band: string;
    confidence: number;
    confidenceLevel: string;
    profit: string | null;
    marginPercent: number | null;
    calculatedAt: string;
  } | null;
  assessmentCount: number;
}
interface PersistenceReport {
  status: "ok" | "disabled" | "failed";
  inserted?: boolean;
  message?: string;
}
interface NumericDelta {
  label: string;
  previous: string | null;
  current: string | null;
  delta: string | null;
  direction: string;
}
interface AssessmentComparison {
  previousCalculatedAt: string | null;
  noPrevious: boolean;
  numeric: NumericDelta[];
  categorical: { label: string; previous: string | null; current: string | null; changed: boolean }[];
}
interface AddResponse {
  status: "ok";
  action: "inserted" | "reused";
  entry: WatchlistEntryDetail;
  timestamp: string;
}
interface ErrorResponse {
  status: "error";
  error: string;
  code: string;
  detail?: string;
  timestamp: string;
}
interface ListResponse {
  status: "ok";
  entries: WatchlistEntryDetail[];
  limit: number;
  sort: string;
  filters: Record<string, string>;
  total: number;
  timestamp: string;
}
interface HistoryResponse {
  status: "ok";
  history: Array<{
    calculatedAt: string;
    score: number;
    band: string;
    profit: string | null;
    marginPercent: number | null;
    caveats: string[];
  }>;
  limit: number;
  timestamp: string;
}
interface ReEvaluateResponse {
  status: "ok";
  outcome: string;
  result: {
    entryId: string;
    outcome: string;
    failureCode?: string;
    failureMessage?: string;
    persistence?: PersistenceReport;
    evaluatedAt: string;
    durationMs: number;
  };
  assessment?: { score: number; band: string; confidence: number; confidenceLevel: string };
  comparison?: AssessmentComparison | null;
  timestamp: string;
}
interface ArchiveResponse {
  status: "ok";
  action: "archived" | "already-archived";
  entryId: string;
  timestamp: string;
}
interface ScanItem {
  outcome: string;
  marketplaceProduct: { externalId: string; title: string } | null;
  candidate: { supplierProduct: { externalId: string; title: string } } | null;
  persistence?: PersistenceReport;
}
interface ScanResponse {
  status: string;
  code?: string;
  meta: { query: string; evaluatedCount: number; failedCount: number; durationMs: number };
  results: ScanItem[];
  failures: ScanItem[];
}

// --- Small shared helpers ----------------------------------------------------

let failures = 0;

/** Prints a labelled check; the run reports a failure count at the end. */
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) {
    failures += 1;
  }
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail !== "" ? ` — ${detail}` : ""}`);
}

/** One boundary call; returns the HTTP status and the parsed body. */
async function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, cache: "no-store" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  return { httpStatus: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Saves a scope, printing the boundary's verdict. */
async function save(input: {
  marketplaceExternalId: string;
  supplierExternalId?: string;
  replayQuery: string;
  label?: string;
}): Promise<{ httpStatus: number; body: AddResponse | ErrorResponse }> {
  const result = await request("POST", LIST_ENDPOINT, input);
  return { httpStatus: result.httpStatus, body: result.body as unknown as AddResponse | ErrorResponse };
}

/** Reads the history of one entry, archived or not. */
async function readHistory(
  entryId: string,
): Promise<{ httpStatus: number; body: HistoryResponse | ErrorResponse }> {
  const result = await request("GET", `${LIST_ENDPOINT}/${entryId}/history`);
  return { httpStatus: result.httpStatus, body: result.body as unknown as HistoryResponse | ErrorResponse };
}

/** Re-evaluates one entry; the browser posts nothing but the id. */
async function reEvaluate(
  entryId: string,
): Promise<{ httpStatus: number; body: ReEvaluateResponse | ErrorResponse }> {
  const result = await request("POST", `${LIST_ENDPOINT}/${entryId}/re-evaluate`, {});
  return { httpStatus: result.httpStatus, body: result.body as unknown as ReEvaluateResponse | ErrorResponse };
}

/**
 * Archives one entry this script created. Already-archived is the desired state,
 * so only a genuine failure is reported.
 */
async function archive(entryId: string): Promise<void> {
  const result = await request("POST", `${LIST_ENDPOINT}/${entryId}/archive`, {});
  const body = result.body as unknown as ArchiveResponse | ErrorResponse;
  if (body.status === "error") {
    console.log(`  cleanup: could not archive ${entryId} (${body.code})`);
  }
}

/**
 * Scans the queries in order until one yields an evaluated marketplace x
 * supplier pair — the only scope a pair watch can be saved for, since a save is
 * refused for an identity that was never observed (NOT_OBSERVED).
 */
async function findEvaluatedOpportunity(): Promise<{
  itemId: string;
  supplierId: string;
  query: string;
  title: string;
} | null> {
  for (const query of QUERIES) {
    const result = await request("POST", SCAN_ENDPOINT, { query, mode: "batch" });
    const body = result.body as unknown as ScanResponse | ErrorResponse;
    if (result.httpStatus !== 200 || body.status !== "ok") {
      console.log(`  scan for "${query}" was not ok (${body.code ?? "?"}); next query`);
      continue;
    }
    console.log(
      `  scanned "${query}" in ${body.meta.durationMs}ms: ${body.meta.evaluatedCount} evaluated, ${body.meta.failedCount} failed`,
    );
    for (const item of body.results) {
      if (
        item.outcome !== "evaluated" ||
        item.marketplaceProduct === null ||
        item.candidate === null
      ) {
        continue;
      }
      return {
        itemId: item.marketplaceProduct.externalId,
        supplierId: item.candidate.supplierProduct.externalId,
        query,
        title: item.marketplaceProduct.title,
      };
    }
    console.log(`  no evaluated pair came out of "${query}"; next query`);
  }
  return null;
}

/** Prints the one-line summary an entry card would show. */
function printEntry(detail: WatchlistEntryDetail): void {
  const scope = detail.entry.supplierExternalId === null ? "marketplace-only" : "pair";
  const price =
    detail.marketplace === null
      ? "—"
      : `${detail.marketplace.price ?? "?"} ${detail.marketplace.currency ?? ""}`.trim();
  const assessment =
    detail.assessment === null
      ? "no assessment yet"
      : `score ${detail.assessment.score} (${detail.assessment.band}), confidence ${detail.assessment.confidence} (${detail.assessment.confidenceLevel}), profit ${detail.assessment.profit ?? "—"}, margin ${detail.assessment.marginPercent ?? "—"}%`;
  console.log(
    `    ${detail.entry.id} [${scope}] "${detail.marketplace?.title ?? detail.entry.marketplaceExternalId}" price ${price} · ${assessment} · ${detail.assessmentCount} stored`,
  );
}

async function main(): Promise<void> {
  console.log("Watchlist V1 — live validation");
  console.log(`Target: ${LIST_ENDPOINT}`);
  console.log("Queries are deliberately un-cherry-picked.");

  /** Every entry this run creates, archived at the end. */
  const created: string[] = [];

  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 0 — find a real, evaluated opportunity to watch");
  console.log("=".repeat(78));
  const opportunity = await findEvaluatedOpportunity();
  if (opportunity === null) {
    console.log("  No query produced an evaluated pair; nothing to validate against.");
    return;
  }
  console.log(
    `  watching eBay ${opportunity.itemId} x CJ ${opportunity.supplierId} (query "${opportunity.query}")`,
  );

  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 1 — save the pair scope, then save the same scope again");
  console.log("=".repeat(78));
  const pairInput = {
    marketplaceExternalId: opportunity.itemId,
    supplierExternalId: opportunity.supplierId,
    replayQuery: opportunity.query,
    label: "live-watchlist validation",
  };
  const first = await save(pairInput);
  check(
    "the first save is inserted",
    first.body.status === "ok" && first.body.action === "inserted",
    first.body.status === "error"
      ? `${first.body.code} — ${first.body.error}`
      : `action=${first.body.action}`,
  );
  if (first.body.status !== "ok") {
    console.log("  Nothing could be watched, so the rest of the contract cannot be exercised.");
    return;
  }
  const pairEntryId = first.body.entry.entry.id;
  created.push(pairEntryId);
  printEntry(first.body.entry);
  check(
    "the saved entry echoes the exact scope and note, nothing more",
    first.body.entry.entry.marketplaceExternalId === opportunity.itemId &&
      first.body.entry.entry.supplierExternalId === opportunity.supplierId &&
      first.body.entry.entry.replayQuery === opportunity.query &&
      first.body.entry.entry.label === pairInput.label,
  );

  const second = await save(pairInput);
  check(
    "a repeat save reuses the same entry (idempotent)",
    second.body.status === "ok" &&
      second.body.action === "reused" &&
      second.body.entry.entry.id === pairEntryId,
    second.body.status === "error" ? second.body.code : `action=${second.body.action}`,
  );

  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 2 — the list shows the entry and echoes the bounds applied");
  console.log("=".repeat(78));
  const listParams = new URLSearchParams({
    limit: "50",
    sort: "score",
    supplierScope: "pair",
  });
  const listResult = await request("GET", `${LIST_ENDPOINT}?${listParams.toString()}`);
  const listBody = listResult.body as unknown as ListResponse | ErrorResponse;
  check(
    "the sorted, filtered list contains the saved entry",
    listBody.status === "ok" && listBody.entries.some((entry) => entry.entry.id === pairEntryId),
    listBody.status === "error" ? listBody.code : `${listBody.entries.length} of ${listBody.total} active`,
  );
  check(
    "the list echoes the sort and filter actually applied",
    listBody.status === "ok" &&
      listBody.sort === "score" &&
      listBody.filters.supplierScope === "pair" &&
      listBody.limit === 50,
    listBody.status === "ok" ? JSON.stringify({ ...listBody.filters, sort: listBody.sort }) : listBody.code,
  );
  if (listBody.status === "ok") {
    listBody.entries.forEach(printEntry);
  }

  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 3 — the stored history of the watched scope");
  console.log("=".repeat(78));
  const historyFirst = await readHistory(pairEntryId);
  const historyFirstBody = historyFirst.body as HistoryResponse | ErrorResponse;
  const baseline = historyFirstBody.status === "ok" ? historyFirstBody.history.length : null;
  check(
    "history reports the observation the scan already stored",
    historyFirstBody.status === "ok" && historyFirstBody.history.length >= 1,
    historyFirstBody.status === "error"
      ? historyFirstBody.code
      : `${historyFirstBody.history.length} stored`,
  );
  if (historyFirstBody.status === "ok" && historyFirstBody.history.length > 0) {
    const latest = historyFirstBody.history[0];
    console.log(
      `    most recent: score ${latest.score} (${latest.band}) at ${latest.calculatedAt}`,
    );
  }

  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 4 — re-evaluate twice; each call is a deliberate, bounded action");
  console.log("=".repeat(78));
  const verdictOutcomes = new Set(["evaluated", "no-candidates", "economics-unavailable"]);
  const firstRe = await reEvaluate(pairEntryId);
  const firstReBody = firstRe.body as ReEvaluateResponse | ErrorResponse;
  check(
    "a re-evaluation resolves to a verdict outcome",
    firstReBody.status === "ok" && verdictOutcomes.has(firstReBody.outcome),
    firstReBody.status === "error"
      ? `${firstReBody.code} — ${firstReBody.error}`
      : firstReBody.outcome,
  );
  if (firstReBody.status === "ok") {
    const comparison = firstReBody.comparison ?? null;
    check(
      "the comparison is anchored on the previous observation",
      comparison !== null && comparison.noPrevious === false,
      comparison === null
        ? "no comparison returned"
        : `previous ${comparison.previousCalculatedAt ?? "—"}`,
    );
    const persistence = firstReBody.result.persistence;
    check(
      "the fresh assessment is persisted honestly",
      persistence !== undefined && persistence.status === "ok",
      persistence === undefined ? "persistence not reported" : persistence.status,
    );
    console.log(
      `    ${firstReBody.outcome} in ${firstReBody.result.durationMs}ms — score ${firstReBody.assessment?.score ?? "?"} (${firstReBody.assessment?.band ?? "?"})` +
        (persistence !== undefined && persistence.status === "ok"
          ? `, persisted (inserted=${persistence.inserted ?? false})`
          : ""),
    );
  }

  const secondRe = await reEvaluate(pairEntryId);
  const secondReBody = secondRe.body as ReEvaluateResponse | ErrorResponse;
  if (secondReBody.status === "ok") {
    const moved = (secondReBody.comparison?.numeric ?? []).filter(
      (delta) => delta.direction !== "unchanged",
    );
    console.log(
      `    second re-evaluation: ${secondReBody.outcome} in ${secondReBody.result.durationMs}ms; ${moved.length} numeric field(s) moved since the previous observation`,
    );
    moved.slice(0, 5).forEach((delta) =>
      console.log(
        `      ${delta.label}: ${delta.previous ?? "—"} -> ${delta.current ?? "—"} (${delta.delta ?? "n/a"})`,
      ),
    );
  } else {
    console.log(
      `    second re-evaluation was not ok: ${secondReBody.code} — ${secondReBody.error}`,
    );
  }

  const historySecond = await readHistory(pairEntryId);
  const historySecondBody = historySecond.body as HistoryResponse | ErrorResponse;
  check(
    "history never loses stored observations",
    historySecondBody.status === "ok" && baseline !== null && historySecondBody.history.length >= baseline,
    historySecondBody.status === "ok"
      ? baseline !== null
        ? `${baseline} -> ${historySecondBody.history.length}`
        : "no baseline"
      : historySecondBody.code,
  );

  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 5 — the same listing, watched marketplace-only, is a separate entry");
  console.log("=".repeat(78));
  const marketOnly = await save({
    marketplaceExternalId: opportunity.itemId,
    replayQuery: opportunity.query,
  });
  check(
    "a marketplace-only save is inserted",
    marketOnly.body.status === "ok" && marketOnly.body.action === "inserted",
    marketOnly.body.status === "error"
      ? `${marketOnly.body.code} — ${marketOnly.body.error}`
      : `action=${marketOnly.body.action}`,
  );
  if (marketOnly.body.status === "ok") {
    created.push(marketOnly.body.entry.entry.id);
    printEntry(marketOnly.body.entry);
    check(
      "the pair and the marketplace-only scope have different entry ids",
      marketOnly.body.entry.entry.id !== pairEntryId,
    );
    check(
      "the marketplace-only scope stores a NULL supplier, never a wildcard",
      marketOnly.body.entry.entry.supplierExternalId === null,
    );
  }
  const both = await request("GET", `${LIST_ENDPOINT}?limit=50`);
  const bothBody = both.body as unknown as ListResponse | ErrorResponse;
  if (bothBody.status === "ok") {
    const scopes = bothBody.entries.filter(
      (entry) => entry.entry.marketplaceExternalId === opportunity.itemId,
    );
    check(
      "both scopes of the same listing appear in the list",
      scopes.length >= 2,
      `${scopes.length} entries for this listing`,
    );
  }

  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 6 — a re-evaluation of an unknown id is reported, never thrown");
  console.log("=".repeat(78));
  const ghost = await reEvaluate("00000000-0000-4000-8000-000000000000");
  const ghostBody = ghost.body as ReEvaluateResponse | ErrorResponse;
  check(
    "a well-formed unknown id answers entry-not-found (404)",
    ghost.httpStatus === 404 &&
      ghostBody.status === "ok" &&
      ghostBody.outcome === "entry-not-found",
    ghostBody.status === "error"
      ? `${ghostBody.code} — ${ghostBody.error}`
      : `${ghost.httpStatus} ${ghostBody.outcome}`,
  );
  const malformed = await reEvaluate("not-a-uuid");
  const malformedBody = malformed.body as ReEvaluateResponse | ErrorResponse;
  check(
    "a malformed id is refused at the boundary (400)",
    malformed.httpStatus === 400 && malformedBody.status === "error",
    malformedBody.status === "error"
      ? malformedBody.code
      : `${malformed.httpStatus} ${malformedBody.outcome}`,
  );

  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 7 — archive: the entry leaves the list, its history stays");
  console.log("=".repeat(78));
  const archived = await request("POST", `${LIST_ENDPOINT}/${pairEntryId}/archive`, {});
  const archivedBody = archived.body as unknown as ArchiveResponse | ErrorResponse;
  check(
    "archiving reports the archived action",
    archivedBody.status === "ok" && archivedBody.action === "archived",
    archivedBody.status === "error" ? archivedBody.code : archivedBody.action,
  );
  const afterArchive = await request("GET", `${LIST_ENDPOINT}?limit=50`);
  const afterArchiveBody = afterArchive.body as unknown as ListResponse | ErrorResponse;
  check(
    "the archived entry is gone from the active list",
    afterArchiveBody.status === "ok" &&
      !afterArchiveBody.entries.some((entry) => entry.entry.id === pairEntryId),
    afterArchiveBody.status === "ok" ? `${afterArchiveBody.entries.length} active` : afterArchiveBody.code,
  );
  const archivedHistory = await readHistory(pairEntryId);
  const archivedHistoryBody = archivedHistory.body as HistoryResponse | ErrorResponse;
  check(
    "the archived scope's history is still readable",
    archivedHistoryBody.status === "ok" && archivedHistoryBody.history.length >= 1,
    archivedHistoryBody.status === "error"
      ? archivedHistoryBody.code
      : `${archivedHistoryBody.history.length} rows`,
  );
  const archivedRe = await reEvaluate(pairEntryId);
  const archivedReBody = archivedRe.body as ReEvaluateResponse | ErrorResponse;
  check(
    "re-evaluating an archived scope is refused, not implied (409)",
    archivedRe.httpStatus === 409 &&
      archivedReBody.status === "ok" &&
      archivedReBody.outcome === "archived",
    archivedReBody.status === "error"
      ? archivedReBody.code
      : `${archivedRe.httpStatus} ${archivedReBody.outcome}`,
  );

  console.log("");
  console.log("=".repeat(78));
  console.log("STEP 8 — archiving frees the scope, so it can be watched again");
  console.log("=".repeat(78));
  const reSaved = await save(pairInput);
  check(
    "the freed scope is inserted as a fresh entry",
    reSaved.body.status === "ok" &&
      reSaved.body.action === "inserted" &&
      reSaved.body.entry.entry.id !== pairEntryId,
    reSaved.body.status === "error"
      ? `${reSaved.body.code} — ${reSaved.body.error}`
      : `action=${reSaved.body.action}`,
  );
  if (reSaved.body.status === "ok") {
    created.push(reSaved.body.entry.entry.id);
  }

  console.log("");
  console.log("=".repeat(78));
  console.log(`CLEANUP — archiving the ${created.length} entries this run created`);
  console.log("=".repeat(78));
  for (const entryId of created) {
    await archive(entryId);
  }
  console.log("  the watchlist is as this script found it");

  console.log("");
  if (failures === 0) {
    console.log("Watchlist V1 live validation: all checks ok.");
  } else {
    console.log(
      `Watchlist V1 live validation: ${failures} check(s) FAILED — see the [FAIL] lines above.`,
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
