# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Clenaris — a SaaS platform for cleaning companies in Kanton Bern, Switzerland. Next.js 15 (App Router) · React 19 · TypeScript · Tailwind · Prisma 6 · PostgreSQL 16+.

**The entire product is German-language.** UI strings, error messages, code comments, doc-comments and commit messages are all German. Match that — an English comment in a German file is a defect, not a style preference. Swiss German orthography: `ss`, never `ß`.

Swiss specifics are load-bearing, not decoration: 8.1 % VAT, QR-Rechnung per SIX v2.3, gapless document numbering under Art. 957a OR, AHV/ALV/BVG/UVG payroll.

## Commands

```bash
npm run dev            # Dev server (Turbopack)
npm run build          # prisma generate + next build
npm run start:built    # Serve an existing build (no rebuild)
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm run format         # Prettier

npm run db:migrate     # Create + apply a migration (dev)
npm run db:deploy      # Apply migrations (prod)
npm run db:seed:demo   # Config seed + demo records — what tests need
npm run db:studio
npm run erd            # Regenerate docs/DATABASE.md
npm run openapi        # Regenerate OpenAPI + docs/API.md
```

`npm run docs` fails if any route is undocumented — run it after adding an endpoint. `npm run erd` fails if a Prisma model is missing from `DOMAINS` in `scripts/generate-erd.ts`; add new models there. `npm run db:reset` exists as a script but is off-limits (see Conventions).

Utility scripts run with `npx tsx scripts/<name>.ts`. Scripts that import services must load `scripts/server-only-stub.cjs` first (see `scripts/backfill-kpi.ts`), because the services import `server-only`.

### Tests

Tests drive the **running application over real HTTP**; there are no unit tests of services, deliberately (see `tests/README.md`). They need a seeded DB *and* a live server:

```bash
npm run db:deploy && npm run db:seed:demo
npm run build && npm run start:built     # dev server works but is slower and renders differently

npm test                                     # all (~1-2 min, serial)
npm run test:api
npm run test:pages
npx tsx --test tests/api/two-factor.test.ts  # single file
```

`TEST_BASE_URL` overrides the target. Tests run with `--test-concurrency=1` — they share one database and the same five demo accounts, so parallelism produces false failures, not speed. A 429 mid-run is expected (the login rate limit works); the client in `tests/helpers/client.ts` waits it out. Don't run an ad-hoc HTTP check script while `npm test` is running: `two-factor.test.ts` temporarily changes the manager's role.

Test conventions worth knowing before writing one: `loginAll()` from `tests/helpers/accounts.ts` returns a cookie jar per role; `data(response)` unwraps the `{ data }` envelope; every test cleans up *before* and after itself (a 409 from a previous aborted run is not a product bug). Zod failures come back as **422**, not 400, and a manager hitting a resource without any permission gets **403**, not 404. `tests/pages/smoke.test.ts` lists every page per role — add new pages there. `db:seed:demo` is idempotent and also repairs the demo customer account if an aborted test run disabled it.

### Running the app locally

`npm run start` rebuilds first. To iterate, use `npm run build` then `npm run start:built` — and remember **a production server does not pick up code changes until you rebuild.** If edits seem to have no effect, check whether you're on `next start` with a stale `.next`.

**Stop the server before `npm run build`.** The build runs `prisma generate`, which replaces the Prisma query-engine DLL; a running `next start` holds that file open on Windows and the build fails with `EPERM … rename query_engine-windows.dll.node`. It looks like a Prisma error but is only a file lock.

Starting the server as a tracked background task risks it being killed under memory pressure. Detached survives:

```powershell
Start-Process node -ArgumentList "node_modules\next\dist\bin\next","start" -WindowStyle Hidden
```

Demo logins are in `README.md`; `admin@clenaris.ch` is the admin.

## Repository layout

```
src/app/(marketing)/      public website, statically rendered, CMS-driven
src/app/(app)/admin/      administration (SUPER_ADMIN, ADMIN, MANAGER)
src/app/(app)/portal/     employee portal
src/app/(app)/konto/      customer area (shared profile page lives here)
src/app/api/              route handlers; /api/public/* need no session, /api/cron/* need CRON_SECRET
src/server/services/      all business logic; the only place that writes to Prisma
src/lib/validation/       every Zod schema (feeds runtime validation and the OpenAPI spec)
src/lib/auth/             permissions.ts (catalog), rbac.ts (role grants, route guards), session.ts
src/features/<area>/      client components for one area (admin, portal, account, fuehrung, shared)
src/components/app/       shared app-shell building blocks: page-parts, data-list, resource-form, action-button
scripts/openapi-routes*.ts registry that must mirror every route's guard and schemas
tests/api, tests/pages    HTTP tests against the running server
```

