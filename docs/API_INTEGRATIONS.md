# Inkora — API Integration Strategy

> **Status: Authoritative strategy.** The eBay **product-search** integration is
> implemented (see §2.1); the CJdropshipping **supplier-search** integration is
> implemented (see §3). All other adapters remain pending.

## 1. General integration rules (all adapters)

- Use **official** APIs whenever practical. Never scrape where an API exists.
- Never fabricate a metric the API does not return.
- Every persisted value carries a **provenance** class (OFFICIAL / OBSERVED /
  ESTIMATED) — see `docs/ARCHITECTURE.md` §7.
- Every record carries a **freshness / `last_updated`** timestamp.
- Fail loudly and safely: a missing field is stored as null, never guessed.

### Cross-cutting concerns every adapter must handle

| Concern | Requirement |
| --- | --- |
| **Pagination** | Cursor/offset per the API spec; no silent truncation of result sets. |
| **Rate limits** | Respect published limits; surface remaining/quota where returned. |
| **Caching** | Cache idempotent reads with an explicit TTL and freshness timestamp. |
| **Retries / backoff** | Exponential backoff with jitter for transient errors; no retry storms. |
| **Timeouts** | Explicit per-request timeouts; never hang indefinitely. |
| **Token refresh** | Automatic refresh before expiry; refresh failures surface cleanly. |
| **Failure handling** | Distinguish 4xx (do not blindly retry) from 5xx (retryable). |
| **Stale data** | Serve stale data only when clearly marked as stale. |
| **Observability** | Structured logs without secrets; per-request duration and status. |

**Logging rule:** secrets, tokens, and credentials are never logged.

## 2. eBay

Use official eBay APIs whenever practical.

### 2.1 Implemented — product search (vertical slice)

The first marketplace vertical slice is live: **Product Scanner UI → Inkora
server → official eBay API → normalized model**. Everything in this section is
implemented code, not a plan.

**Official API selected.** The **eBay Browse API (v1)** search method:

```text
GET {baseUrl}/buy/browse/v1/item_summary/search?q=<query>&limit=<n>&offset=<n>
```

It is an official, RESTful eBay API for discovering *active* marketplace
listings available to the authenticated application, and it returns item
summaries (title, price, image, URL, seller, location, condition, shipping) —
everything the normalized model needs without a second call.

**Authentication.** OAuth2 **client-credentials grant**, which mints an eBay
*Application access token*:

```text
POST {baseUrl}/identity/v1/oauth2/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(EBAY_CLIENT_ID : EBAY_CLIENT_SECRET)

grant_type=client_credentials&scope=<scopes>
```

No user-consent flow is required for this slice: Inkora searches as the
application itself, which the Browse API search method explicitly accepts.
Tokens are cached **in-process** with their expiry and reused until they are
about to expire (60s safety margin), so a new token is requested only when
necessary — no Redis or other infrastructure dependency is introduced for token
caching at this stage. If eBay rejects the requested scope (`invalid_scope`),
the request falls back exactly once to the default public scope
(`https://api.ebay.com/oauth/api_scope`) and logs a safe warning.

**Environments.** `EBAY_ENV` selects the target — `sandbox`
(`https://api.sandbox.ebay.com`) or `production` (`https://api.ebay.com`) — by
configuration only, never by editing code. The active environment is reported
in the API response and rendered in the UI, so sandbox data can never be
mistaken for production data.

**Request context.** `X-EBAY-C-MARKETPLACE-ID: EBAY_US` pins the marketplace
site, aligning the slice with the US-focused sourcing strategy (see §3).

**Environment variables** (see `.env.example`; values are server-side only and
never committed, logged, or sent to the browser):

| Variable | Required | Purpose |
| --- | --- | --- |
| `EBAY_ENV` | yes | `sandbox` or `production`. Defaults to `sandbox` when unset. |
| `EBAY_CLIENT_ID` | yes | Keyset client id (App ID). |
| `EBAY_CLIENT_SECRET` | yes | Keyset client secret (Cert ID). |
| `EBAY_SCOPE` | no | Space-separated OAuth scopes. Defaults to `https://api.ebay.com/oauth/api_scope.buy.item.summary`. |
| `EBAY_REDIRECT_URI` | not for this slice | Only needed by the authorization-code grant (user-scoped access). Unused by client-credentials. |

