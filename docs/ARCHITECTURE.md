# Inkora — Architecture

> **Status: Authoritative (concept level).** This document defines architecture
> principles and conceptual responsibilities. It deliberately does **not** fix a
> framework choice or a full production schema — those come later, one reviewed
> increment at a time.

## 1. Guiding principles

1. **Separate acquisition from intelligence.** Code that talks to a marketplace
   or supplier knows nothing about opportunity scoring. Code that scores
   opportunities knows nothing about HTTP/token specifics.
2. **Normalize, then reason.** External data is converted into Inkora's
   internal model exactly once; all downstream logic operates on normalized
   entities.
3. **Deterministic economics.** Money math is code, never LLM-generated.
4. **Provenance is a first-class citizen.** Every quantitative value knows
   whether it is OFFICIAL, OBSERVED, or ESTIMATED.
5. **History is an asset.** The platform must not depend solely on live API
   responses.
6. **Do not over-engineer what is not yet required.** Interfaces are documented
   conceptually; build only the adapter currently needed.

## 2. Technology stack

The application stack was resolved in the application-foundation task, using the
official Next.js scaffolding toolchain. It is deliberately conservative and
production-oriented.

| Concern | Choice |
| --- | --- |
| Web framework | **Next.js** (App Router) |
| Language | **TypeScript** |
| Styling | **Tailwind CSS** |
| Package manager | **npm** |
| Linting | **ESLint** (flat config, `eslint-config-next`) |
| Database / backend | **Supabase (PostgreSQL)** |
| Source control | GitHub |
| Domain | inkora.net |
| Runtime | Node.js |

### 2.1 Server / client boundary

- **Server Components by default.** A `"use client"` directive is added only
  where browser interactivity genuinely requires it (for example navigation
  state derived from the current route).
- **Sensitive integrations belong on the server.** eBay secrets, CJ credentials,
  AI API keys, and Supabase service-role operations must never be bundled into
  client-side JavaScript.
- Server-only modules import the `server-only` package, so any attempt to pull
  them into a Client Component fails at build time.
- Credentials are read from environment variables only; variables holding
  private credentials never use the `NEXT_PUBLIC_` prefix
  (see `.env.example`).

### 2.2 Verified Supabase connectivity

Inkora's Next.js server reaches Supabase through **one** privileged server-side
boundary, and this connectivity has been verified end-to-end against the live
project — not merely inferred from environment variables or client
construction.

```text
Next.js server process
  → src/lib/supabase/server.ts   (import "server-only", service-role key)
  → live Supabase project (PostgreSQL)
```

Verified facts:

- The browser client (`src/lib/supabase/client.ts`) uses **only**
  `NEXT_PUBLIC_*` values (project URL + anon key). It never sees the
  service-role key or `SUPABASE_DB_URL`.
- The server client uses the **service-role key**, read from a non-prefixed
  variable inside a `server-only` module, so it cannot leak into a client
  bundle.
- `GET /api/health/db` performs a real, benign, read-only round-trip to the
  live project and reports only a coarse verdict
  (`reachable` / `unreachable`).
- `GET /api/health` (application process health) is **independent of Supabase**.
  A database outage degrades `/api/health/db` but must never make
  `/api/health` fail.

This connectivity has been exercised against the live Inkora project (project
ref `yvpkldzhbcxsslftettw`): with a populated `.env.local`, `GET
/api/health/db` returns `{"database":"reachable"}` over HTTP, confirming a
genuine privileged server-side round-trip with the service-role key — not a
static or mocked response.

### 2.3 Health endpoints — separation of concerns

| Endpoint | Answers | Depends on Supabase? |
| --- | --- | --- |
| `GET /api/health` | Is the Inkora application process healthy? | **No** |
| `GET /api/health/db` | Can the Inkora server reach its Supabase database? | **Yes** |

Both responses are sanitized: no raw errors, hostnames, ports, connection
strings, SQL, credentials, or stack traces are ever returned.

### 2.4 Migration ownership

**GitHub is the source of truth for schema.** Migration files live in
`supabase/migrations/`, are committed and reviewed like any other code, and are
applied to the remote database in order. The remote database is never hand-edited
into a state that the committed migrations cannot reproduce. See
`docs/DATABASE.md`.

## 3. The core pipeline

```text
Marketplace data
  → normalized product intelligence
  → supplier matching
  → economics
  → opportunity scoring
```

Every stage is observable, testable, and replayable. Raw inputs are retained so
any downstream number can be re-derived later.

## 4. Marketplace integrations — `MarketplaceAdapter`

A marketplace adapter is responsible *only* for:

- authenticating to the marketplace,
- fetching raw listing/product/seller data,
- normalizing that data into Inkora's internal marketplace model,
- honoring pagination, rate limits, retries, and freshness rules,
- attaching **provenance** and a `last_updated` timestamp to everything it
  emits.

Marketplace-specific logic must never leak into core domain services.

### 4.1 Implemented — `EbayAdapter`

The first concrete adapter exists and is exercised against the official eBay
API (see `docs/API_INTEGRATIONS.md` §2.1 for endpoint and authentication
detail):

```text
src/lib/marketplace/types.ts     MarketplaceAdapter interface + normalized
                                 MarketplaceProduct model (pure types)
src/lib/ebay/config.ts           environment → eBay configuration (server-only)
src/lib/ebay/oauth.ts            OAuth2 client-credentials token + cache
src/lib/ebay/browse-api.ts       official Browse API search call (server-only)
src/lib/ebay/ebay-adapter.ts     EbayAdapter: eBay response → normalized model
```

Every module under `src/lib/ebay/` imports `server-only`, so any attempt to
pull eBay specifics into a Client Component fails at build time.

### 4.2 Server API boundary and the browser trust line

The browser never touches a marketplace. The one and only path from the UI to
eBay is a server-side route:

```text
Product Scanner (browser)
  → GET /api/marketplaces/ebay/search?q=…        (validation + rate guard)
  → EbayAdapter.search()
  → eBay Browse API (official, authenticated)
  → normalized MarketplaceProduct[]
  → safe JSON response
```

The route validates and bounds the request (non-empty query of ≤ 100
characters, `limit` clamped to 1–50, offset bounded), forces a fresh
round-trip on every call (`force-dynamic`, `Cache-Control: no-store`), and
collapses every failure into a small set of generic error codes with a safe
HTTP status. Responses contain **no** upstream payload, access token, client
id/secret, or raw eBay error body. The environment (`sandbox` / `production`)
*is* reported, deliberately, so sandbox data is never mistaken for production
data.

Application access tokens are cached **in-process** (module scope) with their
expiry — the simplest secure mechanism appropriate to the current
single-process Next.js server. No external cache dependency (Redis or similar)
is introduced at this stage.

New marketplaces are added as new adapters behind this same interface — never by
branching core domain logic. Possible future adapters
(`AmazonAdapter`, `EtsyAdapter`, `TikTokAdapter`) are documented for
extensibility only and are **not** implemented (see `docs/MVP_SPEC.md` §6,
`docs/ROADMAP.md`).

## 5. Supplier integrations — `SupplierAdapter`

A supplier adapter is responsible *only* for:

- authenticating to the supplier,
- searching supplier products,
- returning variants, SKU/VID, inventory, pricing, logistics, and shipping
  quotes where supported,
- normalizing into Inkora's internal supplier model,
- attaching **provenance** and freshness.

Supplier-specific logic must never leak into core domain services, and the
interface never embeds provider-specific concepts (no CJ `vid`, no warehouse
ids) — those stay inside the provider module.

### 5.1 Implemented — `CjAdapter`

The first concrete supplier adapter exists and is exercised against the official
CJdropshipping API (see `docs/API_INTEGRATIONS.md` §3 for endpoint and
authentication detail):

```text
src/lib/supplier/types.ts      SupplierAdapter interface + normalized
                               SupplierProduct model (pure types)
src/lib/cj/config.ts           environment → CJ configuration (server-only)
src/lib/cj/errors.ts           CJ error vocabulary (config / auth / upstream)
src/lib/cj/oauth.ts            account auth + token cache, refresh, rotation
src/lib/cj/products-api.ts     official CJ API 2.0 search + inventory calls
src/lib/cj/cj-adapter.ts       CjAdapter: CJ response → normalized model
```

Every module under `src/lib/cj/` imports `server-only`, so any attempt to pull
CJ specifics into a Client Component fails at build time. The pure
`SupplierProduct` model is the only supplier type the browser ever imports.

### 5.2 Server API boundary and the browser trust line

The browser never touches a supplier. The only path from the UI to CJ is a
server-side route:

```text
Supplier Scanner (browser)
  → GET /api/suppliers/cj/search?q=…        (validation + bounds)
  → CjAdapter.search()
  → CJ API 2.0 product/listV2 (official, authenticated)
  → normalized SupplierProduct[]
  → safe JSON response
```

A second narrow route verifies warehouse inventory for one selected product,
because search cannot establish it:

```text
  → GET /api/suppliers/cj/inventory?sku=…
  → product/stock/queryBySku
  → per-warehouse stock + honest US verdict (CONFIRMED_AVAILABLE /
    CONFIRMED_NONE / UNKNOWN)
```

Both routes validate and bound the request, force a fresh round-trip
(`force-dynamic`, `Cache-Control: no-store`), and collapse every failure into a
small set of generic error codes with a safe HTTP status. Responses contain
**no** upstream payload, access token, API key, or raw CJ error body —
only CJ's stable numeric error `code`, surfaced in the sanitized `detail`.

