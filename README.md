# stampd-backend

API for **Stampd**, the Employee Ops Platform (attendance, leave, requests and approvals for GCC teams).

**Status:** BE-01 (foundation), BE-02 (authentication, company signup, tenant isolation) BE-03 (roles, data scopes, permission checks), BE-04 (change history), BE-05 (company settings, work calendar, holidays, image uploads) BE-06 (departments, employee management, offboarding) BE-07 (attendance: check-in/out, daily status, end-of-day close, corrections) BE-08 (leave types, policies, balance ledger) BE-09 (the request & approval engine) BE-10 (leave requests) BE-11 (WFH, attendance correction, permission and business trip requests) BE-12 (company calendar and availability) BE-13 (dashboard summaries) and BE-14 (reports and CSV export) are in place. Endpoints: health, signup, login, sessions, invitations, password reset, current user, change password, a record's history, settings, calendar, holidays, logo and photo uploads, departments, employees, attendance, leave types and balances, requests and approvals, dashboards, reports (table below). BE-03 adds no endpoints; it adds the checks every later endpoint uses. Notifications arrive with BE-15.

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

| Method                | Path                                                                                                                           | Auth                                 | Response                                                                                                                                                                   | Ticket |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| GET                   | `/health`                                                                                                                      | none                                 | `200 {"status":"OK","database":"UP"}`, or `503 {"status":"DEGRADED","database":"DOWN"}` when MongoDB doesn't answer within 2 s                                             | BE-01  |
| POST                  | `/auth/signup`                                                                                                                 | none                                 | `201` tokens: new company + Admin account (also an employee)                                                                                                               | BE-02  |
| POST                  | `/auth/login`                                                                                                                  | none                                 | `200` tokens                                                                                                                                                               | BE-02  |
| POST                  | `/auth/refresh`                                                                                                                | none                                 | `200` new token pair (rotation, 20 s grace window)                                                                                                                         | BE-02  |
| POST                  | `/auth/logout`                                                                                                                 | none                                 | `204`, ends the session                                                                                                                                                    | BE-02  |
| POST                  | `/auth/invitations/verify`                                                                                                     | none                                 | `200 { companyName, name, email, expiresAt }`                                                                                                                              | BE-02  |
| POST                  | `/auth/invitations/accept`                                                                                                     | none                                 | `200` tokens                                                                                                                                                               | BE-02  |
| POST                  | `/auth/password/forgot`                                                                                                        | none                                 | `202` always                                                                                                                                                               | BE-02  |
| POST                  | `/auth/password/reset/verify`                                                                                                  | none                                 | `204` when the link is usable                                                                                                                                              | BE-02  |
| POST                  | `/auth/password/reset`                                                                                                         | none                                 | `200` tokens; ends every other session                                                                                                                                     | BE-02  |
| GET                   | `/me`                                                                                                                          | bearer                               | `200` current user, employee and company basics                                                                                                                            | BE-02  |
| POST                  | `/me/password`                                                                                                                 | bearer                               | `204`; ends the user's other sessions                                                                                                                                      | BE-02  |
| GET                   | `/history/{recordType}/{id}`                                                                                                   | bearer                               | `200 { items, meta }`: the record's changes, newest first; `404` when the caller can't read the record                                                                     | BE-04  |
| GET                   | `/company/settings`                                                                                                            | bearer                               | `200` settings (every role)                                                                                                                                                | BE-05  |
| PATCH                 | `/company/settings`                                                                                                            | bearer, Admin                        | `200` settings; timezone changes apply from the next day                                                                                                                   | BE-05  |
| PUT / DELETE          | `/company/logo`                                                                                                                | bearer, Admin                        | raw PNG/JPEG/WebP body ≤ 2 MB → `200 { logoUrl }` / `204`                                                                                                                  | BE-05  |
| PUT / DELETE          | `/employees/{id}/photo`                                                                                                        | bearer, own or Admin                 | raw image body → `200 { photoUrl }` / `204`                                                                                                                                | BE-05  |
| GET                   | `/files/{id}?expires&signature`                                                                                                | signed URL                           | the image (URLs come from the endpoints above)                                                                                                                             | BE-05  |
| GET                   | `/company/holidays?year=`                                                                                                      | bearer                               | `200 { year, items }` (every role)                                                                                                                                         | BE-05  |
| POST / PATCH / DELETE | `/company/holidays[/{id}]`                                                                                                     | bearer, Admin                        | `201`/`200 { holiday, affectedRequests }` / `204`                                                                                                                          | BE-05  |
| GET                   | `/company/calendar?from&to`                                                                                                    | bearer                               | `200 { workingDayCount, days }` (every role)                                                                                                                               | BE-05  |
| GET                   | `/departments`                                                                                                                 | bearer                               | `200 { items }` (every role)                                                                                                                                               | BE-06  |
| POST / PATCH / DELETE | `/departments[/{id}]`                                                                                                          | bearer, Admin                        | `201` / `200` / `204`; `409 DEPARTMENT_NOT_EMPTY`                                                                                                                          | BE-06  |
| GET                   | `/employees?search&departmentId&managerId&status&role`                                                                         | bearer, Manager (team) or Admin      | `200 { items, meta }`; Employees `403`                                                                                                                                     | BE-06  |
| POST                  | `/employees`                                                                                                                   | bearer, Admin                        | `201 { employee, invitation }` (invite sent)                                                                                                                               | BE-06  |
| POST                  | `/employees/import`                                                                                                            | bearer, Admin                        | CSV body → `200 { createdCount, created, errors }`                                                                                                                         | BE-06  |
| GET / PATCH           | `/employees/{id}`                                                                                                              | bearer                               | profile; Admin edits all, others only their own phone                                                                                                                      | BE-06  |
| POST                  | `/employees/{id}/invitation`                                                                                                   | bearer, Admin                        | `200 { expiresAt }`: resend                                                                                                                                                | BE-06  |
| POST                  | `/employees/{id}/deactivation/preview`                                                                                         | bearer, Admin                        | `200` impact (reports, pending requests, future time off)                                                                                                                  | BE-06  |
| POST                  | `/employees/{id}/deactivation`, `/reactivation`                                                                                | bearer, Admin                        | `200` profile                                                                                                                                                              | BE-06  |
| POST                  | `/attendance/check-in`, `/attendance/check-out`                                                                                | bearer                               | `201`/`200` today; `409 NO_OPEN_SESSION`, `409 ATTENDANCE_NOT_TRACKED`                                                                                                     | BE-07  |
| GET                   | `/attendance/today`                                                                                                            | bearer                               | `200` the caller's day: status, sessions, open session                                                                                                                     | BE-07  |
| GET                   | `/attendance/days?date=`, `/attendance/month?month=`                                                                           | bearer                               | `200 { from, to, items: [{ employee, days }], meta }` (self / team / company)                                                                                              | BE-07  |
| GET                   | `/attendance/employees/{id}/days/{date}`                                                                                       | bearer                               | `200 { employee, day, sessions }`                                                                                                                                          | BE-07  |
| GET                   | `/attendance/exceptions?from&to&type=`                                                                                         | bearer, Admin                        | `200 { items, meta }`: Missing Checkout and Absent                                                                                                                         | BE-07  |
| POST / PATCH / DELETE | `/attendance/employees/{id}/days/{date}/sessions`, `/attendance/sessions/{id}`                                                 | bearer, Admin                        | corrections with a required `reason` → day detail                                                                                                                          | BE-07  |
| GET                   | `/leave/types`                                                                                                                 | bearer                               | `200 { items }` (every role; `?includeArchived=true` for Admins)                                                                                                           | BE-08  |
| POST / PATCH / DELETE | `/leave/types[/{id}]`                                                                                                          | bearer, Admin                        | `201` / `200` / `204`; `409 LEAVE_TYPE_IN_USE` (archive instead)                                                                                                           | BE-08  |
| GET                   | `/leave/employees/{id}/balances?year=`                                                                                         | bearer                               | `200 { year, items: [balance] }` (self / team / company)                                                                                                                   | BE-08  |
| GET                   | `/leave/employees/{id}/balances/{typeId}/entries`                                                                              | bearer                               | `200 { balance, items, meta }`: the ledger                                                                                                                                 | BE-08  |
| POST                  | `/leave/employees/{id}/balances/{typeId}/adjustments`                                                                          | bearer, Admin                        | `201` balance; `reason` required                                                                                                                                           | BE-08  |
| PUT                   | `/leave/employees/{id}/balances/{typeId}/entitlement`                                                                          | bearer, Admin                        | `200` balance (override)                                                                                                                                                   | BE-08  |
| GET                   | `/requests/types`                                                                                                              | bearer                               | `200 { items }`: the registered request types                                                                                                                              | BE-09  |
| POST                  | `/requests`                                                                                                                    | bearer                               | `201` request detail (Pending; Admins may submit for someone, optionally approved)                                                                                         | BE-09  |
| GET                   | `/requests/mine`, `/requests/approvals`                                                                                        | bearer (approvals: Manager or Admin) | `200 { items, meta }` with filters                                                                                                                                         | BE-09  |
| GET                   | `/requests/{id}`                                                                                                               | bearer                               | `200` detail with `actions` and `timeline`                                                                                                                                 | BE-09  |
| POST                  | `/requests/{id}/approve`, `/reject`, `/withdraw`, `/cancellation`, `/cancellation/approve`, `/cancellation/decline`, `/cancel` | bearer                               | `200` detail; `409 REQUEST_STATUS_CONFLICT` when someone acted first                                                                                                       | BE-09  |
| POST                  | `/leave/requests/preview`                                                                                                      | bearer                               | `200` days, excluded days, balance before/after, problems, conflicts, who else is off                                                                                      | BE-10  |
| GET                   | `/leave/employees/{id}/requests`                                                                                               | bearer                               | `200 { items, meta }`: leave history (self / team / company)                                                                                                               | BE-10  |
| GET                   | `/calendar/events?from&to`                                                                                                     | bearer                               | `200 { from, to, events }`: approved leave, WFH, trips, permissions and holidays as the caller may see them (≤ 3 months)                                                   | BE-12  |
| GET                   | `/calendar/availability?from&to`                                                                                               | bearer                               | `200 { from, to, days }`: per-day out / WFH / in-office counts                                                                                                             | BE-12  |
| GET                   | `/dashboard/employee`                                                                                                          | bearer                               | `200` my day, balances, pending requests, upcoming time off, recent activity                                                                                               | BE-13  |
| GET                   | `/dashboard/manager`                                                                                                           | bearer, Manager or Admin             | `200` approvals waiting, team today (with names), team out next 14 days, team this month                                                                                   | BE-13  |
| GET                   | `/dashboard/admin`                                                                                                             | bearer, Admin                        | `200` company today, pending by type (overdue after 3 days), exceptions this month, leave usage, 30-day trend                                                              | BE-13  |
| GET                   | `/reports/attendance/summary?preset \| from&to`                                                                                | bearer (scope by role)               | `200` per employee: working days, present, late, absent, WFH, on leave, unpaid leave days, trips, missing checkouts, hours, corrections; `totals`; `format=csv` → the file | BE-14  |
| GET                   | `/reports/attendance/detail?preset \| from&to`                                                                                 | bearer (scope by role)               | `200` employee × day: status, first in, last out, hours, flags, corrected; `format=csv` → the file                                                                         | BE-14  |
| GET                   | `/reports/leave/balances?year`                                                                                                 | bearer (scope by role)               | `200` employee × leave type for a leave year: entitlement, adjustments, used, upcoming, pending, available; `format=csv` → the file                                        | BE-14  |
| GET                   | `/reports/leave/register?preset \| from&to`                                                                                    | bearer (scope by role)               | `200` one row per leave request overlapping the range, with days and days in range, approver; `format=csv` → the file                                                      | BE-14  |
| GET                   | `/reports/wfh/summary?preset \| from&to`                                                                                       | bearer (scope by role)               | `200` per employee: WFH days, requests approved / rejected / pending; `totals`; `format=csv` → the file                                                                    | BE-14  |
| GET                   | `/reports/wfh/register?preset \| from&to`                                                                                      | bearer (scope by role)               | `200` one row per WFH (or `type=BUSINESS_TRIP`) request overlapping the range; `format=csv` → the file                                                                     | BE-14  |

