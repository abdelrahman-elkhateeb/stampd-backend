# stampd-backend

API for **Stampd**, the Employee Ops Platform (attendance, leave, requests and approvals for GCC teams).

**Status:** foundation (BE-01). Configuration, MongoDB connection, migrations and seed, request IDs, validation, the standard error body, pagination helpers, logging, health check, tests and CI are in place. The only endpoint is `GET /health`. Business endpoints arrive with BE-02 … BE-15.

**Stack:** TypeScript · Express 5 · MongoDB · Mongoose · Zod. Those three (express, mongoose, zod) are the only runtime dependencies. Node 24, pnpm.

**Reference:** the Trello board "Employee Ops Platform". There is no OpenAPI contract: each ticket defines its endpoints, and the shared conventions are on BE-00.

## Quick start (fresh clone → seeded API)

Prerequisites: **Node ≥ 24**, **pnpm 11** (`corepack enable`), and **MongoDB 7+** (Docker, a local install, or Atlas).

```bash
pnpm install
cp .env.example .env          # local defaults; change MONGODB_URI if your MongoDB differs
docker compose up -d          # MongoDB 8 as a single-node replica set on localhost:27017
pnpm db:setup                 # sync indexes + run migrations, then seed the demo company
pnpm dev                      # API on http://localhost:4000 (restarts on change)
```

Check it:

```bash
curl -i http://localhost:4000/health      # 200 {"status":"OK","database":"UP"} + X-Request-Id header
```

**Without Docker:** point `MONGODB_URI` in `.env` at any MongoDB 7+ (e.g. `mongodb://localhost:27017/stampd`, or an Atlas `mongodb+srv://…` URI). Transactions, which later tickets need, require a replica set; Atlas and the compose file provide one.

**Frontend against this API:** in `stampd-frontend/apps/web/.env.local` set `API_BASE_URL=http://localhost:4000` and `API_MOCKING=false`, then run `pnpm --filter web dev:next`. Until later tickets add endpoints, everything except `/health` answers 404.

## Endpoints

| Method | Path      | Auth | Response                                                                                                                       | Ticket |
| ------ | --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| GET    | `/health` | none | `200 {"status":"OK","database":"UP"}`, or `503 {"status":"DEGRADED","database":"DOWN"}` when MongoDB doesn't answer within 2 s | BE-01  |

Each ticket adds its endpoints to this table.

## Scripts

| Script                                               | What                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm dev`                                           | Run from source with reload (`src/server.ts`), reading `.env`             |
| `pnpm build` / `pnpm start`                          | Compile to `dist/` / run the compiled API (environment from the platform) |
| `pnpm start:migrate`                                 | Migrate, then start (what the container does)                             |
| `pnpm db:migrate`                                    | Sync indexes from the models and apply pending data migrations            |
| `pnpm db:seed`                                       | Upsert the demo company (idempotent; refused when `APP_ENV=production`)   |
| `pnpm db:setup`                                      | `db:migrate` + `db:seed`                                                  |
| `pnpm test`                                          | Unit tests (no database)                                                  |
| `pnpm test:integration`                              | Integration tests against a real MongoDB (started automatically)          |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | ESLint (zero warnings) / `tsc` / Prettier                                 |

## Configuration

All configuration comes from environment variables, validated at startup by `src/config/env.ts`. That file is the only one that reads `process.env` (lint enforces this); everything else receives a typed `Config`. A missing or invalid value stops the process with a message that names the variable, never its value.

| Variable           | Required   | Default   | Notes                                                                                                                  |
| ------------------ | ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`          | everywhere | —         | `local`, `test`, `staging` or `production`                                                                             |
| `MONGODB_URI`      | everywhere | —         | `mongodb://…` or `mongodb+srv://…`. Staging/production: from the host's secret store                                   |
| `PORT`             | no         | `4000`    | The port the frontend expects locally                                                                                  |
| `HOST`             | no         | `0.0.0.0` |                                                                                                                        |
| `LOG_LEVEL`        | no         | `info`    | `error`, `warn`, `info`, `debug`, `silent`                                                                             |
| `TEST_MONGODB_URI` | no         | —         | Integration tests only: use this server instead of the built-in one (database name must contain `test`; it is dropped) |