**Normalization.** Raw eBay responses are never handed to the UI. `EbayAdapter`
maps each `itemSummary` into the provider-independent `MarketplaceProduct`
(see `docs/ARCHITECTURE.md` §4). Money is carried as decimal strings, never
floats. The cheapest *priced* shipping option becomes `shippingCost`. eBay
serializes `seller.feedbackPercentage` as a numeric *string* (`"98.7"`); it is
parsed into a number so the model carries a real percentage. Fields eBay does
not return are `null` — never guessed, never defaulted, never converted into a
fake estimate.

**Provenance.** Every value this slice emits comes straight from the official,
authenticated eBay API, so the record carries provenance **OFFICIAL**, and the
UI labels it as such (`Source: eBay API · OFFICIAL`). Unavailable fields stay
`null`, not estimated. Critically, this endpoint returns *active listing*
information; Inkora never presents it as confirmed sales volume
(see "Hard constraint on sales data" below).

**Limitations (honest).**

- Only `FIXED_PRICE` (Buy It Now) listings are returned by default; auction
  listings need the `buyingOptions` filter (not built yet).
- A search result set is capped at 10,000 items by eBay.
- For US listings eBay is replacing `seller.username` with an immutable user
  id; `sellerName` is therefore normalized as "whatever identifier eBay
  returned", not assumed to be a human display name.
- Shipping cost is absent for many listings and stays `null`; "free shipping"
  is shown only when eBay explicitly prices it at `0.00`.
- No images are downloaded or stored; the normalized `imageUrl` points at
  eBay's own CDN (image matching comes later).
- Search results are transient — nothing is persisted in this slice
  (see `docs/DATABASE.md`).

**Rate limits / errors.** The adapter applies proportionate resilience: an
explicit per-request timeout; exponential backoff with jitter for network
failures, HTTP 429 and HTTP 5xx, honoring `Retry-After` when eBay sends it; no
retry for other 4xx; exactly one re-authentication on a stale-token 401; and
rejection of malformed JSON. Failures collapse to a small set of safe,
generic error codes at the API boundary — no upstream payload, token, or
credential is ever forwarded to the browser. When eBay rejects the client
credentials, the response's `detail` names the standardized OAuth2 error code
(e.g. `invalid_client`), which is a fixed public identifier (RFC 6749 §5.2)
and carries no secret — only that whitelisted code is surfaced, never the raw
upstream description.

**Verified live (production).** This slice has been exercised end-to-end
against the real production eBay API (`EBAY_ENV=production`) with an approved
keyset — not a mock, not the sandbox:

- OAuth2 client-credentials succeeds, and the application access token is
  reused across searches: the in-process cache is observable as the first
  search paying the token round trip while subsequent searches do not.
- The documented scope fallback is exercised in production: this keyset is not
  entitled to the Browse API search scope under the client-credentials grant,
  so eBay returns `invalid_scope` and the adapter retries exactly once with the
  default public scope, which succeeds.
- `GET /api/marketplaces/ebay/search?q=wireless%20earbuds` returns HTTP 200
  with `"environment": "production"` and 24 normalized products per page
  against a live result count in the hundreds of thousands (the exact total
  fluctuates call to call — that is live inventory churn, not instability).
- Every normalized field was cross-checked against the raw `itemSummary`
  payload: title, price/currency, listing URL, image URL, condition, seller
  name, cheapest priced shipping, and item location all match; money is
  emitted as decimal strings and absent fields as `null`.
- The Product Scanner (`/products`) renders that same normalized payload
  end-to-end, including the seller feedback percentage.

### 2.2 Implemented — seller-scoped search (Seller Scanner)

The Seller Scanner reuses the §2.1 slice's authentication, token cache,
timeout, backoff, and error handling without change; it only narrows the same
search call to one seller:

```text
GET {baseUrl}/buy/browse/v1/item_summary/search?q=<query>&filter=sellers:{<handle>}&limit=<n>&offset=<n>&sort=newlyListed
```

Two behaviors of this filter were established against the live production API
before the module was written, and both shape the implementation:

- The `sellers` value requires **braces** around the handle and **must be paired
  with a search context** (a `q`, `category_ids`, `gtin`, or `epid`). A
  seller-scoped search with no context is answered with HTTP 400, so a query is
  always required — there is no "list everything this seller has" call.