Each ticket adds its endpoints to this table. The exact request and response bodies and error codes of every endpoint are on its Trello ticket (BE-02 for the identity endpoints, BE-04 for history, BE-05 for settings, holidays, calendar and uploads, BE-06 for departments and employees, BE-07 for attendance, BE-08 for leave types and balances, BE-09 for requests, BE-10 for leave requests, BE-11 for the other request types, BE-12 for the calendar, BE-13 for dashboards, BE-14 for reports).

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
    attendance/             check-in/out, daily status engine (status.ts),  (BE-07)
                            views, corrections, end-of-day close job
    leave/                  leave types, balance ledger (balance-math.ts, (BE-08)
                            balance.service.ts), leave-year rollover job
                            leave-request.ts: the LEAVE request type       (BE-10)
    requests/               request engine (engine.ts), type registry       (BE-09)
                            (registry.ts); Leave lives in leave/ (BE-10)
                            request-types.ts: WFH, correction,            (BE-11)
                            permission, business trip
    calendar/               calendar feed and availability (read-only)    (BE-12)
    reporting/              dashboard summaries (dashboard.service.ts)    (BE-13)
                            reports and CSV export (reports.service.ts)   (BE-14)
    notifications/                                                        (BE-15)
  platform/storage/files.ts image uploads: type check, storage, signed URLs (BE-05)
  platform/jobs.ts          background jobs started by server.ts (BE-07)
  platform/db/append-only.ts  insert-only collections: history, leave ledger (BE-08)
  platform/events.ts        in-process domain events (BE-09 publishes, BE-15 listens)
  platform/csv.ts           CSV reader for imports (BE-06)
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

