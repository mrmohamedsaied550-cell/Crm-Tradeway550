# Trade Way / Captain Masr CRM

Multi-country, multi-company CRM for captain acquisition and activation across
Egypt, Saudi Arabia, Morocco, and Algeria, supporting partner companies
including Uber, inDrive, DiDi, Careem, and Yango.

## Status

> **Foundations only — no business features are implemented yet.**
>
> The repository currently contains the output of two execution chunks of
> Sprint 1:
>
> - **C1** — workspace skeleton, shared TypeScript / ESLint / Prettier configs.
> - **C2** — Docker dev runner, GitHub Actions CI, Husky + commitlint +
>   lint-staged, and a portable gitleaks wrapper.
>
> There is **no** auth, RBAC, database schema, API endpoint, web page,
> business entity, WhatsApp integration, Sheets sync, or Meta CAPI in the
> code yet. Everything described in the product and architecture documents
> lands incrementally in subsequent chunks (C3 onward).

## Authoritative references

The full scope and engineering plan live in three long-form documents that
travel alongside this repository (currently maintained outside the repo
until they are committed under `docs/`):

- **Master PRD v2.0** — unified product requirements: core CRM, UX & Admin
  control, WhatsApp Conversational Layer, Campaigns, Partner Sheets Sync &
  Reconciliation, Meta Lead Ads + Conversions API. 26 sections.
- **System Architecture Document** — engineering blueprint: tech stack
  decisions, module boundaries, realtime, integrations, MVP plan. 12 sections.
- **Sprint 1 Technical Backlog + Execution Chunks** — the chunked
  implementation plan currently in flight (C0 → C20).

These three documents are the source of truth for any "should the system do
X?" question. This README only describes what is actually present in the
repository today.

## Tech stack

Planned for the project, partially wired today:

- **Backend (planned):** Node.js 20, TypeScript, NestJS, Prisma, PostgreSQL 16,
  Redis 7, BullMQ, Socket.IO. **Today:** TypeScript scaffold only — no NestJS
  bootstrap yet (lands in C3).
- **Frontend (planned):** Next.js 14 (App Router), Tailwind + shadcn/ui,
  next-intl (AR / EN), PWA. **Today:** placeholder root layout only — no
  pages, no shell (lands in C4).
- **Shared workspaces:** `@crm/shared` (types, zod schemas — empty),
  `@crm/config-eslint`, `@crm/config-prettier`.
- **Tooling:** pnpm 9 workspaces, ESLint 8 + Prettier 3, Husky 9, commitlint,
  lint-staged, gitleaks (CI + local wrapper).
- **Local infra:** Postgres 16 + Redis 7 via `docker-compose.yml`.
- **CI:** GitHub Actions — install / typecheck / lint / test / build /
  secrets-scan / commitlint.

## Repo layout

```
.
├── apps/
│   ├── api/                # @crm/api  — placeholder; NestJS bootstrap lands in C3
│   └── web/                # @crm/web  — placeholder; Next shell + i18n land in C4
├── packages/
│   ├── shared/             # shared types + zod schemas (empty)
│   ├── config-eslint/      # base ESLint config
│   └── config-prettier/    # base Prettier config
├── scripts/
│   └── gitleaks.sh         # portable gitleaks wrapper (binary or docker)
├── .github/workflows/      # CI workflow
├── .husky/                 # pre-commit + commit-msg hooks
├── docker-compose.yml      # Postgres 16 + Redis 7 for local dev
├── tsconfig.base.json      # strict TypeScript baseline
└── package.json            # pnpm workspaces root
```

## Prerequisites

- Node.js 20+
- pnpm 9+ (`npm install -g pnpm`)
- Docker + Docker Compose (for the dev database)

## Quick start

```bash
pnpm install                          # installs workspaces; husky installs git hooks
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
pnpm dev                              # docker compose up + api + web in parallel
```

The `api` and `web` dev scripts currently print
`hello from @crm/api` / `hello from @crm/web` placeholders and exit. They
become real servers in **C3** (NestJS bootstrap, `/health`) and **C4**
(Next.js shell with auth pages and i18n).

## Available scripts

```
pnpm dev               docker compose, then api + web concurrently
pnpm dev:db            start Postgres + Redis
pnpm dev:db:down       stop Postgres + Redis
pnpm dev:db:logs       tail docker compose logs
pnpm dev:api           run @crm/api dev (placeholder today)
pnpm dev:web           run @crm/web dev (placeholder today)
pnpm typecheck         tsc --noEmit across all workspaces
pnpm lint              ESLint across all workspaces
pnpm build             tsc / next build across all workspaces
pnpm test              runs tests in any workspace that defines them (none yet)
pnpm secrets:scan      scan working tree for secrets via gitleaks wrapper
pnpm secrets:protect   scan staged changes for secrets
```

`pnpm db:migrate`, `pnpm db:seed`, `pnpm db:reset`, and `pnpm db:studio` are
defined as forwarding scripts but only become functional once Prisma lands
in **C5**.

## Conventions

- **Branching:** trunk-based, short-lived branches off `main`. Sprint 1 work
  lives on `claude/captain-masr-crm-prd-8za5i`.
- **Commits:** Conventional Commits (`feat`, `fix`, `chore`, `docs`,
  `refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`). Header ≤ 100
  characters. Enforced by `commitlint` via the `commit-msg` hook.
- **Pre-commit:** `lint-staged` formats and lints staged files;
  `gitleaks protect --staged` scans for secrets. The local wrapper falls
  back to a Docker image when the binary is not on `PATH`.
- **CI:** every PR runs typecheck, lint, test, build, secrets-scan, and
  commitlint against the PR commit range.

## What is deliberately not in this repo yet

To prevent confusion, none of the following exist today. They are scheduled
in the Sprint 1 execution chunks (C3 → C20) and later sprints — do not
assume any of them work today:

- No auth, no JWT, no MFA, no sessions.
- No RBAC, no roles, no capabilities, no scope engine.
- No database schema, no Prisma client, no migrations, no seed data.
- No API endpoints — `/health` arrives in C3.
- No web pages, no login screen, no admin shell, no agent surfaces.
- No business entities (Contact, Enrollment, Pipeline, Stage, Activity,
  Document, Approval, SLA timer, Bonus, QA, etc.).
- No WhatsApp inbox, presence, or templates.
- No campaign console.
- No Google Sheets sync, no reconciliation engine.
- No Meta Lead Ads webhook or Conversions API outbound.
- No verified deploy pipeline (the existing `nixpacks.toml` and `railway.json`
  reference scripts that land later; reconciled in C19).

## License

Proprietary — Trade Way / Captain Masr © 2026