`.env` is git-ignored and only for local development (`pnpm dev`, `db:*` scripts load it with Node's `--env-file`). Staging and production values are set in the hosting platform. No credentials live in this repository.

## Architecture

```
src/
  server.ts                 Process entry: config → logger → app → listen → connect MongoDB (with retry)
  app.ts                    createApp(): request context → JSON body → module routers → 404 → error handler
  config/env.ts             The only reader of process.env (Zod)
  platform/                 Shared infrastructure, no business rules
    http/                   request-context (request ID + logs), validation (route + Zod),
                            errors, error-handler, pagination
    db/                     connection + ping, schema conventions, models list,
                            migrations (+ migrations/), seed, CLI scripts
    logging/ monitoring/ time/
  modules/                  One folder per domain, each with its routes, models and services
    system/                 GET /health                                   (BE-01)
    identity/               auth, current user, roles                     (BE-02, BE-03)
    organization/           company (tenant) model; settings, employees   (BE-05, BE-06)
    attendance/ leave/ requests/ reporting/ notifications/                (BE-07 … BE-15)
  types/express.d.ts        req.id and req.log
tests/unit, tests/integration
```

**Adding an endpoint** (inside the module that owns it):

```ts
// src/modules/<module>/index.ts
routes: (deps) => {
  const router = Router()
  router.get(
    "/company/holidays",
    route(
      {
        query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }),
      },
      async ({ query }) => ({
        status: 200,
        body: { year: query.year, items: [] },
      })
    )
  )
  return router
}
```

`route()` (`src/platform/http/validation.ts`) validates `params`, `query` and `body` with the Zod schemas before the handler runs, passes typed values in, and turns every problem into one `422 VALIDATION_FAILED` with `fieldErrors`. Errors thrown inside handlers reach the error handler automatically (Express 5 handles async errors).

**Request lifecycle.**

1. `requestContext` takes the caller's `X-Request-Id` if it is safe to log, otherwise generates a UUID. It sets the header on the response straight away, so errors and 404s carry it too.
2. It attaches `req.log` (a logger that stamps the request ID on every line) and writes one `request completed` line per request.
3. `express.json()` parses the body (max 1 MB).
4. The module's `route()` validates the input and runs the handler.
5. A route that doesn't exist gets `404 NOT_FOUND`; anything thrown goes to the error handler.

**Errors.** Every error response is `{ code, message, fieldErrors? }` (conventions on Trello BE-00). Throw `apiErrors.*` from `src/platform/http/errors.ts`. Anything else becomes `500 INTERNAL_ERROR` with no details for the client; it is logged with its stack and passed to the error reporter (`src/platform/monitoring/error-reporter.ts`, where BE-16 connects Sentry or similar). Malformed or oversized JSON becomes `422` on the field `body`.

**Validation codes.** Zod problems map to the field codes the frontend translates:

| Problem                              | Code                     |
| ------------------------------------ | ------------------------ |
| Missing or empty                     | `REQUIRED`               |
| String or array too short / too long | `TOO_SHORT` / `TOO_LONG` |
| Number out of bounds                 | `OUT_OF_RANGE`           |
| Anything else                        | `INVALID_FORMAT`         |

A refinement can name a code with `ctx.addIssue({ code: "custom", params: { code: "ALREADY_EXISTS" }, … })`.

**Lists.** `listQuery({ sortFields, defaultSort })` validates `page`, `pageSize` (≤ 100) and `sort` (`-field` = descending). `multiValue()` turns repeated params into arrays. `toPageRequest()` produces `skip`, `limit` and a stable `mongoSort`, and `toPage()` builds `{ items, meta }`. See `src/platform/http/pagination.ts`.

**Dates and times** (`src/platform/time/time.ts`, `src/platform/db/schema.ts`):

| Concept                                        | API                          | MongoDB                       | In code                         |
| ---------------------------------------------- | ---------------------------- | ----------------------------- | ------------------------------- |
| Calendar day (leave, holiday, attendance date) | `"2026-10-07"`               | string via `plainDateField()` | the same string, never a `Date` |
| Instant (check-in, decided at)                 | `"2026-10-07T05:02:00.000Z"` | BSON Date (UTC)               | `Date`, sent as UTC ISO 8601    |
| Time of day (work start)                       | `"09:00"`                    | string, company time          | string                          |

Which calendar day an instant falls on depends on the company timezone: use `plainDateInZone(instant, company.timezone)`, never the server's clock zone.

**IDs.** Every model uses `_id: uuidId()`, a random UUID v4 string (non-sequential, the format the frontend already uses). JSON output has `id`, no `_id` and no `__v` (`baseSchemaOptions`).

**Query safety.** `strictQuery: "throw"` is set globally: filtering on a field the schema doesn't have throws instead of silently matching every document.

## Database

- **Connection:** `connectDatabase()` in `src/platform/db/connection.ts` opens Mongoose's default connection; every model registers on it. `server.ts` starts HTTP first and keeps retrying the connection every 5 s, so `/health` reports `DEGRADED` instead of the process crash-looping.
- **Models:** each module defines its models, e.g. `src/modules/organization/company.model.ts`, and lists them in `src/platform/db/models.ts`.
- **Migrations:** MongoDB has no schema migrations. `pnpm db:migrate` (and the container on start) does two things:
  - It runs `syncIndexes()` for every model, so indexes declared on the models are created or updated.
  - It applies pending **data migrations** from `src/platform/db/migrations/`, in order and once each, recording them in the `migrations` collection.

  Never edit a migration that has run; add a new one.

- **Seed:** `pnpm db:seed` upserts the demo company, with the same id and name as the frontend's mock data. Later tickets extend it.
- **What BE-01 creates:** the `companies` collection (the tenant root) with its timezone and working days. New companies default to **Sunday–Thursday** (`DEFAULT_WORKING_DAYS` in `company.model.ts`); the Admin changes it in settings (BE-05). Everything else arrives with its ticket.
- **Transactions:** use a replica set (compose and Atlas provide one); the integration tests prove transactions work.

## Tests

- **Unit** (`tests/unit`, no database): config, time, pagination, logger redaction, and the whole HTTP app on a random port (request IDs, logging, validation codes, error bodies, health 200/503).
- **Integration** (`tests/integration`, real MongoDB): the global setup starts a real `mongod` with mongodb-memory-server. The binary (about 780 MB) is downloaded on the first run and cached in `~/.cache/mongodb-binaries`. It runs as a single-node replica set. Each test file gets a fresh database (drop → migrate → seed). The tests cover:
  - the connection and transactions;
  - the `strictQuery` guard;
  - migrations, and the seed being idempotent;
  - UUID ids, and how dates and timestamps are stored;
  - a request that goes from validation through a handler to MongoDB;
  - `/health` going DOWN and recovering.

## CI

`.github/workflows/ci.yml` runs on every pull request and on `main`. It installs with the frozen lockfile, then runs `format:check`, `lint`, `typecheck`, `build`, unit tests and integration tests (the MongoDB binary is cached between runs). Any failing step fails the build.

## Staging

Pipeline: merge to `main` → CI passes → the `deploy-staging` job:

1. builds the Docker image;
2. pushes it to GitHub Container Registry (`ghcr.io/<owner>/<repo>:staging` and `:<sha>`);
3. calls the host's deploy hook;
4. waits for `/health` to report the database `UP`.

The container runs `db:migrate` before it starts.

**One-time setup (not done yet; nothing here is invented):**

1. Choose a host that runs a container from GHCR and offers a deploy hook URL (e.g. Render, Railway, Fly.io), and a MongoDB 7+ replica set (e.g. MongoDB Atlas).
2. On the host, set `APP_ENV=staging` and `MONGODB_URI` (optionally `LOG_LEVEL`), and allow it to pull from GHCR.
3. In GitHub, create the environment `staging` with the secret `STAGING_DEPLOY_HOOK_URL`, and set the repository variables `STAGING_URL` and `STAGING_DEPLOY_ENABLED=true`.

Until step 3 is done, the deploy job is skipped; CI checks still run. To seed demo data on staging, run `pnpm db:seed` once with the staging `MONGODB_URI` and `APP_ENV=staging`.