| Resource (ticket)                                              | Action                     | Employee | Manager     | Admin/HR |
| -------------------------------------------------------------- | -------------------------- | -------- | ----------- | -------- |
| `employee` profile (BE-06)                                     | view                       | self     | self + team | company  |
|                                                                | create / edit / delete     | —        | —           | company  |
| `attendance` (BE-07)                                           | view                       | self     | self + team | company  |
|                                                                | create (clock in/out)      | self     | self        | self     |
|                                                                | edit (corrections)         | —        | —           | company  |
| `leave` balances (BE-08), requests (BE-10), `requests` (BE-09) | view                       | self     | self + team | company  |
|                                                                | create / edit (cancel own) | self     | self        | self     |
|                                                                | approve                    | —        | team        | company  |
| `reports` (BE-14)                                              | view                       | self     | self + team | company  |
| `companySettings` incl. holidays, logo (BE-05)                 | view                       | company  | company     | company  |
|                                                                | edit                       | —        | —           | company  |
| `employeePhoto` (BE-05)                                        | edit                       | self     | self        | company  |
| `employeeDirectory`: the list (BE-06)                          | view                       | —        | team        | company  |
| `attendanceExceptions` (BE-07)                                 | view                       | —        | —           | company  |
| `leaveTypes` (BE-08)                                           | view                       | company  | company     | company  |
|                                                                | edit                       | —        | —           | company  |
| `leaveBalances`: adjust, set entitlement (BE-08)               | edit                       | —        | —           | company  |
| `users`: invite, role, deactivate (BE-06)                      | all                        | —        | —           | company  |

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

