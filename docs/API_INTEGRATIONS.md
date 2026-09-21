# Inkora — API Integration Strategy

> **Status: Authoritative strategy.** The eBay **product-search** integration is
> implemented (see §2.1); CJdropshipping and all other adapters remain pending.

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

Use CJ's official API.

### Expected functional areas

- product search
- categories
- product details
- variants
- SKU / VID
- inventory
- pricing
- logistics
- shipping quotes where supported
- warehouse / location information where supported

### Strategic note: US warehouses

**US warehouse availability is especially important for the initial eBay
strategy** — delivery time to US buyers, shipping cost predictability, and
marketplace trust signals. Inventory lookups should prefer and flag
US-warehoused stock where the API supports it.

### Authentication / token handling (conceptual)

- CJ credentials are read from **environment variables only**.
- The access token is obtained server-side, cached with its expiry, and
  refreshed automatically.
- Credentials are never exposed to the frontend and never logged.

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

Each step is deterministic where it touches money, and each emitted value is
provenance-tagged.

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

Not implemented yet (arrive in later, individually reviewed stages — see
`docs/ROADMAP.md`):

- CJ API calls of any kind.
- eBay category, item-detail, and seller-centric calls beyond the search
  summary fields.
- Token storage/refresh for user-scoped access (the authorization-code grant,
  `connected_accounts`). Client-credentials only, so far.
- Product matching, opportunity scoring, snapshots, watchlists.
- Any adapter other than `EbayAdapter`.