Access tokens are cached **in-process** (module scope); no external cache
dependency (Redis or similar) is introduced at this stage.

### 5.3 Relationship to the future Product Matcher

The supplier slice stops deliberately at trustworthy *acquisition*: it makes
CJ products, prices, images, SKUs and honest inventory available in a
provider-independent shape — and nothing more. The Product Matcher (§8) is a
separate, reviewed stage and consumes `SupplierProduct` / `MarketplaceProduct`
through the normalized interfaces only; it never imports `src/lib/cj/*`. This
task therefore implements **no** matching, confidence scoring, candidate
ranking, fee/profit math, or persistence.

New suppliers are added as new adapters behind this same interface — never by
branching core domain logic. Later possible adapter: `AliExpressAdapter`
(V1.5, see `docs/ROADMAP.md`).

Explicitly **not** to be created:

- `ZendropAdapter`
- `SpocketAdapter`

See the supplier policy in `docs/API_INTEGRATIONS.md` §5.

## 6. Core domain services (conceptual responsibilities)

### 6.1 Product Matcher

See §8. Matches marketplace products to supplier products and returns a
**confidence level**.

### 6.2 Fee Engine

Deterministic. Given a marketplace, a category, a price, and a payment method,
it returns the applicable marketplace and payment fees. Fee assumptions are
data-driven, transparent, and versionable (the `fee_rules` entity). No LLM
arithmetic — see §9 and `docs/DATABASE.md`.

**Implemented** for eBay US: `src/lib/economics/fee-engine.ts`, a versioned rule
set with stated caveats on every result — see §10.3 and
`docs/API_INTEGRATIONS.md` §4.1.

### 6.3 Profit Engine

Deterministic. Composes:

```text
Selling Price
  − Marketplace Fees
  − Payment Fees (when applicable)
  − Supplier Cost
  − Shipping Cost
  − other explicitly modeled costs
  = Estimated Net Profit
```

Margin is derived deterministically from the same inputs. Both profit and
margin are labeled **ESTIMATED**.

**Implemented** as `src/lib/economics/calculate.ts`, which composes landed cost,
fees, and revenue into profit and margin and attaches the completeness verdict —
see §10.3.

### 6.4 Opportunity Engine

Deterministic and versionable scoring. Consumes raw metrics, applies a declared
weighting model, and emits an **Opportunity Score** plus a human/AI-readable
explanation. See §9.

### 6.5 Snapshot / Historical Data Layer

Captures time-stamped observations (price, stock, competition, seller, score)
so trends are *measured*, not guessed. Raw metrics are retained independently
of final scores. The first slice is implemented — identity and append-only
marketplace, match, and economics observations, plus a bounded read boundary —
and the Opportunity Engine's own assessments are persisted as observations of the
same kind, so a score is re-readable as history. See §13 and §14, and
`docs/DATABASE.md` §6.1, §6.2 and §8.

### 6.6 Watchlist Monitoring

Records the user's *intent to monitor* an opportunity by stable provider identity,
then re-evaluates it on demand through the same trusted pipeline — reporting
meaningful change (price, cost, profit, margin, score, confidence) since the
previous observation, without re-scanning the entire marketplace.

**Implemented as Watchlist V1** — one table, manual and bounded by design: no
scheduler, no alerts, no background worker. See §16.

### 6.7 Provenance Layer

Cross-cutting. Tags every value OFFICIAL / OBSERVED / ESTIMATED and propagates
that tag from storage through to the UI. See §7.

## 7. Data provenance

Three explicit, non-negotiable categories:

| Category | Meaning |
| --- | --- |
| **OFFICIAL** | Returned directly from an official API or authenticated first-party integration. |
| **OBSERVED** | Legitimately observable marketplace/source data, not necessarily returned by the primary official API. |
| **ESTIMATED** | Values calculated or modeled by Inkora. |

Rules:

- Never fabricate precision.
- Never present an estimated value as an official value.
- The UI must make provenance visible wherever it affects a decision.
- Provenance is stored at the column level where practical
  (see `docs/DATABASE.md`).

Worked example:

| Value | Provenance |
| --- | --- |
| eBay listing price | **OFFICIAL** |
| Observed sales signal | **OBSERVED** |
| Estimated monthly sales | **ESTIMATED** |
| CJ inventory quantity | **OFFICIAL** (when returned by the CJ API) |
| Estimated net profit | **ESTIMATED** (calculated) |

## 8. Product Matcher (foundational component)

The same physical product carries different titles on a marketplace and in a
supplier catalogue. Matching is therefore a first-class, confidence-bearing
component — not an afterthought.

### 8.1 Scope of V1

V1 is **deterministic and text-only**. It contains:

- `src/lib/matcher/text.ts` — normalization and feature extraction
  (stopword removal, singularization, **identifier detection**,
  unit/quantity parsing).
- `src/lib/matcher/query.ts` — bounded CJ query generation (≤ 3 queries:
  a cleaned-title query, a brand/model-priority query, and a short
  needle-in-the-haystack identifier query when one exists).
- `src/lib/matcher/scoring.ts` — deterministic signals, contradiction caps, and
  the `0–100` confidence plus its band.
- `src/lib/matcher/matcher.ts` — the orchestrator: deduplicates candidates by
  supplier id, preserves per-query failures, bounds the result set.
- `src/lib/matcher/inventory.ts` — optional enrichment of the top candidates'
  US warehouse inventory.
- `src/app/api/products/matches/route.ts` — the server boundary that resolves
  the listing, runs matching, and maps errors.

Deliberately absent: **no image similarity, no semantic/AI embeddings, no LLM
call**. Every result can be reproduced from its inputs and explained in
prose — which is the point.

### 8.2 Signals and calibration

Candidate matching signals actually computed in V1:

- **token similarity** — Jaccard over meaningful title tokens, weighted by how
  specific the shared tokens are;
- **identifier agreement** — exact overlap of model-number-like tokens, with
  the weight tiered by identifier length: a short ambiguous token (`q30`) is
  down-weighted relative to a long model number (`wh1000xm5`). This tiering is
  what stops a thermal *printer* from outranking headphone candidates on a bare
  `q30` match;
- **unit / quantity agreement** — parsed capacities (`20 oz`) and pack counts;
- **brand agreement**;
- **contradictions** — unit or brand *disagreement* caps confidence and is
  reported as a concern, never silently ignored.

Rules that hold across all scores:

- Every match returns a **confidence level** (`0–100`) **and** a band
  (`LOW` / `MEDIUM` / `HIGH`).
- `HIGH` requires corroborating evidence **beyond** title agreement; a single
  strong signal alone cannot reach it.
- Identical *generic* titles cap at `MEDIUM` — keyword parity on a commodity is
  not proof of the same SKU.
- Uncertain matches **remain uncertain**; they are never silently promoted to
  exact. Fuzzy/semantic matches must never be presented as exact matches.
- `UNKNOWN` supplier facts are never converted to zero (see §7).

### 8.3 Why the route re-resolves the listing

eBay **reorders results across page sizes**, so an item id is only meaningful
within the result window that produced it. The matcher route therefore replays
the *same* search the Product Scanner issued (same query, same default page
size) and locates the item id in that window. A listing that has scrolled out of
the window returns `ITEM_NOT_RESOLVED` rather than matching a stale or wrong
product.

Both product-intelligence routes that the browser addresses by `itemId` —
`GET /api/products/economics` (§10.6) and `GET /api/products/opportunity`
(§9.8) — run this exact flow through the *same* two server-only modules, so the
two boundaries cannot drift apart:

- `src/lib/products/candidate-resolution.ts` — resolves the listing
  (`resolveMarketplaceProduct`) and selects the candidate
  (`selectBestCandidate` / `selectCandidate`), returning a discriminated
  `CandidateSelection` rather than throwing: `selected`, `not-a-candidate`,
  `no-candidates`, or `supplier-error`. Adapters are injected as
  `CandidateResolutionPorts`, so the upstream budget of one request stays
  visible in one place and the modules are unit-tested without a network.
- `src/lib/products/upstream-errors.ts` — maps eBay and CJ failures to their
  HTTP counterparts (`mapEbayError`, `mapCjError`) or reports an
  `INTERNAL_ERROR` rather than leaking provider payloads.

### 8.4 Limits, and the intended extension points

V1 is intentionally narrow, and these limits are the seams future work grows
from:

| Limit in V1 | Why | Natural extension |
| --- | --- | --- |
| Text-only | Deterministic, explainable, no external model dependency | Add **image similarity** as an additional signal fed into the same score, not a separate verdict |
| No embeddings/semantics | Titles in both catalogues are keyword-rich; token overlap is honest about its weakness | Add a **semantic similarity** signal with its own weight tier |
| No persistence | V1 computes on demand | Store verdicts + raw signals so a score can be recomputed when the weighting changes (mirrors §9's versioning rule) |
| eBay → CJ only | The two V1 adapters (§4.1, §5.1) | The matcher operates on the normalized models, so new adapters extend reach without changing the scorer |

Candidate signals listed in the original spec but **not** yet computed:
attributes/dimensions/color, variant structure, UPC/EAN/GTIN, marketplace
identifiers, supplier SKU characteristics. Each would enter as a new
`MatchSignal` with its own weight, leaving the deterministic core intact.

## 9. The Opportunity Engine (criteria, weighting, versioning)

The Opportunity Engine takes the Product Matcher's candidate for a listing and
produces a verdict: how attractive is this specific sourcing opportunity, and
why. It is a *derived* layer — every input is computed by the matcher (§8.4),
the economics engine (§10), or a replayed search window, so the engine is only
as honest as the evidence it is handed.

Three constraints govern it, and each has a section:

- **Determinism** (§9.7): the engine is a pure function of its inputs, carrying
  one declared version string. A persisted score is attributed to the model that
  produced it, and the model is unit-pinned — changing any weight, threshold, or
  cap bumps the version and requires updating the tests that pin the numbers.
- **Explainability** (§9.4–§9.6): every weight, gate, and cap emits a
  human-readable factor, so no score is ever an unexplained number and no cap is
  ever an arbitrary penalty — caps are derived from the band thresholds and read
  as "this opportunity cannot enter the HIGH band".
- **Honesty about missing evidence** (§9.1): the engine must not manufacture
  signal the official APIs do not return. V1 has no units sold, no sales
  velocity, no conversion rate, and no sales history; the demand component says
  so rather than substituting a proxy.

The candidate inputs an ideal version of this engine would consume — demand,
competition, estimated profit, margin, sales velocity, seller saturation,
supplier availability, stock, shipping speed and cost, price stability, trend —
remain the design's intent. **V1 implements the subset that the official eBay and
CJ APIs actually return**, and reports the rest as missing rather than invented:
sales velocity and seller saturation are not available from the official
interfaces at all, and demand is observable only as listing persistence across
separated observations.

Raw metrics are stored independently of the final score (`docs/DATABASE.md` §6.2)
so a score can be recomputed when the weighting model changes — the standing rule
that the weighting model must **not** be permanently hard-coded as if
authoritative. The V1 weights are therefore documented as a *starting model*,
reasoned from what the evidence is (§9.4) rather than fitted against live
examples, and every persisted score carries the version that produced it (§9.7).

### 9.1 Evidence the engine is allowed to see (and the evidence it must refuse)

The engine is deliberately cut off from the outside world. It takes a candidate
context — a resolved candidate (or `null`), economics for it (or `null`), the
supplier queries and candidate counts the matcher produced, and competition
evidence replayed from the scanner's own search window — and returns an
assessment. It makes **zero** network calls of its own: candidate resolution and
competition evidence are produced upstream and injected, so a single request's
full upstream budget stays visible at its boundary (§8.3) and the engine is
unit-testable without a network (§13.2).

Persistence is a *port*, not an import: the engine receives an evidence-history
port (`readEvidence`, `persistEvidence`) and never touches SQL. The route (§9.8)
binds it to Supabase; the tests bind it to an in-memory map. The history arrives
distilled and **bounded** — a summary carrying the snapshot, match and economics
observation counts, first/last-seen timestamps, the price observations oldest
first, and the prior assessments (each with its own score, band, confidence and
engine version) — never as an unbounded row list. Three limits, declared once in
the route and passed *into* the engine, pin exactly how much evidence one
assessment could have used, and the unit tests pin the same numbers:

| Limit | Value | What it bounds |
| --- | --- | --- |
| `maxPriorAssessments` | 3 | prior assessments read, so a verdict rests on a handful of predecessors, not an open-ended history |
| `maxPriceObservations` | 10 | price snapshots read for the listing |
| `maxCompetitionSample` | 20 | listings the competition component may inspect from the replayed window |

Prior assessments are additionally narrowed by supplier when a candidate was
matched, so a verdict is compared against the *same* opportunity's history rather
than the listing's.

Two rules keep this layer honest rather than merely fast:

1. **No invented demand.** The official eBay interfaces Inkora uses return no
   units sold, no sales velocity, and no sales history. The engine therefore
   reads only what is observable: that a listing remained listed and priced
   across observations separated by at least `MIN_TREND_GAP_HOURS` (1 h). A first
   evaluation, or one with no usable span, yields `INSUFFICIENT_EVIDENCE` — the
   preferred answer when in doubt, and the common case. No proxy is substituted
   for a figure the API never returned.
2. **Sourcing evidence never buys score.** How hard the matcher worked — how
   many queries it generated, how many candidates it surfaced — is *sourcing*
   evidence, not product evidence. It is surfaced for explainability but
   contributes nothing to the score, so the engine can never reward itself for
   having searched harder.

### 9.2 Competition evidence, replayed rather than re-queried

Competition is not a separate search. The route passes the engine the scanner's
own search window — the same query, the same provider result count, the same
sampled listings already fetched to resolve the item (§8.3) — so competition
costs **no additional eBay call** and, more importantly, describes the market the
listing was actually found in. The query string travels *with* the assessment and
is persisted with it: a result count for "wireless earbuds" and one for a
specific model number are not comparable numbers, and a figure without its query
is meaningless.

Because the evidence is one sampled page of one query, every verdict is phrased
in what it actually shows — `INSUFFICIENT_EVIDENCE`, or `APPEARS_LIMITED` /
`APPEARS_MODERATE` / `APPEARS_BROAD`. "Appears" is the operative word; this is a
sample, not a census.

Intensity is a weighted composite of three sub-measures, each chosen so a single
misleading number cannot carry it, and the listing's own row is excluded from all
three:

| Sub-measure | Weight | What it counts |
| --- | --- | --- |
| Breadth | 0.50 | the provider's own result count for the query — the broadest signal available |
| Crowding | 0.30 | distinct sellers among the inspected listings; many sellers mean many independent competitors, not one merchant multi-listing |
| Price proximity | 0.20 | offers priced within half to double the listing's own price, i.e. the alternatives a buyer would actually compare |

Intensity thresholds (`< 35` limited, `≥ 65` broad, on the shared 0–100 scale)
are reused by the rest of the engine so one scale reads everywhere. The
component's contribution to the score is `100 − intensity`, because more
competition is worse for a new entrant; the raw intensity is carried next to the
contribution so the reversal is never hidden. The caveats — small sample,
query-context-dependent, one page of results — ride along in the assessment, and
the component's weight (§9.4) is deliberately light precisely because the
evidence is sampled.

### 9.3 Data quality: the component that makes an assessment honest about itself

Every assessment is also assessed. The data-quality component scores the
*evidence* on a fixed list of seven named dimensions, so the user sees **which**
fact is weak rather than merely that something is:

1. `marketplacePricePresent` — a listing without a price supports no economics.
2. `matchConfidence` — identity risk, carried verbatim from the matcher.
3. `economicsCompleteness` — `COMPLETE` / `PARTIAL` / `UNAVAILABLE`.
4. `supplierCostBasis` — the identified variant's cost, or a reference cost that
   may misstate it.
5. `competitionEvidence` — a verdict of `INSUFFICIENT_EVIDENCE` costs quality.
6. `historyDepth` — how far back persisted observations actually reach.
7. `observationStaleness` — a snapshot older than `STALE_OBSERVATION_HOURS` (72 h)
   describes the past, not the listing's current state, so it costs quality
   rather than being presented as current. No forecasting is attempted.

Two design rules keep this component from being a pile of deductions. Dimensions
are **symmetric**: a present marketplace price gains points and a missing one
loses them at the same magnitude, so a complete record can actually reach 100.
And **history depth is neutral** — a first evaluation with no history is the
expected case, not a defect, so a missing history scores zero rather than
negative.

Its weight in the score is modest (0.10, §9.4), but it **dominates the
confidence** (weight 0.30 of three, §9.6), which is the mathematically correct
place for evidence quality: an assessment built from stale, partial inputs cannot
be a high-confidence assessment no matter how good the arithmetic looks.

### 9.4 The score: five components, weighted once

The opportunity score is a weighted sum of five components, each on a 0–100
scale. The weights are declared **once**, in `COMPONENT_WEIGHTS`, and used
everywhere — a weight cannot be quietly tuned in one call site — and they sum to
exactly 1.0:

| Component | Weight | Score comes from |
| --- | --- | --- |
| Economics | **0.40** | landed-cost analysis against official CJ prices and fees |
| Match | **0.25** | the matcher's confidence that candidate and listing are the same item |
| Competition | **0.15** | the inverse of the replayed-window intensity (§9.2) |
| Demand | **0.10** | listing persistence across separated observations (§9.1) |
| Data quality | **0.10** | the seven dimensions of §9.3 |

Economics dominates because it is the only component built from official,
auditable money figures on both sides of the trade. Match is second, because a
profitable match to the *wrong* product is worthless — but it does not outrank
arithmetic over official prices, because the matcher's confidence is itself
text-only and estimated. Competition is real but sampled and
query-context-dependent. Demand is deliberately small: V1 has essentially no
legitimate demand signal, so the weight leaves the component room to exist — and
to grow once real demand evidence is built — without letting absence of evidence
dominate the score. Data quality's main effect is on confidence, the honest place
for uncertainty.

Within components, the engine refuses to chase outliers or manufacture points:

- Economics scales **linearly** with margin only up to `MARGIN_SATURATION_PERCENT`
  (30 %); above it, extra margin adds nothing. Thirty per cent sits just above
  eBay's managed-payments final value fee (~13–15 % of a typical sale), so it is a
  strong but not implausible result — and saturation stops one cheap outlier from
  swamping the score.
- Economics whose profit figure exists but rests on a non-definitive input
  (`PARTIAL`) is worth `PARTIAL_ECONOMICS_FACTOR` (0.6) of its value.
- Economics built on a *reference* cost rather than the identified variant's cost
  is worth `REFERENCE_COST_FACTOR` (0.7): a reference cost can over- or understate
  the true cost, so the result is discounted rather than stated at face value.
- Demand contributes `DEMAND_SCORES` — 100 / 50 / **0** — so an assessment with no
  demand evidence is neither rewarded for having none nor punished for lacking it.
  Zero points are ever manufactured.

Each component's computed score is rounded to an integer **before** aggregation, so
the published score is exactly what a reader recomputing it by hand from the
published components will get — no hidden floating-point residue.

### 9.5 The gates: caps derived from the band thresholds

Some findings cannot be expressed as a point deduction, so the engine applies
**hard caps** after aggregation. Each cap is stated against a band threshold
rather than chosen as a free number, so each one reads as a policy statement and
not as a penalty:

| Cap | Value | When it applies |
| --- | --- | --- |
| `LOW_MATCH` | below MEDIUM (44) | the matcher's confidence band is `LOW` |
| `UNAVAILABLE_ECONOMICS` | below MEDIUM (44) | no profit figure could be computed at all |
| `NEGATIVE_COMPLETE_PROFIT` | below MEDIUM (44) | a confirmed loss, on otherwise complete inputs |
| `PARTIAL_ECONOMICS` | below HIGH (69) | economics verdict `PARTIAL`: worth investigating, not rated HIGH |

The ordering expresses the engine's priorities, and it is a deliberate inversion
of the usual one: **identity is checked before money.** A loss is still an
interesting signal, but a `LOW`-confidence match caps the assessment even when the
economics are complete and healthy — because profit computed for the *wrong
product* is not profit for this one. Accordingly, a listing for which the matcher
surfaced no candidate at all does not receive an error: the engine assesses it
with a `null` candidate, capped at `LOW_MATCH`, so "we cannot tell which product
this is" is surfaced as a low-confidence verdict instead of a refusal (§9.8).

Caps take effect as the **lowest** applicable cap, and every cap actually applied
is returned in the assessment's `appliedCaps` together with the threshold it was
derived from, so a capped score never looks like a merely weak one.

### 9.6 Confidence: a separate verdict, measuring the evidence

The score says how attractive an opportunity is; **confidence** says how much the
evidence behind it can be trusted. They are computed by separate formulas and
reported with separate bands, because they answer different questions: a
thinly-evidenced opportunity can still be an attractive one, and a well-evidenced
one can be unattractive.

Confidence is a weighted blend of three *proxies* — note that competition and
demand do **not** appear in it. A highly contested market with thin demand
evidence can still be *well evidenced*, and confidence measures the evidence, not
the desirability:

| Proxy | Weight | Basis |
| --- | --- | --- |
| Economics | 0.35 | `ECONOMICS_CONFIDENCE_PROXY` — COMPLETE 100 / PARTIAL 60 / UNAVAILABLE 15 |
| Match | 0.35 | the matcher's confidence, or `NO_MATCH_CONFIDENCE_PROXY` (0) when no candidate exists |
| Data quality | 0.30 | the data-quality component score of §9.3 |

The blended value is then subject to two corrections that keep confidence from
outrunning its weakest hard evidence:

- **The weakest dimension caps it.** Confidence may not exceed its weakest hard
  proxy by more than `CONFIDENCE_SLACK` (20 points). No amount of arithmetic
  certainty about the money can compensate for being uncertain *which product* is
  being costed — so a `LOW` match caps overall trust, as does incomplete economics
  or thin evidence quality.
- **Missing demand discounts it.** The result is multiplied by
  `DEMAND_CONFIDENCE_FACTORS` — 1.0 / 0.85 / **0.6** — so an assessment with no
  demand evidence is reported as markedly less trustworthy, and *never* as "no
  demand exists".

Confidence uses the **same thresholds and the same `LOW` / `MEDIUM` / `HIGH`
bands** as the score, deliberately: one scale reads the same everywhere, and a
`LOW`-confidence assessment should read as plainly as a `LOW` score.

### 9.7 Determinism, versioning, and the test contract

The engine is a **pure function**: same inputs, same output, no clock reads, no
network, no randomness. Every time-dependent fact — the assessment timestamp,
observation staleness — arrives as an input (`now` is passed in by the route), so
an assessment can be replayed exactly, in a unit test, without mocking anything
but the ports.

Every assessment carries the version of the model that produced it. The constant
lives in one place (`OPPORTUNITY_ENGINE_VERSION`, currently `"opportunity-v1"`) and
is stamped onto each persisted observation, so a score in the database is never an
unattributed number: any future reader can tell which model to hold it against.

The weights are explicitly a **documented starting model**, not a tuned one (§9.4)
— reasoned from what the V1 evidence *is*, not fitted against live examples. That
keeps the engine honest about the standing rule that a weighting model must not be
permanently hard-coded as if authoritative: any change to a weight, threshold, or
cap bumps the version, and the change is reviewed against the tests that pin the
model — the engine's suite asserts concrete input→output pairs, so a silent change
to a constant fails the tests rather than quietly shifting every persisted score.

The whole assessment — components, factors, caps, confidence, bands, and the
evidence summaries that produced it — is persisted as one document
(`docs/DATABASE.md` §6.2), so a future score is comparable to a past one attribute
by attribute, not just number to number.

### 9.8 Route contract — `GET /api/products/opportunity`

The engine is reached through a single server-side boundary,
`src/app/api/products/opportunity/route.ts`, so the browser never holds supplier
credentials and the engine never receives an unvalidated input shape. It replays
the full pipeline — eBay search, listing resolution, CJ discovery, matcher,
economics — through the same shared modules as the economics route (§8.3), hands
the result to the engine, and persists what it concluded.

Request:

```text
GET /api/products/opportunity?itemId=<ebayItemId>&q=<search+query>
                        [&supplierProductId=<cjProductId>]
                        [&destinationCountry=<ISO-3166 alpha-2>]
```

- `itemId` — **required**, from a live eBay search result.
- `q` — **required**, the exact search that surfaced the item; it is replayed to
  re-resolve the listing and carried as the competition evidence's query context
  (§9.2).
- `supplierProductId` — optional. When present, the route scores the opportunity
  against *that* CJ product specifically.
- `destinationCountry` — optional; otherwise the server's configured shipping
  baseline, so the landed cost is always tied to a stated destination.

The handler exports `dynamic = "force-dynamic"` and every response carries
`Cache-Control: no-store`, because an assessment depends on live upstream state and
on what is currently persisted — a cached assessment would be a stale verdict.

Responses:

- **200** — `{ status: "ok", assessment, persistence, timestamp }`: the full
  assessment (score, band, five components, factors, applied caps, confidence and
  its band), the candidate and economics it was built on, the competition
  evidence, and the bounded history summary.
- **400** — `INVALID_ITEM_ID`, `INVALID_QUERY`, `INVALID_SUPPLIER_PRODUCT_ID`, or
  `INVALID_DESTINATION`.
- **404 `ITEM_NOT_RESOLVED`** — the listing is no longer in the current search
  results.
- **404 `CANDIDATE_NOT_FOUND`** — the requested `supplierProductId` is not a
  matcher candidate for this listing, or the matcher surfaced no candidate *and*
  the caller named a supplier.
- **502 / 503 / 504** — eBay or CJ failures, mapped through the shared error
  mappers (§8.3), including `EBAY_NOT_CONFIGURED` / `CJ_NOT_CONFIGURED` when the
  server has no credentials and the `UPSTREAM_RATE_LIMITED` case with its retry
  hint.
- **500 `INTERNAL_ERROR`** — only a genuine, unexpected failure in the matcher or
  the economics layer.

Three behaviours are contracts, not implementation details:

1. **No candidates is a verdict when the supplier was unnamed.** A listing with no
   `supplierProductId` that matches nothing is still *assessable*: the engine runs
   with a `null` candidate, is capped at `LOW_MATCH` (§9.5), and returns 200 with a
   low-confidence assessment. A listing scored against a *named* supplier that
   cannot be matched returns 404 — that specific opportunity marketplace does not
   exist.
2. **History is read before the fresh assessment is persisted**, so an assessment
   never counts itself as its own prior, and a first evaluation is honestly
   reported as having no history.
3. **Persistence is best-effort and always reported** (§13). The economics
   evaluation and the assessment are each persisted through a `…Safe` wrapper that
   never throws; a failure is logged and surfaced as
   `persistence: { status: "failed", message }` (or `status: "disabled"` when
   persistence is off) alongside the assessment — never a 500, and never claimed as
   written when it was not. An assessment is appended, never overwritten, so an old
   score stays attributable to the engine version and evidence that produced it.

The route issues no eBay call beyond what the pipeline already needs: competition
evidence comes from the same search window that resolved the item (§9.2), and
persisted observations are read once, bounded by the limits of §9.1.

## 10. Economics engine (foundational component)

The economics layer turns *one eBay listing* plus *one matched CJ candidate* into
a landed cost, an estimated profit, and a margin — with a completeness verdict
and a per-field provenance tag attached to every number. It is the second
foundational component after the Product Matcher (§8), and it is the component
the future Opportunity Engine (§9) consumes as an input.

Three rules govern the whole layer, and they are the reason the code is split
the way it is:

1. **Determinism.** Same inputs ⇒ same outputs, forever. Money is integer minor
   units; percentages are integer basis points; the two free choices the engine
   has (which variant, which shipping quote) are pure, documented *policies*,
   not heuristics that depend on ordering or network timing.
2. **No invented numbers.** A missing input propagates as `null` and degrades
   the completeness verdict. There is no "assume free shipping", no "assume the
   cheapest variant is the right one", and no fallback exchange rate.
3. **Auditability.** Every figure the UI can display either comes from an
   official API or was computed by a rule that carries a version, a source, and
   a human-readable note — so any number can later be recomputed and any
   disagreement with reality can be traced.

### 10.1 Money

`src/lib/economics/money.ts` is pure and dependency-free. It defines the
conventions the rest of the layer relies on:

| Concern | Convention |
| --- | --- |
| Representation | Integer US cents (minor units). No binary float is ever introduced into arithmetic. |
| Parsing | A decimal string or number becomes cents, rounded half up. CJ's documented price *ranges* (`"23.36 -- 23.42"`) resolve to the first token (the low end). Unparseable input is `null` — never `0`, never a guess. |
| Arithmetic | Integers only, with exactly one explicit rounding point per operation. |
| Percentages | `percentOfCents(cents, basisPoints)` computes `basis × bps / 10000` half up; margins are returned in "percent cents" (1/100 of a percent) so they format through the same path. |
| Rounding | Half up, implemented with integer division so the tie case is exact. A zero or negative basis yields `null` rather than a fabricated `0%` or a division by zero. |
| Bounds | An absolute cap ($10,000,000,000) refuses values that would leave the safe-integer range. |

### 10.2 Selection policies

`src/lib/economics/selection.ts` holds the only two *decisions* the engine makes
— which supplier variant to cost, and which freight quote to use — as pure
functions, so they are unit-testable with no network and identical on every run.
They are policies, not optimizers: each resolves one documented choice and
surfaces the caveat when the choice is not definitive.

**Variant selection** (`selectSupplierVariant`):

1. Keep only variants with an id and a positive price.
2. One eligible variant → the selection, basis `SELECTED_VARIANT` (definitive).
3. Several eligible variants with identical pricing → cost is unambiguous, basis
   `SELECTED_VARIANT`.
4. Otherwise identity cannot be resolved from the marketplace listing, so a
   deterministic *reference* is chosen — preferring a variant stocked in the
   destination country, then the lowest cost, then the id as a stable tie-break —
   and the basis is `VARIANT_REFERENCE`: the cost is a lower bound, never the
   definitive cost of the listed item.
5. No eligible variant → `null`, which the caller reports as "variant unresolved"
   rather than costing the product anyway.

**Shipping selection** (`selectShippingQuote`): keep quotes that name a method
and price it; prefer a quote that documents its delivery time; then take the
lowest cost; break ties on the method name. No usable quote → `null`, and the
economics stay incomplete rather than substituting an assumed shipping cost.


### 10.3 Fee engine, cost basis, and completeness

**Fee engine** (`fee-engine.ts`) is a rule set, not a hardcoded percentage. V1
models United States / eBay.com / managed payments:

- **Final value fee** — one rate on the *total sale amount*, defined as the item
  price plus buyer-paid shipping, with a per-order minimum ($0.30).
- **Insertion (listing) fee** — modeled at $0.00 under the documented assumption
  that the listing is inside eBay's free monthly allotment.

Every result carries `engineVersion` (`ebay-us-1.0`) and a `ruleSource` sentence,
and *always* the caveats: seller-subscription effects are unobservable (so the
fee is `ESTIMATED`, never `EXACT`), taxes on the fee basis are unavailable (so
the model can understate the real charge), per-category maximums are not modeled
(so a real fee can only be *lower*), and optional listing upgrades are
seller-elected. Category-specific overrides are structured for — the engine
accepts category ids through a rule table — even though V1's table carries only
the general default, because no category cap could be validated from official
documentation. That seam is intentional, not an omission.

**Cost basis** (`SupplierCostBasis`) is what the supplier cost *means*, and it is
the difference between a defensible profit figure and a fabricated one:

| Basis | Meaning | Provenance of the cost |
| --- | --- | --- |
| `SELECTED_VARIANT` | The cost of a specific, unambiguously identified variant. | `OFFICIAL` |
| `VARIANT_REFERENCE` | A deterministic reference (lower bound) — the listing does not identify which variant it is. | `ESTIMATED` |
| `CATALOG_MINIMUM` | Catalogue-level price used because variants could not be resolved at all. | `ESTIMATED` |

**Completeness** (`evaluateCompleteness`) is a verdict, not a score. Actionable
profit requires, at minimum: a positive marketplace price, a supplier product
cost, a computable marketplace fee, and a supplier shipping quote.

| Verdict | When |
| --- | --- |
| `COMPLETE` | Every required input is present and definitive. |
| `PARTIAL` | Present but non-definitive: a reference/catalogue cost, an incomplete fee rule, an unpriced buyer-shipping line, or an assumed currency. |
| `UNAVAILABLE` | Any required input is missing — including a non-USD listing, since V1 performs no currency conversion and invents no exchange rate. |

A non-USD listing is `UNAVAILABLE`, not a converted estimate. A listing with no
declared currency is treated as USD *and* flagged, which is the only assumption
the layer makes about money. `landedSupplierCost` is `null` unless both supplier
cost and shipping are known; `estimatedProfit` and `marketplaceFee` are always
labelled `ESTIMATED`; a negative profit is reported as-is and never clamped to
zero.

The formula is stated once and implemented exactly:

```text
grossMarketplaceRevenue = item price + buyer-paid shipping
landedSupplierCost       = supplier product cost + supplier shipping cost
estimatedProfit          = grossMarketplaceRevenue
                           − landedSupplierCost
                           − marketplace fees
marginPercent            = estimatedProfit / grossMarketplaceRevenue × 100
```


### 10.4 Shipping acquisition

`src/lib/cj/shipping.ts` is the *only* module that turns a matched CJ candidate
into shipping economics inputs, and the only place CJ logistics calls appear:

```text
CJ variant/query → normalized variants → deterministic variant selection
CJ freight calc → normalized ShippingQuote[] → deterministic quote choice
```

CJ's freight endpoint is keyed on a **variant id** (`vid`), so a catalogue
candidate must pass through `variant/query` before any quote can exist. This is
why "no shipping cost" is a first-class outcome rather than an error: no usable
variants ⇒ no `vid` ⇒ no quote ⇒ economics stay incomplete. Nothing invents a
cost.

The normalized `ShippingQuote` shape is produced exactly once, at the adapter
boundary (see `src/lib/supplier/types.ts`), and the economics layer consumes
only that shape — never a raw CJ payload.

Call budget per economics request: **1** CJ variant query + **1–2** CJ freight
calculations (the second only when a destination-warehouse origin yields no
methods and the fallback origin differs). Bounded, documented, predictable.

### 10.5 Provenance and warnings

Every monetary field on the result carries its own provenance tag using the
project's existing categories (§7) — never a redefined scheme. The result also
carries:

- `warnings` — everything that degraded the answer, including the reasons an
  `UNAVAILABLE` verdict was reached. These are always surfaced, never dropped,
  because a user must be able to see *why* a number is missing.
- `assumptions` — the explicit assumptions in force (single-unit order, assumed
  currency, free-insertion allotment, …).
- `feeBreakdown` — each component with its amount, rate, status, and note, plus
  the engine version and rule source.
- `shippingQuotes` — *all* quotes returned, not just the selected one, so the
  rejected alternatives remain inspectable.
- `calculatedAt`, `marketplaceItemId`, `supplierProductId` — enough context to
  re-derive the result.

### 10.6 Server API boundary

`GET /api/products/economics?itemId=<ebayItemId>&q=<query>&supplierProductId=<cjPid>`

The browser never posts economics inputs. It identifies an eBay listing it has
already seen and *one* matcher candidate it selected; the server re-resolves the
listing through the eBay adapter, re-runs the bounded matcher to **prove** the
supplier product really is a candidate for it, then computes economics from
authoritative upstream values only. This mirrors the matcher route's trust line
(§4.2, §5.2, §8.3) for the same reason: a client-supplied price or cost is a
spoofable profit figure.

One user request produces a bounded set of upstream calls: 1 eBay search
(re-resolve) + ≤3 CJ searches (matcher) + 1 CJ variant query + 1–2 CJ freight
calculations. Economics are never computed for every candidate — the human picks
one, and only that one is costed. The route is `force-dynamic`, because economics
must always reflect fresh upstream round-trips. Responses contain the economics
result and never credentials, tokens, or raw upstream payloads.

See `docs/API_INTEGRATIONS.md` §3 for the CJ freight endpoint contract and
inputs, and §4 for the fee source and its limits.


## 11. Online-first development

Inkora validates integration reality early and progressively: build health,
deployment behavior, Supabase connectivity, environment configuration, eBay
connectivity, CJ connectivity, and production-like failure modes.

We do not postpone real integration validation until the end of the project —
but we also do not deploy unfinished feature code just to satisfy this
principle. See `docs/ROADMAP.md`.

## 12. What this document intentionally does not decide

- The concrete internal design of the adapters *other than* `EbayAdapter`
  (§4.1) and `CjAdapter` (§5.1), whose designs are now fixed by their
  implementations. Future adapters arrive with their own implementation task.
- The final weighting model for the Opportunity Score.
- The production schema (see `docs/DATABASE.md`, which separates likely MVP
  tables from future and unvalidated entities).

## 13. Persistence layer — identity and append-only observations

The first business persistence layer is deliberately narrow: it records what
Inkora already computes, and nothing more. It owns no scoring, no ranking, no
user-facing decision. Its only job is to make a computed fact **re-derivable
later** — the property the whole roadmap's trend-detection work depends on.

Code lives in `src/lib/persistence/` and is **server-only**. Every module there
imports through `client.ts`, which imports the `server-only` package: any attempt
to reach the persistence layer from a Client Component fails at build time. When
the environment is not configured, the client is `null` and the layer reports
`disabled` rather than throwing.

### 13.1 Identity and observation are separate tables

A listing or supplier product has exactly one **identity** row
(`marketplace_products`, `supplier_products`, `supplier_variants`) keyed by
provider + external id, and any number of **observation** rows
(`marketplace_product_snapshots`, `match_observations`,
`economics_observations`, `opportunity_observations`), each carrying its own
timestamp. An assessment is an observation, not a state: it is appended, never
updated, so an old score stays attributable to the engine version that produced
it.

The split is the design decision that makes history honest: a listing can change
its title, price, or seller and still keep *its* history, because the anchor is
the provider identity, not any field that can change. Nothing is ever updated in
place on an observation table — history is append-only.

### 13.2 Deduplication by content hash

Each observation type is deduplicated against the latest stored row for the same
identity by a **sha256 of a canonical JSON of its business fields**
(`content-hash.ts`). Timestamps and surrogate ids are deliberately excluded, so
"the same observation, seen again" is one row, not a stream of duplicates — but
a price or fee change always inserts. V1 compares against the latest row only;
if that probe fails, the code inserts rather than guessing, so a transient read
error can never silently suppress a genuinely new observation.

### 13.3 Write path

`persistEvaluation` is called from the economics route after a successful
computation, through `persistEvaluationSafe`, which **never throws**:

- `ok` — records persisted (or reused, because they were unchanged).
- `disabled` — persistence is not configured in this deployment. Nothing was
  written; the response says so.
- `failed` — something went wrong. The failure is logged and reported in the
  response `persistence` field with a message that carries **no credential,
  token, or raw upstream payload**.

This is the rule that keeps persistence strictly non-functional today: a failed
or absent write **never turns an economics success into an error**, and it never
fabricates a success either. Both directions are reported honestly.

The Opportunity Engine route follows the same pattern for both of its writes, and
for the same reason: `persistEvaluationSafe` stores the economics evaluation the
assessment links to, and `persistAssessmentSafe` appends the assessment itself
(§9.8). Both report `ok` / `disabled` / `failed` and never throw, so a persistence
failure surfaces as `persistence: { status: "failed", message }` beside a
successful assessment — and when the evaluation records are unavailable, the
assessment is still written, honestly without its supplier linkage rather than
being dropped or faked. The read side is deliberately ordered *before* the
assessment is persisted, so a fresh assessment never counts itself as its own
prior.

### 13.4 Money, margin, and absent values

Every figure crosses the database boundary as **integer minor units** — never a
float, never a Postgres `numeric` at rest in a computed field. `margin` is stored
as percent-cents, a *separate* encoding (`36.99%` ↔ `3699`) that must never be
exchanged with money helpers despite the coinciding values. An absent value is
stored `null` and read back `null` — never a fabricated zero. A stored loss stays
negative. See `docs/DATABASE.md` §8.

## 14. Historical read boundary

```text
GET /api/products/history?itemId=<ebayItemId>&limit=<1..50>
```

The read side is a separate boundary from the write side, and it is the only path
the UI has to stored observations (`history-reader.ts`, the route in
`src/app/api/products/history/route.ts`).

Rules the boundary keeps:

- **Lookups are by stable provider identity**, scoped to the one marketplace that
  has an adapter, so a future marketplace's item id can never collide.
- **Reads are bounded and most-recent-first.** The page size is clamped to
  `[1, MAX_HISTORY_LIMIT]` (`mapping.ts`, unit-tested without a database) and the
  applied limit is echoed in the response so the caller can confirm it was not
  unlimited. No unbounded cursor is ever handed out.
- **Every entry is explicitly historical.** Each observation carries its own
  observation timestamp, and the UI labels the panel as persisted history, stated
  separately from the live figures above it. Nothing in the response is a
  statement about a listing's present price or stock.
- **Sanitized like every other boundary.** No request body, no cookies, no
  secrets, no raw upstream payloads, and never a write path. Statuses:
  `disabled` → 503, `not_found` → 404, `error` → 503, invalid item id → 400.

Canonical response types live in `src/types/product-history.ts`, shared by the
route, the reader, and the Product Scanner's history panel so the three cannot
drift.

## 15. Opportunity Scanner V1 (bounded orchestration)

The Opportunity Engine assesses **one** marketplace × supplier pair per request
(§9). The Opportunity Scanner is the layer that turns a *search window* into a
*ranked set* of assessments — bounded, user-triggered, and explainable.

It is an orchestration layer, not a new intelligence. It adds exactly three
things to the engines that already exist, and nothing else:

1. a **bounded batch** — selection, then deep evaluation at bounded concurrency;
2. **failure isolation** — one bad listing never forfeits the rest of the scan;
3. a **deterministic ranking** with documented tie-breakers.

Matching, money, and scoring stay owned by the Product Matcher (§8), the
Economics Engine (§10), and the Opportunity Engine (§9) respectively. The
scanner invents **no score of its own**.

```text
Product Scanner (browser)
  → GET /api/marketplaces/ebay/search?q=…          discovery grid (limit 24)
  → user selects ≤ 6 listings (or asks for the top 6)
  → POST /api/scanner/scan { query, mode, itemIds }
       → 1 eBay search (replayed; reused as competition evidence, §9.2)
       → select the bounded batch
       → per item, at concurrency 3:
             Product Matcher → Economics Engine → history read
             → Opportunity Engine → persist the assessment
       → rank the verdicts deterministically
       → report every failure, item by item
```

### 15.1 Bounds, server-enforced

Every limit lives in `src/lib/scanner/limits.ts` and is enforced server-side; the
values the browser receives are display-only and re-validated on arrival.

| Limit | Value | What it bounds |
| --- | --- | --- |
| `SCANNER_DISCOVERY_LIMIT` | 24 | eBay results surfaced for selection (matches the resolve limit, §8.3) |
| `SCANNER_MAX_EVALUATIONS` | 6 | listings deep-evaluated per scan |
| `SCANNER_CONCURRENCY` | 3 | items in flight at once — a fixed pool, no queue |
| `SCANNER_DEADLINE_MS` | 90 000 | wall-clock budget; items still in flight are reported as timed out |

The **upstream budget is derived from these numbers**, which is why the batch cap
is what it is (docs/API_INTEGRATIONS.md §3, §4):

```text
per item   ≤ 3 CJ searches (matcher maxQueries)
         +  1 CJ variant query
         +  1–2 CJ freight calculations
         = ≤ 6 CJ calls
max batch  6 items  ⇒  1 eBay + ≤ 36 CJ calls, in ≤ 2 concurrency waves
```

One eBay search is replayed per scan and reused verbatim as every item's
competition evidence, so competition costs **zero** additional eBay calls (§9.2).
No step runs open-endedly: `withTimeout` bounds each upstream call to the scan's
remaining budget, and an item that blows the deadline is reported as `timeout`,
never retried, never blocking the others.


### 15.2 Ports, not adapters

The scanner receives every external capability through a `ScannerPorts`
interface, constructed once in the route:

```text
searchMarketplace  → EbayAdapter.search
matchCandidates    → ProductMatcher(CjAdapter).findCandidates
computeEconomics   → computeCandidateEconomics
readEvidence       → readOpportunityEvidence
persistEvaluation  → persistEvaluation
persistAssessment  → persistOpportunityAssessment
```

This mirrors `CandidateResolutionPorts` (§8.3) for the same reasons: the
orchestration is unit-testable with fakes and no network, and one scan's upstream
call count stays visible in one place. Canonical types live in
`src/lib/scanner/types.ts` and the boundary shapes in `src/types/scanner.ts`.

### 15.3 Failure isolation

A scan spans several listings and several upstream round-trips, so the contract
is that **one listing's failure must never fail the scan**. Every item resolves
to one outcome, and only the loss of the discovery window itself — or an unusable
request — fails the whole request:

| Outcome | Meaning |
| --- | --- |
| `evaluated` | Matched, economics computed (any completeness), full assessment |
| `no-candidates` | Matcher surfaced nothing — still a full assessment, hard-capped LOW by the engine. A verdict, not an error |
| `economics-unavailable` | Candidate exists but no quote — assessed with `economics: null`, an explicit UNAVAILABLE component |
| `item-not-found` | The id scrolled out of the replayed window (reported per item, §8.3) |
| `upstream-error` | A CJ/eBay failure this item could not recover from |
| `timeout` | The scan's budget elapsed before this item finished |

`status: "partial"` means the scan ran and produced verdicts and is honestly
reporting which listings it could not assess. It is a success, not an error.
Persistence is best-effort throughout (§13): a storage failure is reported on the
item's `persistence` field and the assessment is still returned, still ranked,
and never claimed as stored.

### 15.4 Persistence: no scan table

A scan is deliberately **not** persisted as its own job or row. Every item's
assessment is already an append-only observation carrying its query, its
timestamp, and its full reasoning (§13, docs/DATABASE.md §6.8); a scan-level
table would duplicate observations that already exist and would add a write path
for no new information. The scanner is stateless and user-triggered — there is no
scheduler, no queue, and no background crawl.


### 15.5 Ranking: no new score

Results are ordered by the Opportunity Engine's own `score`, descending, with a
fully deterministic tie-break ladder (the code is `src/lib/scanner/ranking.ts`):

1. `score` DESC — the engine's verdict, unmodified.
2. evidence `confidence` DESC — for equal scores, the assessment on stronger
   evidence comes first. Confidence is a separate number (§9.6) and stays visibly
   prominent in the UI, never folded into a blended metric.
3. economics completeness DESC — COMPLETE before PARTIAL before UNAVAILABLE: of
   two otherwise equal opportunities, the one with a computable profit figure is
   the more actionable.
4. match confidence DESC.
5. `marketplaceExternalId` ASC — the final, stable tie-break over a
   server-assigned unique id, which is what makes the whole order reproducible.

The ladder is pinned one rule at a time in `src/lib/scanner/ranking.test.ts`.

### 15.6 Route contract — `POST /api/scanner/scan`

```json
{ "query": "wireless earbuds", "mode": "manual", "itemIds": ["v1|…|0"] }
{ "query": "wireless earbuds", "mode": "batch", "limit": 6 }
```

The browser identifies listings it has already seen (`manual`) or asks for a
server-chosen batch (`batch`, deterministic, the first `limit` of the window). It
never posts a product object, a price, or a candidate — only opaque ids and the
query it searched. Every requested id is re-resolved inside the server's own
replayed window; one that scrolled out is reported as `item-not-found`, never
matched blindly (§8.3).

The response echoes the limits actually applied in `meta.limits`, so the UI can
## 16. Watchlist V1 (opportunity monitoring)

The watchlist is the **manual monitoring** layer over the intelligence pipeline
(`docs/MVP_SPEC.md` §4.5). It owns no scoring, no matching and no economics — it
connects a user's *intent to monitor* an opportunity to **stable provider
identities**, and hands every re-evaluation back to the same trusted services the
Opportunity Scanner already uses (§9, §15). Everything is user-triggered: there is
no cron, no queue, no background worker and no alerting in this layer.

```text
  save to watchlist (ids + the query that surfaced the listing)
    → read the last known assessment (a stored observation)
    → re-evaluate: fresh eBay resolve → CJ re-proof → economics
        → Opportunity Engine → persist as a new observation
        → compare against the previous observation
```

Implemented: `src/lib/watchlist/*` (types, bounds, sorting, comparison,
orchestration, repository), the routes under `src/app/api/watchlist/`, and the page
`src/app/watchlist/`. The schema is one table — `watchlist_entries`,
`docs/DATABASE.md` §6.9. The whole contract is validated end-to-end against live
providers by `scripts/live-watchlist.mts` (§11), and every rule below is pinned by
unit tests that need no database and no network.

### 16.1 Monitoring intent, not a data copy

The watchlist stores **one new thing**: the intent to monitor an opportunity. It
does not copy marketplace, supplier, economics or opportunity data — those remain
in the append-only observation tables, the source of historical intelligence
(§13). An entry therefore carries:

- `marketplace_product_id` — the stable marketplace listing identity. Mandatory;
  without it there is no opportunity to watch.
- `supplier_product_id` — the stable supplier product identity, when a candidate
  was selected. Nullable (§16.2).
- `replay_query` — the query whose window surfaced the opportunity, replayed to
  re-resolve the listing on a re-evaluation (§8.3). Operational metadata, never
  intelligence.
- `label` — an optional free-text note. Never parsed, never used as identity.
- `archived_at` — the soft-removal timestamp (§16.5).

Identity is provider identity, never a title or a price: a listing that changes
its title is still the same watch, and nothing has to be migrated when it does.
The entry holds **no money and no score** — those are read from the observation
tables on every request, so a figure the watchlist displays is always a stored
observation from a point in time, never a live claim about a listing's present
state. There is deliberately **no foreign key cascade**: removing a watch never
removes an observation (§13.1).

Corollary, enforced by the sort module: **the watchlist invents no score of its
own.** Entries are ordered by transparent existing fields only — the engine's
score, its separately computed confidence, the economics layer's profit or margin,
or timestamps (§16.9).

### 16.2 Scope: a NULL supplier is a scope, not a wildcard

A marketplace listing can be watched two ways, and they are **two different
opportunities**: paired with one supplier candidate, or marketplace-only. The
marketplace-only watch is a legitimate, fully explainable verdict about a listing
that the matcher could not source — hard-capped at `LOW` (§9.5) — not a placeholder
waiting for a supplier.

Because Postgres treats NULLs as mutually distinct in a unique index, one index over
both identity columns could not protect the marketplace-only case. The schema
therefore expresses the two kinds of watch as **two partial unique indexes**
(`docs/DATABASE.md` §6.9):

- `uq_watchlist_entries_active_pair` over `(marketplace_product_id,
  supplier_product_id)` where the supplier is not NULL and the row is active;
- `uq_watchlist_entries_active_marketplace_only` over `(marketplace_product_id)`
  where the supplier is NULL and the row is active.

Three consequences, all load-bearing:

1. **A save is idempotent.** Watching the same scope a second time *reuses* the
   existing entry (`action: "reused"`) — it never duplicates it and never
   overwrites the original's `created_at`.
2. **The two scopes coexist.** The same listing watched paired and marketplace-only
   is two entries with two ids, two assessments and two histories.
3. **Scoping is strict.** A marketplace-only entry's history never includes a pair
   assessment of the same listing, and its re-evaluation never substitutes a
   supplier: a NULL supplier is a scope, not a wildcard that matches any candidate.

### 16.3 Bounds, server-enforced

Monitoring is bounded the same way scanning is (§15.1): every number below is a
server-enforced constant in `src/lib/watchlist/limits.ts`, no client request can
raise any of them, and any bound shipped to the browser is display-only and
re-validated on arrival. The module is pure on purpose, so the contract is
unit-testable with no database and no credentials.

| Bound | Value | Bounds |
| --- | --- | --- |
| `WATCHLIST_MAX_ENTRIES` | 100 | active entries — a full watchlist answers `409 WATCHLIST_FULL`, and archiving frees a slot |
| `WATCHLIST_DEFAULT_LIMIT` / `WATCHLIST_MAX_LIMIT` | 20 / 50 | one list read; a request outside the range is clamped, never widened |
| `WATCHLIST_HISTORY_LIMIT` | 12 | one entry's timeline |
| `WATCHLIST_MAX_RE_EVALUATIONS` | 6 | one batch — never raised by a query parameter |
| `WATCHLIST_CONCURRENCY` | 2 | in-flight re-evaluations per batch |
| `WATCHLIST_DEADLINE_MS` | 120 000 ms | hard wall-clock budget for a whole batch |
| `WATCHLIST_RESOLVE_LIMIT` | 24 | page size used to re-resolve a watched listing — the same window shape the listing was found in |
| matcher / history limits | as the opportunity route | so a re-evaluation scores the same candidate set with the same context |

The derived worst case for one batch is bounded and knowable in advance: per entry,
one eBay search (reused verbatim as competition evidence) plus at most six CJ calls;
for the whole batch, at most six eBay searches and 36 CJ calls in at most three
concurrency waves (`docs/API_INTEGRATIONS.md` §3, §4).

### 16.4 Re-evaluation — the only path to fresh numbers

A saved entry is a pointer, not a price. Fresh numbers exist only after the user
asks for them, via `POST /api/watchlist/{id}/re-evaluate` (§16.7). The orchestrator
`reevaluateEntry` in `src/lib/watchlist/reevaluate.ts` rebuilds the assessment:

1. resolve the entry and confirm its scope (404 if absent, 409 if archived);
2. **replay** the stored query through the marketplace resolve service, reusing the
   *same window shape and matcher limits* that produced the original opportunity —
   a watch is replayed, never silently re-found by a different query;
3. **re-prove the supplier**: if the watch is a pair, the saved supplier must still
   be a matcher candidate for this listing. It is never substituted with another
   supplier and passed off as the same opportunity;
4. run the **economics layer** on freshly fetched inputs — never on stored values,
   and never on figures a browser already received (§9.2);
5. score through the **Opportunity Engine**, with the same opportunity observation
   limit as the scanner route, so an engine upgrade changes a watch's score without
   any migration;
6. **persist as a new observation**, after reading the previous assessment;
7. compare against that previous observation (§16.8).

Three of these steps are load-bearing contracts, not implementation details:

- **No stale browser economics.** The UI may hold an old price or cost in memory; a
  re-evaluation never trusts it. Money inputs are fetched in the same request as
  the verdict, or the assessment honestly reports `ECONOMICS_UNAVAILABLE` (§9.3).
- **The saved supplier is re-proven, never substituted.** When the matcher no longer
  proposes that supplier for this listing, the outcome is the honest
  `candidate-not-resolved` (`410`) — the pair watch ends, visibly, and nothing is
  quietly re-pointed at a different product.
- **The previous assessment is read *before* the new one is persisted.** The
  comparison is anchored on the observation that actually preceded this one.

The orchestrator is total: **it never throws**. Every upstream failure, every
configuration gap and every parse problem resolves to one named outcome with a
machine-readable code and a human-readable message, so an entry is never left in a
half-written state. A failed re-evaluation removes nothing — the entry and every
observation row stay exactly where they were, and the UI keeps showing the
last-known data beside the reason.

Persistence itself is **best-effort and reported honestly**: if the new assessment
cannot be stored, the response still carries the assessment and its comparison, and
the `persistence` field reports exactly what storage said. A write problem is
reported to the user as a write problem — it is never swallowed into a 200.

### 16.5 Archive — soft removal that frees the scope

The watchlist has **one removal path**, and it is soft. Archiving sets
`archived_at` (`POST /api/watchlist/{id}/archive`); the row is never deleted, and
no observation is ever deleted with it (§13.1). The intent stays auditable and the
timeline stays readable, which is what monitoring requires:

- An archived entry is **excluded from the list** but its **history stays
  readable** — its assessments are still on disk, still queryable.
- The list **never re-analyzes** anything to produce its rows (§16.1); an entry
  with no assessment yet shows no score, no profit and no margin — never invented
  ones, and never a loading spinner standing in for a number.
- Archiving **frees the slot against the entry cap** — the supported way to make
  room when the watchlist answers `409 WATCHLIST_FULL` — and it **frees the
  uniqueness slot**, so the same scope can be watched again later as a fresh entry
  with its own `created_at` and its own new history. That second watch is a *new*
  observation series; it does not adopt the archived entry's history.
- Re-evaluating an archived entry is **refused, not implied**: the outcome is
  `archived` with status `409`. A stale tab cannot resurrect a watch the user
  ended, and a saved id can never silently become a different opportunity.
- The call is **idempotent**: archiving an already-archived entry is a success with
  `action: "already-archived"`, not an error — a double-click is harmless.
- Every entry id is a server-assigned uuid; a non-uuid id is `400 INVALID_ENTRY_ID`
  before any row is touched.

### 16.6 Batch re-evaluation — named entries, no "re-evaluate all"

`POST /api/watchlist/re-evaluate` re-evaluates a **client-named** set of entries in
one request. It is deliberately a set, not a selector: there is no
`POST /api/watchlist/re-evaluate-all`, no `?archived=true`, and no way to ask the
watchlist to re-process *every* entry — that would be a bulk job with an unbounded
upstream cost, and the MVP has no worker to run it in.

The batch contract:

- **Request shape.** `{"entryIds": ["uuid", …]}` — an array of distinct entry ids.
  Empty or missing ids answer `400 ENTRIES_REQUIRED`; more ids than
  `WATCHLIST_MAX_RE_EVALUATIONS` answers `400 TOO_MANY_ENTRIES`; a **duplicate** id
  is rejected wholesale (`400`) rather than silently collapsed, because a duplicate
  in the request is a client bug and the batch cap is a cost bound that a malformed
  request must never widen. The orchestrator dedupes defensively regardless.
- **Every entry resolves to its own outcome.** No entry is skipped because another
  one failed; a batch is `status: "ok"` when every outcome succeeded and
  `"partial"` when any did not — never a single blanket failure.
- **Fixed scheduling.** Concurrency is capped at 2 and the wall-clock budget is
  120 s; an entry still running when the budget runs out reports `timeout` (`504`)
  with no partial write. The response echoes the **bounds actually applied**, so
  the UI shows real limits rather than requested ones.
- **Reuse of the single-entry path.** Each entry runs through the same
  `reevaluateEntry` (§16.4), so the contracts — no substitution, no stale
  economics, total error handling — hold identically inside a batch.

### 16.7 Route contracts and failure isolation

All routes share one validation module, `src/lib/watchlist/watchlist-http.ts`, so
the same request is validated the same way everywhere and the same rule is never
re-implemented per endpoint. The boundary's rules: a nameable but unusable value is
**rejected with a reason** (`400`), never silently coerced into a default that
could hide a client bug; every response carries `Cache-Control: no-store`; every
route is `force-dynamic` — monitoring answers are never cached proxies of a stale
decision; nothing echoes a credential, a token or a raw upstream payload; and the
optional `detail` of an error may name an *environment variable* (those names are
public in `.env.example`) but never a value.

| Route | Purpose | Success | Named errors |
| --- | --- | --- | --- |
| `POST /api/watchlist` | save a scope | `200` `inserted` \| `reused` | `400` `MALFORMED_BODY` `INVALID_ITEM_ID` `INVALID_SUPPLIER_PRODUCT_ID` `INVALID_QUERY` `INVALID_LABEL` `INVALID_DESTINATION` · `404` `NOT_OBSERVED` · `409` `WATCHLIST_FULL` · `503` `WATCHLIST_NOT_CONFIGURED` |
| `GET /api/watchlist` | list active entries (sorted, filtered) | `200` | `400` `INVALID_FILTER` · `503` `WATCHLIST_NOT_CONFIGURED` |
| `GET /api/watchlist/{id}/history` | the entry's timeline | `200` | `400` `INVALID_ENTRY_ID` · `404` `ENTRY_NOT_FOUND` · `503` `WATCHLIST_NOT_CONFIGURED` |
| `POST /api/watchlist/{id}/re-evaluate` | one fresh assessment | `200` verdict | `400` `INVALID_ENTRY_ID` `INVALID_DESTINATION` `MALFORMED_BODY` · outcome statuses below |
| `POST /api/watchlist/{id}/archive` | soft removal | `200` `archived` \| `already-archived` | `400` `INVALID_ENTRY_ID` · `404` `ENTRY_NOT_FOUND` · `500` `PERSISTENCE_FAILED` |
| `POST /api/watchlist/re-evaluate` | batch of named entries | `200` `ok` \| `partial` | `400` `ENTRIES_REQUIRED` `TOO_MANY_ENTRIES` `INVALID_ENTRY_ID` · `503` `WATCHLIST_NOT_CONFIGURED` |

A re-evaluation outcome maps to an HTTP status deterministically
(`outcomeToHttpStatus`). Verdict outcomes are `200` — they *are* the result — and
every other outcome is an honest, retryable state that left the entry untouched:

| Outcome | Status | Meaning |
| --- | --- | --- |
| `evaluated` · `no-candidates` · `economics-unavailable` | `200` | a fresh assessment was produced, persisted, and returned |
| `entry-not-found` | `404` | no entry exists with this id |
| `archived` | `409` | the entry is archived; re-evaluation is refused, not implied |
| `listing-unavailable` | `410` | the listing scrolled out of the replayed window |
| `candidate-not-resolved` | `410` | the saved supplier is no longer a candidate — never substituted |
| `timeout` | `504` | the batch's wall-clock budget elapsed before this entry finished |
| `upstream-error` | `502` | an eBay or CJ failure the attempt could not recover from |
| `not-configured` | `503` | the server has no eBay or CJ configuration, so nothing can be re-evaluated |

The watchlist deliberately **does not mint its own error vocabulary for upstream
failures**: `WatchlistErrorCode` extends the product-intelligence boundary's
`UpstreamErrorCode`, so an eBay auth failure or a CJ outage is reported with the
same code and the same retry semantics on both surfaces (§8.4).

**Failure isolation** is the contract that makes the whole layer safe to poke
manually: every non-`evaluated` outcome leaves the entry and every observation row
exactly where they were, and the last-known data stays on screen beside the reason.
No 5xx ever converts an entry to a different opportunity, and no 404 in the middle
of a batch silently drops the other entries.

### 16.8 Change since the previous evaluation

Every re-evaluation returns a comparison against the **immediately previous
assessment for that entry's exact scope**, computed by the pure module
`src/lib/watchlist/compare.ts` (zero imports, unit-tested without a database):

- **Numeric deltas** — score, confidence, match confidence, marketplace price,
  supplier cost, supplier shipping, landed cost, estimated profit, margin — each
  with `previous`, `current`, the signed `delta`, and a direction (`up`, `down`,
  `unchanged`, `unknown`). Money is normalized to **integer minor units** before
  subtraction, so no decimal float ever participates in arithmetic (§9.2).
- **Categorical changes** — band, confidence level, economics completeness —
  rendered as `previous → current` with an explicit `changed` flag.
- **Honesty about missing data.** `delta` is `null` when either side is missing;
  `direction` is `unknown` rather than fabricated as `unchanged`. The response
  carries `noPrevious: true` when this was the entry's first assessment — the UI
  then labels the figures as the first observation rather than as a change.
- **One comparison anchor.** The comparison is *previous vs current*, always two
  observations. The module is named for that: it computes **change since the
  previous evaluation**, never a trend, never growth, never momentum — two points
  cannot establish a direction of travel, and the docs never imply they can.

### 16.9 Sorting and filtering — honest about missing values

`src/lib/watchlist/sorting.ts` is pure: sorting and filtering happen **in code**, on
a bounded active-entry read (`WATCHLIST_MAX_LIMIT` rows at a time), never in SQL —
because entries legitimately lack assessments, and a sort that pushed "no data" into
an arbitrary position would silently lie about the opportunity's standing.

- **Missing values sink last**, and always deterministically — an entry with no
  assessment is *less* promising than one with a score, not alphabetically
  arbitrary. Entries never assessed sort below every assessed entry, under a
  **fixed, documented order** rather than by id.
- **No invented tiebreak.** Ties are broken by entry id, a stable total order —
  never by a secondary heuristic that would make the list order unstable between
  requests with identical data.
- **Every sort key is a transparent existing field** (§16.1): score — tiebroken by
  confidence; profit — tiebroken by score; margin — tiebroken by profit;
  `recently-evaluated` — never-evaluated entries land in a deterministic position,
  not a random one. No new score is computed to order the list, and the response
  echoes the sort key actually used.
- **Filters apply strictly**: `band`, `confidenceLevel`, `completeness`,
  `profitability` (an entry whose assessment reports a negative profit is never
  `profitable`) and `supplierScope` (`pair` / `marketplace-only` — the honest
  vocabulary for §16.2). An **unrecognized filter value is rejected** with
  `400 INVALID_FILTER`, not silently ignored, so a typo in `?band=HGH` is visible
  instead of returning every entry; the response echoes back every filter that was
  actually applied.
- **Pagination is bounded, not infinite**: one bounded read per request, and the
  response reports the `limit` that was applied.

display the real bounds rather than the ones it asked for. Responses carry no
credentials and no raw provider payloads. Statuses: `ok`/`partial` → 200;
validation and pipeline failures → 400/404/413; missing configuration → 503;
upstream failures → 502/429.

