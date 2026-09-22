/**
 * Live Opportunity Engine validation helper (run manually against a running
 * server).
 *
 *   npx next start -p 3000
 *   node --import ./scripts/test-register.mjs ./scripts/live-opportunity.mts
 *
 * For each query it resolves a fresh eBay listing (eBay rotates results), runs
 * the bounded matcher to source a CJ candidate, then asks the Opportunity Engine
 * to assess that marketplace × supplier pair — exercising the real economics
 * pipeline, the replayed competition window, and the persisted-history read.
 *
 * The point is not to find profitable products; it is to prove that the engine
 * reports a real score, a separately computed confidence, honest caps, and —
 * importantly — an honest `persistence` outcome on live data. Until the
 * `opportunity_observations` migration is applied (docs/DATABASE.md §1.3), that
 * outcome reads `failed` while the assessment itself is still returned in full.
 */

const BASE = "http://localhost:3000";

const CASES = [
  { label: "generic earbuds", q: "wireless earbuds" },
  { label: "model number", q: "anker soundcore life q30" },
  { label: "capacity 20oz", q: "20oz insulated tumbler" },
  { label: "multi-variant (apparel)", q: "mens cotton t shirt" },
];

/**
 * The matcher re-resolves the eBay listing from its own search, and eBay rotates
 * results between calls — so the first search hit can vanish before the matcher
 * can confirm it. Try up to this many hits from the same search before giving up
 * on a query.
 */
const MAX_LISTING_ATTEMPTS = 3;

/**
 * The opportunity route replays the eBay search to re-prove the listing; eBay
 * reorders/rotates results between calls, so the same item can be missing from a
 * later 24-item window. Retry a few times before concluding it is gone.
 */
const ASSESSMENT_ATTEMPTS = 5;

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
interface AppliedCap {
  name: string;
  label: string;
  cap: number;
}
interface Components {
  economics: {
    score: number;
    completeness: string;
    estimatedProfit: string | null;
    marginPercent: number | null;
  };
  match: { score: number; confidence: number; confidenceBand: string };
  competition: { score: number; intensity: number; verdict: string };
  demand: { score: number; verdict: string };
  dataQuality: { score: number };
}
interface Assessment {
  engineVersion: string;
  marketplaceExternalId: string;
  supplierExternalId: string | null;
  score: number;
  band: string;
  confidence: number;
  confidenceLevel: string;
  components: Components;
  caps: AppliedCap[];
  headline: string;
  caveats: string[];
  inputs: { competitionQuery: string | null; historyAvailable: boolean };
}
interface PersistenceReport {
  status: "ok" | "disabled" | "failed";
  inserted?: boolean;
  message?: string;
}
interface OpportunityResponse {
  status: string;
  error?: string;
  code?: string;
  assessment?: Assessment;
  persistence?: PersistenceReport;
}


/** Fetches the route once and returns the parsed body plus the HTTP status. */
async function callOpportunity(
  params: URLSearchParams,
): Promise<{ httpStatus: number; body: OpportunityResponse }> {
  const response = await fetch(`${BASE}/api/products/opportunity?${params.toString()}`, {
    cache: "no-store",
  });
  const body = (await response.json()) as OpportunityResponse;
  return { httpStatus: response.status, body };
}