- eBay can **warn about the filter itself**, and a warned response may be an
  *unfiltered* result set rather than the seller's. Warnings are therefore not
  ignorable: when a warning concerns the `sellers` field the scan fails the
  fetch rather than reporting results that may belong to someone else.

Unlike the plain product search (§2.1, transient), seller-scoped results **are
persisted** as marketplace history — one `marketplace_product_snapshots` row per
listing observation plus one seller observation per scan — so repeated scans
become change detection rather than independent snapshots
(see `docs/DATABASE.md` §6.10 and `docs/ARCHITECTURE.md` §17). Exposed through
`POST /api/sellers/scan` and the Seller Scanner UI (`/sellers`).

**Limitations (honest).**

- A seller-scoped search can only enumerate listings that match the paired
  query; it is a *sample* of a seller's catalogue scoped to that query, never a
  census. Absence from the sample is reported as "not in this sample", never as
  "the seller stopped selling it".
- eBay is replacing `seller.username` with an immutable user id for US listings
  (see §2.1), so the handle the caller supplies is matched case-insensitively
  and the persisted seller identifier is whatever eBay returned.

### Expected functional areas

- product / listing discovery (search APIs)
- seller information where available
- prices
- categories
- item identifiers
- images
- location
- shipping information
- condition
- attributes
- authenticated functionality when required

### Hard constraint on sales data

Do **not** assume exact competitor sales numbers are available from official
APIs. Where a sales figure is needed and not returned officially:

- mark an observed signal as **OBSERVED**, or
- model an estimate as **ESTIMATED**, recording its method and inputs.

**Never fabricate an unavailable metric.**

### Authentication / token handling (conceptual)

- OAuth2 **client-credentials** grant for application access where sufficient.
- **Authorization-code** grant with `connected_accounts` storage when
  user-scoped access is required.
- Tokens and secrets live **server-side / encrypted at rest only**.
- Client IDs and secrets are read from environment variables (see
  `.env.example`) — never hardcoded, never shipped to the frontend.
- Token refresh is automatic and logged **without secret values**.

### Environments

- Sandbox and production have distinct base URLs and token endpoints.
- The active environment is selected by **configuration**, never by editing
  code.

## 3. CJdropshipping

Use CJ's official API. CJ is the initial MVP supplier ecosystem (see §5).

### 3.1 Implemented — supplier product search (vertical slice)

The first supplier vertical slice is live: **Supplier Scanner UI → Inkora
server → official CJ API → normalized supplier model**. Everything in this
section is implemented code, not a plan. It is deliberately additive and
touches none of the eBay infrastructure (see §2.1).

**Official API selected.** The **CJ API 2.0** product-search method, served from
CJ's documented gateway:

```text
GET https://developers.cjdropshipping.com/api2.0/v1/product/listV2?keyWord=<q>&page=<n>&size=<n>
```

`listV2` is CJ's Elasticsearch-backed product search — the official, RESTful
catalogue discovery endpoint — and returns products with title, main image,
selling price, SKU and category in a single call. (Per CJ's FAQ, `listV2` returns
no variants and no variant `vid`; variants come from the product-detail endpoint
in a later stage, and `productUrl` stays `null` rather than being synthesized.)
Inkora sends CJ's
`page`/`size` pagination (1-based page, `size` capped at CJ's documented ceiling
of 100); the request `limit`/`offset` are converted at the adapter boundary.

The base URL is overridable with `CJ_API_BASE_URL` (configuration only, never by
editing code) and defaults to the real production gateway. Nothing in the code
substitutes a mock or sandbox for the real endpoint.

**Authentication.** CJ authenticates with an **API key** issued by the account —
not the sign-in email/password — exchanged once for an access token:

```text
POST {baseUrl}/v1/authentication/getAccessToken
Content-Type: application/json

{ "apiKey": "<CJ_API_KEY>" }
```

The returned access token is sent on every subsequent call in CJ's
`CJ-Access-Token` header. Inkora additionally implements the documented
`POST /v1/authentication/refreshAccessToken` grant (`{ refreshToken }`), which
is preferred for rotation once a refresh token is on hand.