A page file under `src/app` may export only `default`, `metadata`, `dynamic` and the other Next segment config — an extra exported constant breaks the build. Put field specs and helpers in `src/features/…`.

How a request reaches a page: `src/middleware.ts` checks the token signature and `ROUTE_GUARDS` (area by role), then `PERMISSION_ROUTES` in `rbac.ts` (first matching prefix wins, so specific paths go before their parent); the layout builds the navigation and filters it with `filterNavigation`; the page calls `requirePermission()` and decides with `can()` which buttons to render. All four layers must agree when you add a page.

## Architecture

`docs/ARCHITECTURE.md` explains the *reasoning* behind each decision and is worth reading before any non-trivial change. The load-bearing rules:

**Read in Server Components, write through Route Handlers.** Lists and detail pages query Prisma directly. Every mutation goes through a route handler, because permission checks, validation, rate limiting and the audit log live there and only there. Server Actions are not used for writes — two write paths would mean two security levels. React Query covers only what changes while you watch: calendar, price preview, messages, notifications.

**All business logic lives in `src/server/services/`.** Route handlers translate HTTP into service calls. Server Components read directly but never write.

**Every endpoint is declared through a factory** (`src/lib/api/handler.ts`): `defineRoute` (session required), `definePublicRoute` (session optional), `defineCronRoute` (Bearer `CRON_SECRET`). An endpoint declares `permissions`, `body`/`query`/`params` schemas and `rateLimit`. There is no way to write a route without declaring its protection — keep it that way.

**Permissions are flat `resource:action` strings** resolved statically per role in `src/lib/auth/rbac.ts` — no permission table, no DB hit per check. `ActorRole` includes the pseudo-role `GUEST`, which is deliberately absent from the DB enum. `SUPER_ADMIN` alone holds `role:assign`, `audit:read`, `user:impersonate`. Ownership constraints (`*:read_own`) belong **in the Prisma query**, not in rendering — hidden HTML is still visible on the wire.

**Sessions refresh silently and end after 15 minutes of inactivity.** The access token lives 15 min; the middleware bounces an expired page request through `GET /api/auth/refresh?weiter=…`, `lib/api/client.ts` retries a 401 once after `POST /api/auth/refresh`, and `SessionKeepalive` in the app shell refreshes proactively while the user is active and logs out after `SESSION_IDLE_TTL` idle. The refresh service refuses tokens older than that window, so the sliding window is enforced server-side too.

**Middleware is a pre-filter, not authorization.** It runs on Edge, verifies only the access-token *signature*, and cannot use Prisma. Binding checks happen in each handler and Server Component. A suspended account survives up to 15 minutes on a valid token; that's an accepted trade.

**All Zod schemas live in `src/lib/validation/`** — never inline in a route. One source feeds runtime validation, `z.infer` types and the OpenAPI spec.

**Errors are typed classes** in `src/lib/errors.ts`, mapped by `toErrorResponse`. `BusinessRuleError` is 422, not 400: 400 means the input was malformed, 422 means the operation is impossible in the current state, and that distinction decides whether a retry makes sense. Messages are user-facing German; internals never leak.

**Single tenant, multi-tenant schema.** `getOrganizationId()` in `organization.service.ts` resolves the org from a fixed slug. Every query scopes by `organizationId` — put it in the `where` clause so a foreign record simply isn't found.

**Money and time.** `Decimal(12,2)` for amounts, converted with `toNumber()` only at the display edge. `timestamptz` in UTC, displayed in Europe/Zurich.

**Prices are computed server-side only** (`src/lib/pricing/engine.ts`). The booking form calls `/api/public/pricing/estimate` on every change and displays what the server computed. The full derivation is stored as `priceBreakdown` on the booking.

**Financial records are append-only.** An issued invoice is never modified or deleted; corrections are credit notes. Invoice numbers are assigned on *issue*, inside the same transaction as the document, so a rollback leaves no gap.

### Unternehmensführung (BI / Strategie)

`/admin/fuehrung` — Cockpit, Kennzahlen, Ziele (OKR/Strategie/Roadmap in *einem* `Objective`-Modell), Budget, Investitionen, Szenarien, Risiken, Qualität/Compliance, Massnahmen, Dokumente, Wissen, Markt (SWOT/PESTEL), Sitzungen, Berichte, Assistent. The design rationale is in `docs/bi/`. Load-bearing rules:

