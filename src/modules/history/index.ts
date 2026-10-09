import { Router } from "express"
import { z } from "zod"

import { apiErrors } from "../../platform/http/errors.ts"
import {
  listQuery,
  toPage,
  toPageRequest,
} from "../../platform/http/pagination.ts"
import { route } from "../../platform/http/validation.ts"
import { authorize, type Resource } from "../identity/access.ts"
import {
  getAuth,
  requireAuth,
  type AuthContext,
} from "../identity/authenticate.ts"
import type { AppModule } from "../module.ts"
import { getEmployeeNames } from "../organization/organization.service.ts"
import { HistoryEntryModel, type EntityType } from "./history.model.ts"

/** URL segment → entity type, and the BE-03 resource whose "view" grant applies. */
const RECORD_TYPES = {
  "attendance-days": { entityType: "ATTENDANCE_DAY", resource: "attendance" },
  "leave-balances": { entityType: "LEAVE_BALANCE", resource: "leave" },
  requests: { entityType: "REQUEST", resource: "requests" },
  employees: { entityType: "EMPLOYEE", resource: "employee" },
  "company-settings": {
    entityType: "COMPANY_SETTINGS",
    resource: "companySettings",
  },
} as const satisfies Record<
  string,
  { entityType: EntityType; resource: Resource }
>
type RecordType = keyof typeof RECORD_TYPES

/**
 * May the caller read this record's history? The same rule as reading the
 * record itself (BE-03); anything else is 404, like a record that doesn't
 * exist.
 *  - employees: the employee id is the record
 *  - company-settings: the record id is the caller's company id
 *  - attendance days, leave balances, requests: whose record it is comes
 *    from its history entries; no entries → 404
 */
async function assertCanRead(
  auth: AuthContext,
  type: RecordType,
  entityId: string
): Promise<void> {
  const { entityType, resource } = RECORD_TYPES[type]
  if (entityType === "COMPANY_SETTINGS") {
    if (entityId !== auth.companyId) throw apiErrors.notFound()
    return
  }
  if (entityType === "EMPLOYEE") {
    await authorize(auth, "employee", "view", entityId)
    return
  }
  const latest = await HistoryEntryModel.findOne(
    { companyId: auth.companyId, entityType, entityId },
    { subjectEmployeeId: 1 }
  )
    .sort({ at: -1 })
    .lean()
  if (!latest?.subjectEmployeeId) throw apiErrors.notFound()
  await authorize(
    auth,
    resource as "attendance" | "leave" | "requests",
    "view",
    latest.subjectEmployeeId
  )
}

/**
 * History (BE-04). One read endpoint; there is deliberately no endpoint to
 * create, edit or delete entries: modules write them with recordHistory()
 * as part of each change.
 *
 * GET /history/{recordType}/{id}?page&pageSize, newest first.
 * The exact response is on the Trello BE-04 card.
 */
export const historyModule: AppModule = {
  name: "history",
  routes(deps) {
    const router = Router()
    router.get(
      "/history/:recordType/:id",
      requireAuth({ secret: deps.config.authTokenSecret, clock: deps.clock }),
      route(
        {
          params: z.object({
            recordType: z.enum(Object.keys(RECORD_TYPES) as [RecordType]),
            id: z.uuid(),
          }),
          query: listQuery({ sortFields: ["at"], defaultSort: "-at" }),
        },
        async ({ params, query, req }) => {
          const auth = getAuth(req)
          await assertCanRead(auth, params.recordType, params.id)

          const filter = {
            companyId: auth.companyId,
            entityType: RECORD_TYPES[params.recordType].entityType,
            entityId: params.id,
          }
          const page = toPageRequest(query)
          const [entries, total] = await Promise.all([
            HistoryEntryModel.find(filter)
              // Ties (same millisecond) break by the time-ordered id, same direction.
              .sort({ at: page.mongoSort.at!, _id: page.mongoSort.at! })
              .skip(page.skip)
              .limit(page.limit)
              .lean(),
            HistoryEntryModel.countDocuments(filter),
          ])
          const names = await getEmployeeNames({
            companyId: auth.companyId,
            ids: [
              ...new Set(
                entries.flatMap((e) => (e.actorId ? [e.actorId] : []))
              ),
            ],
          })
          const items = entries.map((entry) => ({
            id: entry._id,
            action: entry.action,
            at: entry.at.toISOString(),
            actor: entry.actorId
              ? {
                  type: "USER",
                  id: entry.actorId,
                  name: names.get(entry.actorId) ?? null,
                }
              : { type: "SYSTEM", job: entry.systemJob },
            source: entry.source,
            oldValues: entry.oldValues,
            newValues: entry.newValues,
            reason: entry.reason,
          }))
          return { status: 200, body: toPage(items, total, page) }
        }
      )
    )
    return router
  },
}