**Token lifecycle.** CJ's token envelope publishes no `expires_in`, so expiry is
handled *failure-driven* rather than by a clock: the access token is cached
**in-process** only and reused until CJ rejects it, at which point the adapter
refreshes (or, failing that, re-authenticates with the API key) **exactly
once** and retries the original request. This minimizes token requests while
never using a credential CJ has revoked. No Redis or other infrastructure
dependency is introduced for token caching. Access/refresh tokens are
confidential: they are never written to logs and never returned to the browser.

**Environments / configuration.** Required: `CJ_API_KEY` (a CJdropshipping API
key — *not* the account sign-in email/password). Obtain one per CJ's docs: sign
in at cjdropshipping.com, then *Apps → Install App → App Store → "Others" →
"API"*, or open `https://www.cjdropshipping.com/my.html#/authorize/API` → *API*
tab → *Add API* (name it, choose *API Key* as the type). Optional:
`CJ_TOKEN` (a pre-obtained access token that seeds the cache) and
`CJ_API_BASE_URL`. If the required variable is absent, the routes return a
safe `503 CJ_NOT_CONFIGURED` instead of crashing, and the Supplier Scanner shows
a configuration message. The key is read from an environment variable only,
never hardcoded, and uses no `NEXT_PUBLIC_` prefix so it can never reach a
client bundle.

**Normalization.** Raw CJ rows are mapped once, at the adapter boundary, into the
provider-independent `SupplierProduct` model (`docs/ARCHITECTURE.md` §5). CJ
wraps the V2 page two levels deep (`data.content[].productList`); the adapter
tolerates that documented shape, a flattened `content`, and the legacy `list`
field, and reports `data.totalRecords` as the result count — or `null` when CJ
sends none, never a guess. CJ returns titles in both Chinese (`name`) and
English (`nameEn`); English is preferred and Chinese is the fallback, so a
product is never dropped merely for lacking an EN title. CJ documents `sellPrice`
as a USD amount, so `currency` is set to `"USD"` wherever a price is present and
`null` otherwise; prices are carried as decimal strings (never floats).

### 3.2 Inventory / warehouse semantics (US stock)

Product search does **not** expose inventory or warehouse country — an available
CJ product is *not* evidence of US stock, and Inkora never infers it. To
establish warehouse country for a selected product, the slice implements one
narrow additional official endpoint:

```text
GET {baseUrl}/v1/product/stock/queryBySku?sku=<cj-sku>
```

