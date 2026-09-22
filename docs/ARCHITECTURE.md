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
of final scores. See `docs/DATABASE.md`.

### 6.6 Watchlist Monitoring

Periodically re-evaluates watched items and reports meaningful change (price,
stock, score, competition) without re-scanning the entire marketplace.

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

## 9. Opportunity Engine (conceptual)

The **Opportunity Score** is:

- **deterministic** — same inputs + same weighting version ⇒ same score;
- **versionable** — the weighting model has a version that is stored alongside
  the score;
- **explainable** — AI may *explain* a score; AI must **not** invent the
  numerical score.

Candidate input signals:

- demand, competition, estimated profit, margin, sales velocity,
  seller saturation, supplier availability, stock, shipping speed/cost,
  price stability, trend.

Raw metrics are stored independently of the final score (see
`docs/DATABASE.md`) so a score can be recomputed when the weighting model
changes.

The architecture must **not** permanently hard-code an arbitrary weighting
model. A preliminary model may be documented **as an example only**, clearly
labeled provisional.

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