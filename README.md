# stampd-backend

API for **Stampd**, the Employee Ops Platform (attendance, leave, requests and approvals for GCC teams).

**Status:** BE-01 (foundation), BE-02 (authentication, company signup, tenant isolation) BE-03 (roles, data scopes, permission checks), BE-04 (change history), BE-05 (company settings, work calendar, holidays, image uploads) and BE-06 (departments, employee management, offboarding) are in place. Endpoints: health, signup, login, sessions, invitations, password reset, current user, change password, a record's history, settings, calendar, holidays, logo and photo uploads, departments and employees (table below). BE-03 adds no endpoints; it adds the checks every later endpoint uses. The other business endpoints arrive with BE-07 … BE-15.

**Stack:** TypeScript · Express 5 · MongoDB · Mongoose · Zod. Those three (express, mongoose, zod) are the only runtime dependencies. Node 24, pnpm.

**Reference:** the Trello board "Employee Ops Platform". There is no OpenAPI contract: each ticket defines its endpoints, and the shared conventions are on BE-00.

## Quick start (fresh clone → seeded API)

Prerequisites: **Node ≥ 24**, **pnpm 11** (`corepack enable`), and **MongoDB 7+** (Docker, a local install, or Atlas).

```bash
pnpm install
cp .env.example .env          # local defaults; change MONGODB_URI if your MongoDB differs
docker compose up -d          # MongoDB 8 as a single-node replica set on localhost:27017
pnpm db:setup                 # sync indexes + run migrations, then seed the demo company and accounts
pnpm dev                      # API on http://localhost:4000 (restarts on change)
```

Check it:

```bash
curl -i http://localhost:4000/health      # 200 {"status":"OK","database":"UP"} + X-Request-Id header
curl -s -X POST http://localhost:4000/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@demo.stampd.app","password":"demo-password"}'   # {"accessToken":…,"refreshToken":…,"expiresIn":900}
```