It returns per-warehouse stock rows carrying `countryCode` /
`countryNameEn` (the warehouse's country), `areaEn` (warehouse name), and CJ's
two stock dimensions: `cjInventoryNum` (stock CJ manages in its own warehouses)
and `factoryInventoryNum` (stock held by the partner factory). Inkora models
`totalInventoryNum` as the total across dimensions. CJ answers inventory
endpoints in one of several documented shapes (a bare array of rows, an
`inventories` object, or variant-grouped `variantInventories`); all are accepted,
and an unrecognized shape yields **no** rows rather than a guess.

The response classifies US availability into exactly three honest states:

| Verdict | Meaning |
| --- | --- |
| `CONFIRMED_AVAILABLE` | A US warehouse row with positive quantity was returned. |
| `CONFIRMED_NONE` | Usable warehouse rows were returned, none of them US with stock. |
| `UNKNOWN` | No usable warehouse rows (or an uninterpretable response). Never an estimate. |

**US warehouse availability is especially important for the initial eBay
strategy** — delivery time to US buyers, shipping cost predictability, and
marketplace trust signals — which is why the verdict is computed explicitly
rather than assumed. Shipping origin/cost is not returned by these endpoints and
remains `null`; no shipping time or cost is ever invented.

### 3.3 Limitations (stated, not hidden)

- `productUrl` is `null`: the search subset returns no canonical CJ product URL
  (only unrelated third-party/supplier-link fields). It is not synthesized.
- `currency` is `null`: the modeled subset returns prices with no currency code.
  No currency is assumed.
- `availableInventory` / `warehouseCountry` are `null` on search results; only
  the inventory endpoint (§3.2) populates them, per product.
- `shippingOrigin` is `null` (not provided by these endpoints).
- No CJ category, product-detail, logistics, or order endpoints are called —
  they are out of scope for this slice (see §6).
- Variant rows from the search subset are mapped defensively; fields the
  response does not carry stay `null`.

### 3.4 Provenance

Every value above is returned directly by the official, authenticated CJ API, so
search results and inventory rows both carry provenance **OFFICIAL**. The US
verdict is a deterministic classification *over* official rows; when rows are
absent it is reported `UNKNOWN`, never promoted to an estimate.

### 3.5 Error and rate-limit handling

- Explicit per-request timeouts (token 15s, calls 20s).
- Exponential backoff with jitter for network errors, HTTP 429 and HTTP 5xx,
  honoring `Retry-After` (capped) when CJ sends it; no retry of 4xx.
- CJ reports *logical* failures as **HTTP 200 with `result: false`** — the client
  checks the envelope, not just the status, and surfaces CJ's stable numeric
  `code` (never the raw upstream description) in the sanitized `detail`.
- An HTTP 401 drops the cached credential and re-authenticates exactly once.
- Malformed JSON is an error, never silently "no results".
- Missing fields degrade to `null` (partial-result tolerance); a product missing
  id or title is dropped rather than half-normalized.
- CJ publishes a per-call quota (`pointsInfo.remaining`); the remaining counter
  is logged as a safe operational signal. It carries no credential material.

### 3.6 Running the slice

```bash
npm run build && npm run start
# 1. The server-side API boundary
curl 'http://localhost:3000/api/suppliers/cj/search?q=wireless%20earbuds'
#    (inventory for one selected product)
curl 'http://localhost:3000/api/suppliers/cj/inventory?sku=<cj-sku>'
# 2. The UI
#    open http://localhost:3000/suppliers and search "wireless earbuds"
```

The browser never calls CJ directly. Both routes validate input, bound the
request, and translate every failure into a safe HTTP response carrying a stable
error code (`CJ_NOT_CONFIGURED`, `CJ_AUTH_FAILED`, `CJ_UPSTREAM_ERROR`,
`CJ_RATE_LIMITED`, `INVALID_QUERY`, `INVALID_SKU`) plus a secret-free `detail`
naming the variable to check — never a credential, token, or raw upstream body.

### 3.7 Bounded CJ usage by the Product Matcher

The Product Matcher (see `docs/ARCHITECTURE.md` §8) is a consumer of *these same
two endpoints*, and it is deliberately bounded so a single user action cannot
flood CJ:

| Concern | Bound |
| --- | --- |
| Generated CJ queries per match request | **≤ 3** (cleaned title, brand/model priority, optional short identifier) |
| Candidates retained per query | bounded; the set is capped before scoring |
| Deduplication | by CJ product id across all queries — one product, one score |
| Per-query failures | preserved and surfaced (`queryFailures`), never dropped |
| Inventory enrichment | only the **top** candidates after ranking, not every candidate |

The matcher never calls a CJ endpoint outside §3.1 and §3.2, and it never turns
a `UNKNOWN` inventory verdict into a zero or an availability claim.

### 3.8 Implemented — variant resolution and freight calculation (economics)

The economics layer (see `docs/ARCHITECTURE.md` §10) consumes two further CJ
endpoints, and *only* these:

| Endpoint | Purpose | Inputs |
| --- | --- | --- |
| `GET /v1/product/variant/query?pid=<pid>` | Resolve a catalogue product to its variants, each with its own cost, weight, and per-warehouse stock. | `pid` (the opaque `SupplierProduct.externalId`) |
| `POST /v1/logistic/freightCalculate` | Quote freight. One row per eligible shipping method (`logisticName`), with its USD price (`logisticPrice`) and transit-time range (`logisticAging`). | `startCountryCode`, `endCountryCode`, and one product row carrying `quantity` and `vid` |

The variant query exists because CJ's freight calculation is keyed on a
**variant id** (`vid`), not a product id or SKU — and the search endpoint
(§3.1) lists no variants. A catalogue candidate therefore *must* be resolved to
its variants before any shipping quote can exist. This is a hard dependency, not
an optimization: **no usable variants ⇒ no `vid` ⇒ no quote ⇒ economics stay
incomplete.** Inkora never invents, scrapes, or hardcodes a shipping figure.

Origin handling: when the selected variant has confirmed stock in the
destination country, that country is sent as `startCountryCode`; otherwise the
documented default origin (`CN`) is used. If a destination-warehouse origin
returns no methods, the call is retried **once** from the default origin — the
fallback is bounded, and a second failure is reported as "no shipping quote
available", never as a zero cost.

CJ requires `startCountryCode`, `endCountryCode`, and a product row with
`quantity` and `vid`; omitting any of them yields CJ's `1600300` error, which is
surfaced as a failure rather than interpreted as "free shipping".

**Provenance:** `logisticPrice` is `OFFICIAL` — it comes straight from CJ's
authenticated freight API. The *selection* of which quote to use is a
deterministic policy (`docs/ARCHITECTURE.md` §10.2), and every quote CJ returned
is kept on the result, not only the chosen one.


## 4. The sourcing pipeline (eBay → CJ)

```text
eBay opportunity
  → Product Matcher
  → CJ candidates
  → US inventory when available
  → supplier cost
  → shipping
  → landed cost
  → eBay fees
  → estimated profit
  → margin
  → Opportunity Score
```

The **stages through landed cost, eBay fees, estimated profit, and margin are
implemented** — eBay listing, Product Matcher, ranked CJ candidates, US inventory
when the inventory endpoint can confirm it (§3.2), then the deterministic
economics layer: CJ variant resolution and real freight quotes (§3.8), the
versioned eBay fee engine (§4.1), and the landed-cost → profit → margin
computation (`docs/ARCHITECTURE.md` §10).

Also implemented: the **Opportunity Score** (`docs/ARCHITECTURE.md` §9) and its
downstream layers — persistence and history over `opportunity_observations`
(`docs/ARCHITECTURE.md` §13, `docs/DATABASE.md` §6.8) and watchlist monitoring over
`watchlist_entries` (`docs/ARCHITECTURE.md` §16, `docs/DATABASE.md` §6.9). Every
economics computation is persisted after it succeeds, and a repeat observation
whose business fields are unchanged reuses one row rather than inserting again.

And the read surface over all of it: **Product Detail**
(`docs/ARCHITECTURE.md` §18), which assembles those persisted observations for one
listing. It is persisted-first — a normal load makes no eBay, CJ, freight or
scoring call — and the only path to fresh numbers is an explicit `POST` that replays
the search window and reuses the Watchlist's ports verbatim, so this page adds no
new upstream budget of its own and cannot drift from the pipeline that produced the
data.

Each step is deterministic where it touches money, and each emitted value is
provenance-tagged.

### 4.1 Fee source — eBay selling-fee policy

Inkora does not scrape fees and does not accept a fee figure from the browser.
The fee engine applies a **rule set** that is versioned (`ebay-us-1.0`) and
documented in every result, modeled from eBay's published US selling-fee policy
for standard (non-Store) sellers under managed payments:

| Component | V1 model |
| --- | --- |
| Final value fee | A single rate on the **total sale amount** — item price plus buyer-paid shipping — with a per-order minimum of $0.30. |
| Insertion (listing) fee | $0.00, under the stated assumption that the listing is within eBay's free monthly allotment. |

What the model **cannot** observe, and says so in every result:

- **Seller subscription.** eBay Store subscribers pay different rates; Inkora
  cannot see the seller's plan, so the standard rate is used and the fee is
  always `ESTIMATED`, never `EXACT`.
- **Tax on the fee basis.** eBay applies the final value fee to the total sale
  amount *including* applicable taxes, which Inkora does not have, so the
  modeled fee can understate the real charge.
- **Per-category maximums.** No category cap could be validated from official
  documentation available to this project, so none is asserted. Where a cap
  applies, the real fee is *lower* than this estimate.
- **Optional listing upgrades** (subtitle, gallery plus, reserve price, …),
  which are seller-elected and not observable from listing data.

The rules are structured as a category-keyed table so verified category rates
and caps land as new rows without changing the calculation path. Until they are
validated against official documentation, the table carries the general default
only — the seam is intentional, not an omission.

## 5. Supplier policy

Inkora prioritizes supplier/fulfillment ecosystems that can be accessed and
integrated **without requiring users to purchase recurring supplier
subscriptions** merely to source, import, or fulfill products.

**Initial ecosystem:** CJdropshipping — **AliExpress later.**

**Explicitly excluded from the roadmap:**

- Zendrop
- Spocket
- other paid supplier platforms, *unless* a future review determines their
  relevant sourcing/integration model is genuinely free and strategically
  useful.

The software may remain extensible through a generic **Supplier Adapter**
architecture. **Extensibility must not be interpreted as planned support for
paid suppliers.** No placeholder adapters, code, or configuration for excluded
platforms.

## 6. Implementation status

Implemented:

- **eBay product search** — the full vertical slice: OAuth2 client-credentials
  token acquisition with in-process caching, the official Browse API
  `item_summary/search` call, normalization into the marketplace model, a
  server-side API boundary, and the Product Scanner UI
  (see §2.1 and `docs/ARCHITECTURE.md` §4).
- **CJdropshipping supplier product search** — the full supplier vertical
  slice: API-key authentication with in-process token caching
  and failure-driven refresh/rotation, the official CJ API 2.0
  `product/listV2` search, per-SKU warehouse inventory via
  `product/stock/queryBySku` with an honest US-warehouse verdict,
  normalization into the supplier model, two server-side API boundaries, and
  the Supplier Scanner UI (see §3 and `docs/ARCHITECTURE.md` §5).
- **Product Matcher V1** — the deterministic, text-only link between the two
  slices: bounded CJ query generation, deduplicated candidate discovery,
  identifier/unit/brand-aware scoring with contradiction caps, and a
  confidence + band + signals verdict per candidate, exposed through
  `GET /api/products/matches` and the Product Scanner's *Find supplier*
  action (see §3.7 and `docs/ARCHITECTURE.md` §8).
- **Economics engine** — the deterministic money layer behind the matcher: CJ
  variant resolution and real freight quotes (§3.8), a versioned eBay fee rule
  set with stated caveats (§4.1), and a landed-cost → profit → margin
  computation that refuses to invent inputs — every missing value degrades an
  explicit `COMPLETE` / `PARTIAL` / `UNAVAILABLE` verdict instead. Exposed
  through `GET /api/products/economics` and the Product Scanner's *Calculate
  economics* action (see `docs/ARCHITECTURE.md` §10).
- **Opportunity Scanner V1** — the bounded orchestration layer that turns a
  search window into a ranked set of assessments: one replayed eBay search reused
  as competition evidence, a server-enforced batch (6 listings, concurrency 3, a
  90s budget) deep-evaluated through the matcher, the economics engine, and the
  Opportunity Engine, with per-item failure isolation and a deterministic ranking
  that introduces no score of its own. Exposed through `POST /api/scanner/scan`
  and the Product Scanner's *Opportunity Scanner* panel
  (see `docs/ARCHITECTURE.md` §15).
- **Seller Intelligence Scanner V1** — the seller-side mirror of the product
  slice: a seller-scoped eBay search (§2.2) normalized into per-listing
  observations plus one seller observation per scan, all persisted as history so
  a second scan becomes change detection (price/condition/shipping/title/seller
  changes, and listings present before but absent from the new sample), with
  cross-seller overlap analysis over up to `overlapAnalyses` distinct product
  families seeded from the seller's own sample. Exposed through
  `POST /api/sellers/scan` and the Seller Scanner UI (`/sellers`;
  see `docs/ARCHITECTURE.md` §17 and `docs/DATABASE.md` §6.10).

Not implemented yet (arrive in later, individually reviewed stages — see
`docs/ROADMAP.md`):

- CJ logistics, variant, and order endpoints beyond §3.8 — the economics layer
  uses variant resolution and freight calculation only; CJ's order-placement,
  tracking, and label-purchase surfaces are not part of V1 sourcing decisions.
- CJ category and product-detail endpoints beyond §3.
- eBay category and item-detail endpoints beyond the search summary fields. (A
  seller-scoped search *is* implemented — §2.2 — but it is still the
  `item_summary/search` method with a `sellers` filter, not a seller-profile or
  seller-report API.)
- Token storage/refresh for user-scoped access (the authorization-code grant,
  `connected_accounts`). Client-credentials only, so far.
- Image and semantic similarity signals for the matcher
  (see `docs/ARCHITECTURE.md` §8.4).
- Scheduled re-scanning (the scanner is user-triggered only, and Watchlist V1
  re-evaluates **on demand** — there is no scheduler, no alerting, and no
  background worker; see `docs/ARCHITECTURE.md` §15.4 and §16).
- Any adapter other than `EbayAdapter` and `CjAdapter`.