**Requests and approvals (BE-09).** One engine runs every request type. A type is added by registering a definition (`registerRequestType()` in `src/modules/requests/registry.ts`), with no engine changes. A definition gives:

- its key and label;
- its approver policy: `MANAGER_WITH_ADMIN_FALLBACK` or `ADMIN_ONLY`;
- single day or a range, with or without times, and whether a reason is required;
- its own fields (`data`, a Zod schema);
- how colleagues may see it (`OUT` / `WFH` / `HIDDEN`);
- an optional attendance day effect;
- effect hooks `onSubmit`, `onApprove`, `onReject` and `onCancel`, which run **inside the status change's transaction** (a throw refuses the change).

How the engine behaves:

- **Lifecycle:**
  - `PENDING` → `APPROVED` | `REJECTED` (reason required) | `WITHDRAWN`;
  - `APPROVED` → `CANCELLATION_REQUESTED` (requester, before it starts) → `CANCELLED` | back to `APPROVED`;
  - an Admin can cancel an approved request directly, with a reason.

  There are no drafts, and requests are never edited.

- **Who decides:** the requester's current manager, or any Admin (the only ones for `ADMIN_ONLY` types, or when there's no manager). Nobody decides their own request (`403 SELF_APPROVAL`). The one exception is a company's **only** Admin with no manager above them; that approval is labelled `selfApproved`.
- **First decision wins:** a status change is one conditional update ("only if still `PENDING`"). Of two simultaneous decisions, one wins and the other gets `409 REQUEST_STATUS_CONFLICT`, with a single history entry.
- **History and events:** every change writes `request.statusChanged` history (the detail's `timeline`) and publishes a domain event (`request.submitted`, `approved`, `rejected`, `withdrawn`, `cancellationRequested`, `cancellationDeclined`, `cancelled`) after it commits.
- **Connections:**
  - approved requests become attendance day effects (BE-07);
  - adding a holiday lists the approved requests on its dates (BE-05);
  - offboarding withdraws pending requests and cancels future approved ones, running each type's `onCancel` (BE-06).

**Dashboards (BE-13).** `src/modules/reporting/dashboard.service.ts` builds one summary per role.

- **One source of numbers:** every attendance figure comes from `dayStatuses()` (attendance), the same per-day statuses the attendance views show and BE-14's reports use, so the numbers always agree.
- **Today's buckets** (`present`, `late`, `absent`, `wfh`, `onLeave`, `businessTrip`, `notYetCheckedIn`) count the people expected today: tracked, joined, not past their last day, not invited. On a working day they add up to exactly that number.
- **Before the day closes,** nobody is Absent: no check-in yet counts as `notYetCheckedIn`.
- **Who sees what:** the manager summary covers the caller's direct reports only. The admin summary is Admins only.
- **Speed:** with 300 employees, each summary answers in about 0.1 s in the tests.

**Reports (BE-14).** `src/modules/reporting/reports.service.ts` builds six views: attendance summary and detail, leave balances and register, WFH summary and register.

- **Screen and file match:** each view is one endpoint. JSON returns one page (`page`, `pageSize`, `sort`) and, for summaries, `totals` over every row; `format=csv` returns every row from the same code. The CSV is UTF-8 with a byte-order mark (Excel shows Arabic names), one header row, CRLF lines, ISO dates, check-in/out in company time `HH:mm`, and the company timezone in the file name (e.g. `attendance-summary_2026-03-01_2026-03-31_Asia-Dubai.csv`). Text that Excel would run as a formula (`=`, `+`, `-`, `@`) is prefixed with `'`.
- **Scope:** `scope=self|team|company`, defaulting to the role's widest (Admin company, Manager team, Employee self). A scope the role doesn't have → 403. Employees may only see themselves: filtering by department, manager, status or another employee → 403. An employee outside the scope → 404. The team is the caller's active direct reports (BE-03).
- **Who is in a report:** people in scope employed at some point in the range (joined by its end, last working day on or after its start). Attendance views list tracked people only, not invited accounts. `employeeStatus` filters by the current account status.
- **Dates:** `preset` (`THIS_MONTH`, `LAST_MONTH`, `THIS_LEAVE_YEAR`, in the company calendar) or `from` + `to`, at most 13 months (422 on `to`). Leave balances take a leave `year` instead.
- **One source of numbers:** attendance figures come from `dayStatuses()` like the dashboards. In the summary, present + late + absent + WFH + on leave + business trip + missing checkouts + not yet recorded = working days. Unpaid leave days come from approved leave of unpaid types.
- **Read only:** balances are read in bulk from the ledger (`balanceSummaries()`); someone without a balance record yet shows the pro-rated default, and nothing is created. Untracked types (Unpaid) show days used, upcoming and pending from the requests.
- **Speed:** a one-month attendance summary CSV for 300 employees takes about 1 s in the tests (target: under 10 s). The detail view computes only the people on the requested page.

**Calendar (BE-12).** `src/modules/calendar/calendar.service.ts` reads approved requests (`APPROVED`, `CANCELLATION_REQUESTED`) and holidays for up to 3 months. Rejected, withdrawn and cancelled requests never appear, and attendance actuals (late, absent) are not part of the calendar.

| Viewer   | Sees                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin    | everyone, in full detail                                                                                                                       |
| Manager  | themselves and their direct reports in full detail; nothing about other teams                                                                  |
| Employee | themselves in full; same-department colleagues as name + `OUT` (leave) or `WFH` only; never colleagues' trips, permissions or pending requests |

- `includePending=true` adds pending requests as `tentative` for the people the caller sees in detail.
- Filters: `departmentId`, `team=true` (the caller's direct reports), `employeeId`, `type`.
- **Availability:** counts people expected each working day (joined, not past their last day, not invited) as out (leave, or a trip the viewer may see), WFH, or in the office. A colleague's trip counts as in the office for an Employee, so it's never revealed.

**Workplace requests (BE-11).** Four types in `src/modules/requests/request-types.ts`, registered with no engine changes:

| Key                     | Dates / times                                                                                 | Approver        | Effect                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `WFH`                   | range                                                                                         | manager → Admin | days read `WFH` when checked in; an approved WFH day closing without a check-in is `ABSENT` with flag `WFH_NO_CHECK_IN` |
| `ATTENDANCE_CORRECTION` | one past day (≤ 30 days back), `data.checkInTime` / `checkOutTime` (`HH:mm`), reason required | **Admin only**  | on approval, the BE-07 correction service applies it (source `APPROVAL`, history keeps the `requestId`)                 |
| `PERMISSION`            | one working day, `startTime`–`endTime` within working hours                                   | manager → Admin | arriving before the permission's end isn't Late                                                                         |
| `BUSINESS_TRIP`         | range, `data.destination`, `data.purpose`                                                     | manager → Admin | days read `BUSINESS_TRIP`, never Absent                                                                                 |

- **Never on the same days:** leave and WFH or business trips, in either direction (`409 REQUEST_OVERLAP`, decision 2026-10-10); also two WFH requests.
- **Attendance:** approving or cancelling a WFH, permission or trip recalculates the stored attendance days it covers.
- **Turning types off:** a company turns types off with `disabledRequestTypes` in `PATCH /company/settings`. Turned-off types disappear from `GET /requests/types` (Admins can pass `?includeDisabled=true`), and new requests of that type get `409 REQUEST_TYPE_DISABLED`. Existing requests stay visible.
- **Form fields:** `GET /requests/types` describes each type's own fields for forms (`fields: [{ name, kind, required, … }]`).

**Leave requests (BE-10).** Leave is the request type `LEAVE` on the engine (`src/modules/leave/leave-request.ts`), submitted with `POST /requests` and `data: { leaveTypeId, firstDayHalf?, lastDayHalf? }`.

- **Day count:** only working days count; weekends and holiday days are excluded and listed. A half day is the first day's `MORNING`/`AFTERNOON` for one day. For a range, it can start at noon (`firstDayHalf: "AFTERNOON"`) and end at noon (`lastDayHalf: "MORNING"`).
- **Refused:**
  - an inactive type, or a missing reason the type requires;
  - half days the type doesn't allow;
  - no working day (`NO_WORKING_DAYS`);
  - more than 30 days in the past (Admins recording it on someone's behalf are exempt);
  - beyond the end of the next leave year;
  - a range across two leave years (`CROSSES_LEAVE_YEAR`: split it);
  - overlapping the requester's own leave, or their pending/approved WFH days or business trips (`409 REQUEST_OVERLAP`, with a message to withdraw or cancel that request first; BE-11 applies the same rule the other way round);
  - not enough balance (`409 INSUFFICIENT_BALANCE`, checked under the balance lock).

- **Effects:** submit → reserve; approve → deduct per date, and stored attendance days in the range are recalculated (e.g. a past Absent becomes On Leave); reject or withdraw → release; cancel approved → restore the days not taken yet, and recalculate attendance.
- **Preview** (`POST /leave/requests/preview`) runs the same rules without saving and lists every problem. It also shows who else is off, as the caller may see them: an Employee sees same-department colleagues by name only (BE-03).

**Leave balances (BE-08).** A balance is never stored as a number. It is computed from an append-only **ledger** (`leaveledgerentries`), so every figure can be explained entry by entry:

- `ALLOWANCE`: the year's entitlement (and later corrections of it), ±;
- `ADJUSTMENT`: an Admin's change, ±, with a required reason;
- `RESERVATION`: held by a pending request;
- `RELEASE`: a reservation ending (rejected, withdrawn or approved);
- `DEDUCTION`: approved days, per date;
- `RESTORATION`: days returned when an approved request is cancelled.

`available = entitlement + adjustments − used − upcoming − pending`. Approved days are **upcoming** until their date passes, then **used** (`summarize()` in `balance-math.ts`).

- **Entitlements** are one `leavebalances` record per employee, tracked type and leave year. They're created on first use or by the rollover job, from the type's default allowance, **pro-rated** for people joining during the year (rounded to 0.5 day). Admins can override them per employee. Nothing carries over automatically; an Admin adds carry-over as an adjustment.
- **Leave year:** named by the calendar year it starts in, from the company's `leaveYearStartMonth` (January by default). The rollover job (every 15 minutes) opens each company's new year once.
- **For leave requests (BE-10):** `reserveDays`, `releaseReservation`, `deductApprovedDays` and `restoreDays` in `balance.service.ts`.
  - Each joins the caller's transaction and **locks the balance first** (`version` bump), so parallel requests are applied one after the other and can never spend the same days.
  - When there isn't enough, they answer `409 INSUFFICIENT_BALANCE`, unless the type allows a negative balance.
  - Untracked types (Unpaid) keep no balance and are never limited.
- **Leave types:**
  - New companies get Annual (21), Sick (30), Emergency (3) and Unpaid (untracked); existing companies get them through the `2026-10-10-default-leave-types` migration.
  - A type that has been used can't be deleted or change its balance tracking (`409 LEAVE_TYPE_IN_USE`); archive it instead.

**Attendance (BE-07).** Sessions (check-in … check-out, server time, IP and browser stored) roll up into one **AttendanceDay** per employee and company-calendar day.

- **Status engine** (`src/modules/attendance/status.ts`, pure), applied in this order:
  1. weekend or holiday → `WEEKEND` / `HOLIDAY`, never Late or Absent; a check-in adds the flag `WORKED_ON_NON_WORKING_DAY`;
  2. approved full-day leave, WFH or business trip → `ON_LEAVE` / `WFH` / `BUSINESS_TRIP`;
  3. with a check-in: `MISSING_CHECKOUT` once the day is over with a session open; otherwise `LATE` when the first check-in is after work start + grace (unless an approved permission or half day covers it), else `PRESENT`;
  4. without a check-in: `ABSENT` once a working day is over, if attendance was expected.
- **Expected attendance:** from the joining date through the last working day, for employees with `tracksAttendance`. Invited accounts are never expected.
- **Approved day effects:** leave and requests (BE-10/BE-11) tell attendance which days are covered through `registerDayEffectsProvider()`; until then no day has effects.
- **Never two open sessions:** a unique index on the open flag makes a double click or two tabs return the session already open. A session can't cross the company's midnight: one left open is closed without a check-out.
- **End-of-day close** (`close-job.ts`, every minute, started by `server.ts`): for each company, every day that is over in **its own timezone** and not closed yet (catching up at most 7 days) gets:
  - open sessions → `MISSING_CHECKOUT` (their time doesn't count);
  - expected employees with nothing → `ABSENT`;
  - history entries with actor "system".

  It is safe to run twice or on several servers.

- **Stored vs computed:** only days with sessions, an earlier record, or `ABSENT` are stored. Weekends, holidays and approved time off without a check-in are computed when a view asks.
- **Corrections** (`correctAttendance()`, Admin endpoints now, approved correction requests in BE-11):
  - add, edit or remove a session, with a required `reason`;
  - times must fall inside the company day, check-out after check-in, not in the future and with no overlaps;
  - the day is recalculated and flagged `CORRECTED`, and history keeps the old and new sessions and status.

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
  - BE-07: `attendancesessions` (unique open session per employee), `attendancedays` (unique per employee and day), `attendancecloseruns` (closed days per company). History ids are time-ordered UUIDs (v7), so entries from the same millisecond keep their order.
  - BE-08: `leavetypes` (unique name per company), `leavebalances` (one per employee, type and leave year; also the lock), `leaveledgerentries` (append-only), `leaveyearruns` (years opened per company). Migration `2026-10-10-default-leave-types`.
  - BE-09: `requests` (one per request of any type; type-specific fields in `data`). BE-10 stores leave as `type: "LEAVE"` (no new collection).

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
  - departments and employees (BE-06): every acceptance criterion (duplicate email, a 50 + 2 row CSV, manager loops, offboarding with reports, login blocked after the last day, the list per role, read-only manager view, the self-service phone);
  - attendance (BE-07): every acceptance criterion, with a clock the tests move to exact local times (09:07 vs 09:12, midnight in Dubai vs Bogotá, parallel check-ins);
  - leave (BE-08): every acceptance criterion, including six parallel requests against one balance (fails without the lock);
  - requests (BE-09): every acceptance criterion with two test-only request types, including two simultaneous approvals, the sole-Admin exception, and the attendance, holiday and offboarding connections;
  - leave requests (BE-10): every acceptance criterion (2 of 3 days, overlap, holiday excluded, half day, no working days, 40 days back, On Leave in attendance and back after cancelling) and the colleague privacy rule;
  - workplace requests (BE-11): every acceptance criterion, including a permission excusing a 10:45 check-in, an Admin-approved correction with its history, and turning a type off;
  - calendar (BE-12): every acceptance criterion, with two teams and two departments so each privacy boundary is checked;
  - dashboards (BE-13): every acceptance criterion, including the buckets adding up, matching the attendance day view, and each summary under 1 s for 300 employees;
  - reports (BE-14): every acceptance criterion (March rows and CSV column sums equal the screen totals, a Manager's register, 403 for an Employee on every view, deactivated on 15 March in March but not April, corrected = yes, 13 vs 14 months, 300 employees under 10 s), plus paging the detail view against the file, presets, balances including Unpaid, and the CSV writer (byte-order mark, quoting, formula guard).

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