**Demo accounts** (`pnpm db:seed`, same as the frontend's mock data): `admin@`, `manager@`, `employee@` (active) and `deactivated@demo.stampd.app`, password `demo-password`; `invited@demo.stampd.app` is invited, and its invite link is printed in the seed's log line.

**Without Docker:** point `MONGODB_URI` in `.env` at any MongoDB 7+ **replica set** (an Atlas `mongodb+srv://…` URI, or a local `mongod --replSet rs0` after `rs.initiate()`). Signup, accept-invite and password reset use transactions, which MongoDB only supports on replica sets; a standalone server answers those endpoints with 500.

**Frontend against this API:** in `stampd-frontend/apps/web/.env.local` set `API_BASE_URL=http://localhost:4000` and `API_MOCKING=false`, then run `pnpm --filter web dev:next`. Endpoints not listed below answer 404 until their ticket adds them.

## Endpoints

| Method                | Path                                                   | Auth                            | Response                                                                                                                       | Ticket |
| --------------------- | ------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| GET                   | `/health`                                              | none                            | `200 {"status":"OK","database":"UP"}`, or `503 {"status":"DEGRADED","database":"DOWN"}` when MongoDB doesn't answer within 2 s | BE-01  |
| POST                  | `/auth/signup`                                         | none                            | `201` tokens: new company + Admin account (also an employee)                                                                   | BE-02  |
| POST                  | `/auth/login`                                          | none                            | `200` tokens                                                                                                                   | BE-02  |
| POST                  | `/auth/refresh`                                        | none                            | `200` new token pair (rotation, 20 s grace window)                                                                             | BE-02  |
| POST                  | `/auth/logout`                                         | none                            | `204`, ends the session                                                                                                        | BE-02  |
| POST                  | `/auth/invitations/verify`                             | none                            | `200 { companyName, name, email, expiresAt }`                                                                                  | BE-02  |
| POST                  | `/auth/invitations/accept`                             | none                            | `200` tokens                                                                                                                   | BE-02  |
| POST                  | `/auth/password/forgot`                                | none                            | `202` always                                                                                                                   | BE-02  |
| POST                  | `/auth/password/reset/verify`                          | none                            | `204` when the link is usable                                                                                                  | BE-02  |
| POST                  | `/auth/password/reset`                                 | none                            | `200` tokens; ends every other session                                                                                         | BE-02  |
| GET                   | `/me`                                                  | bearer                          | `200` current user, employee and company basics                                                                                | BE-02  |
| POST                  | `/me/password`                                         | bearer                          | `204`; ends the user's other sessions                                                                                          | BE-02  |
| GET                   | `/history/{recordType}/{id}`                           | bearer                          | `200 { items, meta }`: the record's changes, newest first; `404` when the caller can't read the record                         | BE-04  |
| GET                   | `/company/settings`                                    | bearer                          | `200` settings (every role)                                                                                                    | BE-05  |
| PATCH                 | `/company/settings`                                    | bearer, Admin                   | `200` settings; timezone changes apply from the next day                                                                       | BE-05  |
| PUT / DELETE          | `/company/logo`                                        | bearer, Admin                   | raw PNG/JPEG/WebP body ≤ 2 MB → `200 { logoUrl }` / `204`                                                                      | BE-05  |
| PUT / DELETE          | `/employees/{id}/photo`                                | bearer, own or Admin            | raw image body → `200 { photoUrl }` / `204`                                                                                    | BE-05  |
| GET                   | `/files/{id}?expires&signature`                        | signed URL                      | the image (URLs come from the endpoints above)                                                                                 | BE-05  |
| GET                   | `/company/holidays?year=`                              | bearer                          | `200 { year, items }` (every role)                                                                                             | BE-05  |
| POST / PATCH / DELETE | `/company/holidays[/{id}]`                             | bearer, Admin                   | `201`/`200 { holiday, affectedRequests }` / `204`                                                                              | BE-05  |
| GET                   | `/company/calendar?from&to`                            | bearer                          | `200 { workingDayCount, days }` (every role)                                                                                   | BE-05  |
| GET                   | `/departments`                                         | bearer                          | `200 { items }` (every role)                                                                                                   | BE-06  |
| POST / PATCH / DELETE | `/departments[/{id}]`                                  | bearer, Admin                   | `201` / `200` / `204`; `409 DEPARTMENT_NOT_EMPTY`                                                                              | BE-06  |
| GET                   | `/employees?search&departmentId&managerId&status&role` | bearer, Manager (team) or Admin | `200 { items, meta }`; Employees `403`                                                                                         | BE-06  |
| POST                  | `/employees`                                           | bearer, Admin                   | `201 { employee, invitation }` (invite sent)                                                                                   | BE-06  |
| POST                  | `/employees/import`                                    | bearer, Admin                   | CSV body → `200 { createdCount, created, errors }`                                                                             | BE-06  |
| GET / PATCH           | `/employees/{id}`                                      | bearer                          | profile; Admin edits all, others only their own phone                                                                          | BE-06  |
| POST                  | `/employees/{id}/invitation`                           | bearer, Admin                   | `200 { expiresAt }`: resend                                                                                                    | BE-06  |
| POST                  | `/employees/{id}/deactivation/preview`                 | bearer, Admin                   | `200` impact (reports, pending requests, future time off)                                                                      | BE-06  |
| POST                  | `/employees/{id}/deactivation`, `/reactivation`        | bearer, Admin                   | `200` profile                                                                                                                  | BE-06  |

Each ticket adds its endpoints to this table. The exact request and response bodies and error codes of every endpoint are on its Trello ticket (BE-02 for the identity endpoints, BE-04 for history, BE-05 for settings, holidays, calendar and uploads, BE-06 for departments and employees).

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

| Variable            | Required           | Default                 | Notes                                                                                                                                                                                      |
| ------------------- | ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_ENV`           | everywhere         | —                       | `local`, `test`, `staging` or `production`                                                                                                                                                 |
| `MONGODB_URI`       | everywhere         | —                       | `mongodb://…` or `mongodb+srv://…`. Staging/production: from the host's secret store                                                                                                       |
| `PORT`              | no                 | `4000`                  | The port the frontend expects locally                                                                                                                                                      |
| `HOST`              | no                 | `0.0.0.0`               |                                                                                                                                                                                            |
| `LOG_LEVEL`         | no                 | `info`                  | `error`, `warn`, `info`, `debug`, `silent`                                                                                                                                                 |
| `AUTH_TOKEN_SECRET` | everywhere         | —                       | Signs access tokens and derives rotated refresh tokens; at least 32 characters. The `.env.example` value works locally only (staging/production refuse it). Changing it signs everyone out |
| `WEB_APP_URL`       | staging/production | `http://localhost:3000` | The web app's base URL, used to build invite and reset links (`{WEB_APP_URL}/{locale}/invite/{token}`)                                                                                     |
| `TEST_MONGODB_URI`  | no                 | —                       | Integration tests only: use this server instead of the built-in one (database name must contain `test`; it is dropped)                                                                     |

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
    identity/               signup, login, sessions, invitations, reset,  (BE-02)
                            current user; requireAuth for every module
                            access.ts: permission matrix and checks;     (BE-03)
                            availability.ts: colleague privacy
    history/                append-only change history; GET /history/…   (BE-04)
    organization/           company settings, holidays, work calendar,    (BE-05)
                            logo and photos
                            departments, employees, CSV import,           (BE-06)
                            offboarding (employees.*.ts)
                            identity/accounts.ts: email, role, status
    attendance/ leave/ requests/ reporting/ notifications/                (BE-07 … BE-15)
  platform/storage/files.ts image uploads: type check, storage, signed URLs (BE-05)
  types/express.d.ts        req.id, req.log and req.auth
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

**Protecting an endpoint (tenant isolation).** Every endpoint that needs a signed-in user adds `requireAuth(...)` and scopes every query by the caller's company:

```ts
router.get(
  "/departments/:id",
  requireAuth({ secret: deps.config.authTokenSecret, clock: deps.clock }),
  route({ params: z.object({ id: z.uuid() }) }, async ({ params, req }) => {
    const { companyId } = getAuth(req) // from the access token + database, never the request
    const department = await DepartmentModel.findOne({
      _id: params.id,
      companyId,
    })
    if (!department) throw apiErrors.notFound() // another company's record: 404, not 403
    return { status: 200, body: department.toJSON() }
  })
)
```

Tenant-owned models declare `companyId: tenantIdField()` and use `schema.plugin(tenantScoped)` (`src/platform/db/tenant.ts`): any query on them that doesn't filter by `companyId` **throws**. The only escape hatch is `withoutTenantScope(query)`, for lookups that happen before a tenant is known (login by email). Every new endpoint gets a cross-tenant test like `tests/integration/tenant-isolation.test.ts` (Trello BE-02: a release gate).

**Permissions (BE-03).** Three roles (Employee, Manager, Admin/HR; one per user) and three scopes:

- **self:** the caller's own records;
- **team:** the caller's **active direct reports**, i.e. employees whose `managerId` is the caller. It is read from the database on every check, so a reassignment or role change applies on the next request. No skip-level; a deactivated employee drops out of the team (the Admin keeps access);
- **company:** every employee of the caller's company.

| Resource (ticket)                              | Action                     | Employee | Manager     | Admin/HR |
| ---------------------------------------------- | -------------------------- | -------- | ----------- | -------- |
| `employee` profile (BE-06)                     | view                       | self     | self + team | company  |
|                                                | create / edit / delete     | —        | —           | company  |
| `attendance` (BE-07, BE-08)                    | view                       | self     | self + team | company  |
|                                                | create (clock in/out)      | self     | self        | self     |
|                                                | edit (corrections)         | —        | —           | company  |
| `leave` (BE-08, BE-10), `requests` (BE-09)     | view                       | self     | self + team | company  |
|                                                | create / edit (cancel own) | self     | self        | self     |
|                                                | approve                    | —        | team        | company  |
| `reports` (BE-13)                              | view                       | self     | self + team | company  |
| `companySettings` incl. holidays, logo (BE-05) | view                       | company  | company     | company  |
|                                                | edit                       | —        | —           | company  |
| `employeePhoto` (BE-05)                        | edit                       | self     | self        | company  |
| `employeeDirectory`: the list (BE-06)          | view                       | —        | team        | company  |
| `users`: invite, role, deactivate (BE-06)      | all                        | —        | —           | company  |

**Answers:**

- the role has no grant for the action → `403 FORBIDDEN`, before anything changes;
- it has a grant, but the employee is outside its scope → `404 NOT_FOUND`, the same as an id that doesn't exist;
- approving your own request, whatever the role → `403 SELF_APPROVAL`.

The matrix is `PERMISSIONS` in `src/modules/identity/access.ts`. The ticket that builds a resource may adjust its row; update this table and the BE-03 Trello card with it. Use:

```ts
// one employee's data (403 / 404 / SELF_APPROVAL as above)
await authorize(getAuth(req), "attendance", "view", params.employeeId)

// lists: "ALL" (company) or the ids the caller may see
const ids = await scopedEmployeeIds(getAuth(req), "leave", "view")
const filter = ids === "ALL" ? { companyId } : { companyId, employeeId: { $in: ids } }

// actions that aren't about one employee: a route guard
router.patch("/company/settings", auth, requirePermission("companySettings", "edit"), …)
```

**Colleague privacy** (`src/modules/identity/availability.ts`). In "who is out" views, pass each entry through `presentAvailability(await availabilityViewer(auth), entry)`:

- **full detail:** your own entries, a Manager's direct reports', and everyone's for the Admin;
- **name + `OUT`:** a colleague in your department on leave, with no type, reason or dates;
- **name + `WFH`:** a colleague in your department working from home;
- **nothing:** everything else, i.e. other departments and colleagues' business trips and permissions.

Every protected endpoint gets per-role tests like `tests/integration/access.test.ts`.

**Employees (BE-06).** A person is two records with the same id: the **Employee** (organization: profile, employment, department, manager) and the login **User** (identity: email, role, status, last working day). `src/modules/organization/employees.service.ts` changes both in one transaction and records history.

- **Who edits what:** Admins edit everything. Anyone else may change only their own `phone` (their photo goes through BE-05). Any other field, or someone else's record they can see, gives `403`; a record they can't see gives `404`.
- **Manager rules** (`managerProblem()`): the manager must be another employee of the company with the Manager or Admin role and not deactivated. Loops (A → B → A, directly or not) are refused. Errors are `422` on `managerId`: `UNKNOWN_REFERENCE`, `SELF_MANAGER`, `NOT_A_MANAGER` or `MANAGER_LOOP`.
- **Role changes:** demoting a Manager who still has direct reports gives `409 HAS_DIRECT_REPORTS`; removing the last Admin gives `409 LAST_ADMIN`.
- **Offboarding:**
  - `…/deactivation/preview` lists direct reports, pending requests and future approved time off, and changes nothing.
  - `…/deactivation` needs `reassignReportsTo` when there are direct reports (`409 HAS_DIRECT_REPORTS` otherwise). It runs the leave and request modules' offboarding hooks (`registerOffboardingHook()`, BE-09/BE-10) and sets the last working day.
  - Sign-in works through that day. After it, the next login, refresh or request deactivates the account (`settleAccountStatus()`, recorded with actor "system") and answers `403 ACCOUNT_DEACTIVATED`. A last working day in the past deactivates at once.
  - Nothing is deleted.
- **CSV import:** the header row is required, columns in any order, any case: `name, email, joiningDate` (required), `role, department` (an existing name), `managerEmail` (an existing employee, or a row above), `jobTitle, phone, employeeCode, employmentType, tracksAttendance`. Each valid row is created and invited in its own transaction. Invalid rows come back as `errors: [{ row, field, code, message }]`, where `row` is the line in the file. At most 1,000 rows and 1 MB.

**Settings, calendar and uploads (BE-05).**

- **Work calendar** (`src/modules/organization/calendar.ts`): use it for any "working day" question.
  - `loadWorkCalendar({ companyId, from, to })` loads the calendar, then `isWorkingDay(calendar, date)` and `workingDaysBetween(calendar, from, to, { halfDayStart, halfDayEnd })` answer from it. Both ends of the range count.
  - A working day is a company working weekday that no holiday covers.
- **Holidays** are one record from `startDate` to `endDate`. Adding or changing one returns `affectedRequests`: approved requests on those dates, which are never changed automatically. The leave and request modules (BE-09, BE-10) fill that list by calling `registerAffectedRequestFinder()`.
- **Timezone:** a change applies from the company's next day. `timezone` is the newest value, and `timezoneHistory` keeps each earlier one with its last day. Ask `timezoneOn(company, day)`, `timezoneAt(company, instant)` or `companyToday(company, instant)`; never read `company.timezone` directly for a past or current day.
- **Uploads** (`src/platform/storage/files.ts`):
  - The image is sent as the raw request body, not multipart.
  - Its type comes from the file's bytes, not its header: PNG, JPEG and WebP only, no SVG. The limit is 2 MB. Errors are `422` on field `file`: `REQUIRED`, `FILE_TOO_LARGE` or `UNSUPPORTED_FILE_TYPE`.
  - Images are stored in MongoDB (`storedfiles`, scoped by company). Only that file touches the bytes, so object storage can replace it later.
  - Responses carry **signed URLs** (`/files/{id}?expires=…&signature=…`, valid at least 24 h) that work in `<img src>` without a token. Anything else gives `404`.

**History (BE-04).** Every change to a tracked record is stored once, with who changed it, when (UTC), why, and the old and new values of only the fields that changed. Call `recordHistory()` from `src/modules/history/history.service.ts` **inside the same `withTransaction()` as the change**, so both commit or roll back together; outside a transaction it throws.

```ts
await withTransaction(async () => {
  assertReason("attendance.corrected", body.reason) // 422 before changing anything
  const before = await AttendanceDayModel.findOneAndUpdate(
    { _id, companyId },
    { $set: change }
  ).lean()
  await recordHistory(
    {
      companyId,
      action: "attendance.corrected",
      entityId: _id,
      subjectEmployeeId: before.employeeId,
      actor: { type: "USER", userId: auth.userId }, // or { type: "SYSTEM", job: "attendance.nightlyClose" }
      before: pick(before, FIELDS),
      after: { ...pick(before, FIELDS), ...change },
      reason: body.reason,
    },
    deps
  )
})
```

- **Actions** (`HISTORY_ACTIONS`): each says which record type it changes and whether a reason is **required**. A missing required reason gives `422`, field `reason`, code `REQUIRED`, and the change rolls back. Required today: `attendance.corrected` and `leaveBalance.adjusted`. The ticket that builds a change may add actions or adjust the rule.
- **Source:** `USER`, `APPROVAL` (pass `source: "APPROVAL"` on the actor) or `SYSTEM_JOB` (actor "system").
- **Append-only:** every update, replace and delete on the history model throws (`HistoryImmutableError`), and there is no endpoint that writes history.
- **Already recorded:** manager and department changes (`setReportingLine`, which now needs `changedBy`) and an invited employee becoming active.
- **Reading:** `GET /history/{attendance-days|leave-balances|requests|employees|company-settings}/{id}`. You can read a record's history only if you can read the record (BE-03). For attendance days, leave balances and requests, the owner is taken from the entries, so a record with no history is `404`. Company settings use the company id.

**Sessions.**

- **Access token:** a JWT (HS256), valid 15 minutes, sent as `Authorization: Bearer …`. Each request re-checks the session and the user's status and role in the database, so logout, deactivation and role changes apply at once.
- **Refresh token:** valid 30 days. It is rotated on every refresh, and MongoDB stores only its SHA-256.
- **Grace window:** for 20 s after a rotation, the previous refresh token returns the **same** new pair (parallel refreshes from several frontend servers). Reuse after that revokes the whole session.
- **Rate limit:** 10 failed logins for the same email **from the same IP address** in 15 minutes give `429 TOO_MANY_ATTEMPTS` with `Retry-After`. Failures from one address never lock the owner out from another, and a password reset clears the email's counters from every address. The counters live in MongoDB, so the limit holds across servers.
- **Passwords:** scrypt hashes. The rule is 10–128 characters, not a common password, and not containing a word of the person's name or the local part of their email (before @, or a word of it). Only parts of 3+ characters count, and the email domain never does.
- **Invite and reset links:** single-use, valid 7 days and 1 hour. Until BE-15 sends emails, they are logged outside production (`invite link (logged until BE-15 sends emails)`).

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

- **Seed:** `pnpm db:seed` upserts the demo company and the demo accounts (same ids, emails and password as the frontend's mock data) and issues a fresh invite for the invited account. The demo manager (`manager@`) is the direct manager of the employee, deactivated and invited accounts, and reports to the Admin. The manager and their reports are in the Operations department, and every demo employee has a job title and a joining date. Later tickets extend it.
- **What BE-01 creates:** the `companies` collection (the tenant root) with its timezone and working days. New companies default to **Sunday–Thursday** (`DEFAULT_WORKING_DAYS` in `company.model.ts`); the Admin changes it in settings (BE-05). Everything else arrives with its ticket.
- **What BE-02 adds:**
  - `users`: login account (email unique platform-wide, scrypt hash, role, status, locale);
  - `employees`: the HR record, which shares the user's id; BE-03 adds `managerId` and `departmentId` (the reporting line that decides team scope and colleague visibility);
  - `sessions` and `refreshtokens`: token families, with expired tokens deleted by a TTL index;
  - `onetimetokens`: invite and reset links, kept 30 days after expiry so old links answer "expired";
  - `attempts`: rate-limit counters (TTL).
  - `historyentries` (BE-04): append-only change history, one per change, indexed by company, record type, record id and time.
  - BE-05: `holidays` (start/end dates), `storedfiles` (uploaded images); companies gain work hours, late grace, leave year start month, `logoFileId` and `timezoneHistory`; employees gain `photoFileId`. Existing companies read the defaults (09:00–17:00, grace 0, January).
  - BE-06: `departments` (unique name per company); employees gain phone, job title, employee code (unique per company when set), joining date, employment type and `tracksAttendance`; users gain `lastWorkingDay`.

  Companies also store `weekStart` (default `SUN`) and the terms version, acceptance time and who accepted.

- **Transactions:** use a replica set (compose and Atlas provide one); the integration tests prove transactions work.

## Tests

- **Unit** (`tests/unit`, no database): config, time, pagination, logger redaction, and the whole HTTP app on a random port (request IDs, logging, validation codes, error bodies, health 200/503).
- **Integration** (`tests/integration`, real MongoDB): the global setup starts a real `mongod` with mongodb-memory-server. The binary (about 780 MB) is downloaded on the first run and cached in `~/.cache/mongodb-binaries`. It runs as a single-node replica set. Each test file gets a fresh database (drop → migrate → seed). The tests cover:
  - the connection and transactions;
  - the `strictQuery` guard;
  - migrations, and the seed being idempotent;
  - UUID ids, and how dates and timestamps are stored;
  - a request that goes from validation through a handler to MongoDB;
  - `/health` going DOWN and recovering;
  - every BE-02 flow over HTTP, with a clock the tests move (token expiry, the 20 s grace window, 30-day refresh expiry, the 15-minute lockout, 7-day invites, 1-hour reset links);
  - the cross-tenant suite;
  - per-role authorization (BE-03): self / team / company, reassignment and role changes on the next request, 403 vs 404, self-approval;
  - history (BE-04): one entry per committed change, none after a rollback, the reason rule, append-only, and reading by role;
  - settings, holidays, calendar and uploads (BE-05): the card's calendar examples, the next-day timezone rule, Admin-only changes, size and type limits, and cross-company file access;
  - departments and employees (BE-06): every acceptance criterion (duplicate email, a 50 + 2 row CSV, manager loops, offboarding with reports, login blocked after the last day, the list per role, read-only manager view, the self-service phone).

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
2. On the host, set `APP_ENV=staging`, `MONGODB_URI`, `AUTH_TOKEN_SECRET` (a new random value: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) and `WEB_APP_URL` (optionally `LOG_LEVEL`), and allow it to pull from GHCR.
3. In GitHub, create the environment `staging` with the secret `STAGING_DEPLOY_HOOK_URL`, and set the repository variables `STAGING_URL` and `STAGING_DEPLOY_ENABLED=true`.

Until step 3 is done, the deploy job is skipped; CI checks still run. To seed demo data on staging, run `pnpm db:seed` once with the staging `MONGODB_URI` and `APP_ENV=staging`.
