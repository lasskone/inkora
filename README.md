# Inkora

**Cross-Marketplace E-Commerce Opportunity Intelligence Platform.**

Inkora answers: *What products are selling, where are they selling, how
competitive is the market, where can they be sourced, and which Marketplace ×
Supplier combination provides the strongest business opportunity?*

## MVP V1 scope

| Layer | V1 choice |
| --- | --- |
| Marketplace | **eBay** |
| Supplier / fulfillment | **CJdropshipping** |
| Database / backend | **Supabase (PostgreSQL)** |
| Source control | GitHub |
| Domain | [inkora.net](https://inkora.net) |

## Authoritative documentation

All project documentation lives in [`/docs`](./docs) and is the single source
of truth for AI-assisted development. **Read it before implementing anything.**

| Document | Role |
| --- | --- |
| [`docs/MVP_SPEC.md`](./docs/MVP_SPEC.md) | Authoritative MVP V1 product scope and boundaries. |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Architecture principles, adapters, core domain services, provenance. |
| [`docs/DATABASE.md`](./docs/DATABASE.md) | Supabase/PostgreSQL data model, entities, snapshots, RLS. |
| [`docs/API_INTEGRATIONS.md`](./docs/API_INTEGRATIONS.md) | eBay and CJdropshipping integration strategy and supplier policy. |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Phased roadmap and online-first validation strategy. |

## Repository status

**Application foundation stage.** A minimal Next.js application skeleton exists
(routing shell, health-check endpoint, safe server/client boundaries) but no
business features are implemented yet — see [`docs/ROADMAP.md`](./docs/ROADMAP.md).

## Developer setup

Requires Node.js and npm.

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables (never commit the real file)
cp .env.example .env   # then fill in real values

# 3. Run the development server
npm run dev            # http://localhost:3000

# 4. Validate
npm run lint           # ESLint
npm run typecheck      # TypeScript (tsc --noEmit)
npm run build          # production build
npm run start          # serve the production build
```

Health check: `GET http://localhost:3000/api/health`.

## Environment

- Copy `.env.example` to a local `.env` (Git-ignored) and fill in real values.
- **Never commit real secrets.** Never expose server-only variables to
  frontend code, and never print secrets in logs.

## What is intentionally absent

- No business features yet: no eBay/CJ integration code, no database schema or
  migrations, no authentication. The technical platform itself is established
  (see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §2).
- **No adapters for paid supplier platforms** (Zendrop, Spocket) — these are
  excluded by policy (see `docs/API_INTEGRATIONS.md`).