- **KPI history is stored, never recomputed on read** (`KpiSnapshot`; the running period is `provisional`). Calculators live in `KPI_CALCULATORS` in `kpi.service.ts`; a `DERIVED` definition without a calculator is a config error the nightly run reports. Pure math (health score, depreciation, variance, scenario) is in `src/lib/bi/math.ts` and tested directly in `tests/api/bi-rechenkerne.test.ts`.
- **Periods are Zurich-local** (`src/lib/bi/periods.ts`); `periodStart` is a plain calendar day.
- **Document visibility is in the Prisma `where`** (`documentVisibilityWhere`); `EMPLOYEE_PRIVATE` = management + the subject employee only. Downloads are audited.
- **The nightly run** (`runFuehrungNightly`, wired into `/api/cron/daily`) writes snapshots, syncs automatic key results, stores the health score, bundles due-review notifications, warns about expiring documents, and runs report schedules. After a fresh DB: `npx tsx scripts/backfill-kpi.ts --months 24`.
- **The AI assistant only drafts** (`/api/bi/assistant`); every answer carries `reasoning`, `dataSources`, `confidence`. No personal data is sent.
- Permissions: group `'Unternehmensführung'` in `permissions.ts`; MANAGER sees cockpit/KPIs/objectives/controls/meetings, not budget/finance/risk register/documents. EMPLOYEE gets `objective:read_own`, `objective:checkin`, `knowledge:read`, `document:read_own`.

### CMS / website content

Editorial text is registry-driven: `src/lib/cms/registry.ts` declares every editable block (key, kind, label, default). The default **is** the shipping text, so adding a block changes nothing until someone edits it. Pages render via `createCms(content, preview)` from `src/lib/cms/editable.tsx`:

- `cms.text(key)` — returns a `ReactNode`; in preview it wraps the text in a clickable span carrying `data-cms-key`.
- `cms.raw(key)` — plain string, for attributes.
- `cms.attrs(key)` — marker for a surrounding element (lists, component props).
- `cms.asset(entity, id, field)` — marker for a record-backed image.

Marketing components take `ReactNode` (not `string`) for labels precisely so these wrappers survive. **Outside preview mode none of these markers exist in the HTML** — visitors get byte-identical output. Verify that when touching this layer.

Editing happens in `/admin/inhalte`: the real site runs in an iframe in draft mode, clicking text focuses the matching field. Text follows draft → publish → revision history. **Images do not** — they belong to records (`GalleryItem`, `Service`, `BlogPost`), are written straight through `PATCH /api/content/asset`, and are guarded by the allowlist in `src/lib/cms/assets.ts`. Never let an entity/field pair from a request reach Prisma without passing that allowlist.

Note: the iframe must point at the page path directly. Pointing it at the preview endpoint and letting it follow the redirect fails — Chrome aborts redirected navigations inside frames and lands on a cross-origin error page. Draft mode is armed separately via `GET /api/content/preview?nur=1` (204).

### Optional services

The app runs fully without Supabase, Redis, Stripe, Resend, Twilio or Anthropic — each missing service disables its feature rather than failing. Without `REDIS_URL` rate limits are per-process; without Supabase, uploads fall back to a local Postgres blob driver (`src/lib/storage/`).

## Conventions

**Comments explain *why*, at length.** This codebase documents the reasoning behind decisions — the rejected alternative and the failure it prevents — not what the code does. Match the surrounding density; terse comments read as unfinished here.

**Migrations, never `prisma migrate reset`.** Earlier migrations have been hand-edited, so Prisma may propose a destructive reset. Don't take it. The non-destructive path is `prisma migrate diff` → SQL file → `prisma db execute` → `prisma migrate resolve --applied`.

**Write files with the Write/Edit tools, not PowerShell redirection.** Shell writes here have twice corrupted files with a BOM or literal control characters (Postgres rejected a migration over a UTF-8 BOM).

**`git` is not on PATH in this environment.** Don't assume commits are possible.

**Ownership lives in the query, and `tests/api/ownership.test.ts` proves it.** `property:read`, `message:read_own` and similar scoped permissions are held by customers and employees too; the route must narrow the `where` clause per role (see `src/server/services/property.service.ts`). A smoke test that only checks the status code will not catch a leak — add a case to the ownership suite when touching role-scoped data.

**CRUD in the UI goes through two shared building blocks.** `src/components/app/resource-form.tsx` (`ResourceForm`/`FormDialog` driven by a `FieldSpec[]`, server-side Zod errors land on the field) and `src/components/app/action-button.tsx` (`ActionButton` for POST/PATCH/DELETE with confirmation dialog). Every list or detail page decides with `can()` on the server whether to render them, and the endpoint checks again. Soft-deleted records of the seven recyclable models are restored from `/admin/papierkorb` (`trash.service.ts`); there is no per-list "deleted" filter. Before adding a form, check whether an endpoint already exists — the 2026-09-13 audit found more than a dozen endpoints without any UI.

**`npm run openapi` verifies guards, not just coverage.** The registry in `scripts/openapi-routes.ts` must state the same `permissions`/`roles`/public/cron protection as the route source; `perm()` only accepts names from the permission catalog.