/** Prints one assessment in the shape the engine's contracts describe. */
function printAssessment(httpStatus: number, payload: OpportunityResponse): void {
  console.log(`HTTP ${httpStatus}  status: ${payload.status}`);
  if (payload.status !== "ok" || payload.assessment === undefined) {
    console.log(`  ERROR ${payload.code ?? "(no code)"}: ${payload.error}`);
    return;
  }
  const a = payload.assessment;
  const c = a.components;
  console.log(
    `score ${a.score} (${a.band})  confidence ${a.confidence} (${a.confidenceLevel})  engine ${a.engineVersion}`,
  );
  console.log(
    `  components: economics ${c.economics.score} (${c.economics.completeness}) · match ${c.match.score} (${c.match.confidenceBand} ${c.match.confidence})`,
  );
  console.log(
    `    competition ${c.competition.score} (${c.competition.intensity}, ${c.competition.verdict}) · demand ${c.demand.score} (${c.demand.verdict})`,
  );
  console.log(
    `    dataQuality ${c.dataQuality.score} · economics profit ${c.economics.estimatedProfit} · margin ${c.economics.marginPercent}`,
  );
  console.log(`  caps applied: ${a.caps.length}`);
  for (const cap of a.caps) {
    console.log(`    - ${cap.label} (cap ${cap.cap})`);
  }
  console.log(`  headline: ${a.headline}`);
  console.log(`  caveats: ${a.caveats.length}`);
  for (const caveat of a.caveats.slice(0, 3)) {
    console.log(`    - ${caveat}`);
  }
  console.log(
    `  inputs: competitionQuery "${a.inputs.competitionQuery}" · historyAvailable ${a.inputs.historyAvailable} · supplier ${a.supplierExternalId}`,
  );
  const p = payload.persistence;
  if (p === undefined) {
    console.log("  persistence: not reported (this deployment does not persist)");
  } else if (p.status === "ok") {
    console.log(`  persistence: ok, inserted=${p.inserted}`);
  } else {
    console.log(`  persistence: ${p.status}${p.message !== undefined ? ` - ${p.message}` : ""}`);
  }
}


// --- Assess each query against a real matched candidate ----------------------

let printedNoSupplierCase = false;

for (const testCase of CASES) {
  const searchParams = new URLSearchParams({ q: testCase.q });
  const searchResponse = await fetch(
    `${BASE}/api/marketplaces/ebay/search?${searchParams.toString()}`,
    { cache: "no-store" },
  );
  const searchPayload = (await searchResponse.json()) as {
    status: string;
    products?: Array<{ externalId: string; title: string }>;
  };
  const listings = searchPayload.products ?? [];

  console.log("=".repeat(78));
  console.log(`CASE: ${testCase.label}  (q: "${testCase.q}")`);
  if (listings.length === 0) {
    console.log("  eBay search returned no listings for this query; skipping.");
    continue;
  }

  // Walk the search results until one survives the matcher's re-resolution.
  let itemId = listings[0].externalId;
  let candidate: Candidate | null = null;
  for (const attempt of listings.slice(0, MAX_LISTING_ATTEMPTS)) {
    const matchParams = new URLSearchParams({ itemId: attempt.externalId, q: testCase.q });
    const matchResponse = await fetch(`${BASE}/api/products/matches?${matchParams.toString()}`, {
      cache: "no-store",
    });
    const matchPayload = (await matchResponse.json()) as MatchResponse;
    if (matchPayload.status === "ok" && matchPayload.candidates.length > 0) {
      itemId = attempt.externalId;
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
    `eBay ${itemId} -> CJ ${candidate.supplierProduct.externalId} (match ${candidate.confidenceBand} ${candidate.confidence})`,
  );

  // Named-supplier assessment: the main contract.
  const namedParams = new URLSearchParams({
    itemId,
    q: testCase.q,
    supplierProductId: candidate.supplierProduct.externalId,
  });
  let last: { httpStatus: number; body: OpportunityResponse } | null = null;
  for (let attempt = 1; attempt <= ASSESSMENT_ATTEMPTS; attempt++) {
    last = await callOpportunity(namedParams);
    if (last.body.status === "ok" || last.body.code !== "ITEM_NOT_RESOLVED") {
      break;
    }
    console.log(`  assessment attempt ${attempt}: item rotated out of the window; retrying`);
  }
  if (last === null) {
    continue;
  }
  printAssessment(last.httpStatus, last.body);

  // The unnamed-supplier contract runs once: with no `supplierProductId` the
  // route takes the matcher's best candidate itself, while a 404 is reserved for
  // a *named* supplier that is not a candidate.
  if (!printedNoSupplierCase) {
    printedNoSupplierCase = true;
    console.log("-".repeat(78));
    console.log("CONTRACT: same listing, no supplierProductId named");
    const unnamed = await callOpportunity(new URLSearchParams({ itemId, q: testCase.q }));
    printAssessment(unnamed.httpStatus, unnamed.body);
  }
}
