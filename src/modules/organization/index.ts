import { Router, type Request } from "express"
import { z } from "zod"

import { apiErrors } from "../../platform/http/errors.ts"
import { route } from "../../platform/http/validation.ts"
import {
  isValidFileSignature,
  loadSignedFile,
  readImageUpload,
  signedFileUrl,
} from "../../platform/storage/files.ts"
import { addDays, isPlainDate, isTimeZone } from "../../platform/time/time.ts"
import { authorize, requirePermission } from "../identity/access.ts"
import { getAuth, requireAuth } from "../identity/authenticate.ts"
import type { AppModule } from "../module.ts"
import {
  companyToday,
  holidayOn,
  isWorkingDay,
  loadWorkCalendar,
  weekdayOf,
  workingDaysBetween,
} from "./calendar.ts"
import { CompanyModel, LOCAL_TIME, WEEKDAYS } from "./company.model.ts"
import { addEmployeeRoutes } from "./employees.routes.ts"
import {
  addHoliday,
  changeHoliday,
  getCompanySettings,
  listHolidays,
  removeHoliday,
  setCompanyLogo,
  setEmployeePhoto,
  updateCompanySettings,
  type CompanySettings,
} from "./settings.service.ts"

const plainDate = z.string().refine(isPlainDate, "must be a date (YYYY-MM-DD)")
const localTime = z.string().regex(LOCAL_TIME, "must be a time (HH:mm)")
const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true")

const settingsBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z
    .string()
    .refine(isTimeZone, "must be an IANA timezone")
    .optional(),
  weekStart: z.enum(WEEKDAYS).optional(),
  workingDays: z
    .array(z.enum(WEEKDAYS))
    .min(1)
    .refine((days) => new Set(days).size === days.length, "each day once")
    .optional(),
  workStartTime: localTime.optional(),
  workEndTime: localTime.optional(),
  lateGraceMinutes: z.number().int().min(0).max(240).optional(),
  leaveYearStartMonth: z.number().int().min(1).max(12).optional(),
  /** Request type keys to turn off (BE-11), e.g. ["BUSINESS_TRIP"]; [] turns all on */
  disabledRequestTypes: z
    .array(z.string().regex(/^[A-Z_]{1,50}$/, "a request type key"))
    .max(20)
    .transform((keys) => [...new Set(keys)].sort())
    .optional(),
})

const holidayBody = z.object({
  name: z.string().trim().min(1).max(100),
  startDate: plainDate,
  endDate: plainDate,
})

/** The longest range GET /company/calendar answers, in days. */
const MAX_CALENDAR_DAYS = 366

/**
 * Organization (BE-05): company settings, work calendar, holidays, logo and
 * employee photo uploads, and signed file downloads (BE-05); departments
 * and employees (BE-06, employees.routes.ts). The exact requests and responses are on the Trello BE-05
 * card.
 */
export const organizationModule: AppModule = {
  name: "organization",
  routes(deps) {
    const router = Router()
    const auth = requireAuth({
      secret: deps.config.authTokenSecret,
      clock: deps.clock,
    })
    const adminOnly = requirePermission("companySettings", "edit")
    const fileUrl = (fileId: string | null) =>
      fileId
        ? signedFileUrl(fileId, {
            secret: deps.config.authTokenSecret,
            now: deps.clock.now(),
          })
        : null
    const settingsView = ({ logoFileId, ...settings }: CompanySettings) => ({
      ...settings,
      logoUrl: fileUrl(logoFileId),
    })
    const actor = (req: Request) =>
      ({ type: "USER", userId: getAuth(req).userId }) as const

    // ── settings ──
    router.get(
      "/company/settings",
      auth,
      route({}, async ({ req }) => ({
        status: 200,
        body: settingsView(
          await getCompanySettings(getAuth(req).companyId, deps)
        ),
      }))
    )
    router.patch(
      "/company/settings",
      auth,
      adminOnly,
      route({ body: settingsBody }, async ({ body, req }) => ({
        status: 200,
        body: settingsView(
          await updateCompanySettings(
            {
              companyId: getAuth(req).companyId,
              change: body,
              actor: actor(req),
            },
            deps
          )
        ),
      }))
    )

    // ── logo ──
    router.put(
      "/company/logo",
      auth,
      adminOnly,
      route({}, async ({ req }) => {
        const image = await readImageUpload(req)
        const fileId = await setCompanyLogo(
          { companyId: getAuth(req).companyId, image, actor: actor(req) },
          deps
        )
        return { status: 200, body: { logoUrl: fileUrl(fileId) } }
      })
    )
    router.delete(
      "/company/logo",
      auth,
      adminOnly,
      route({}, async ({ req }) => {
        await setCompanyLogo(
          { companyId: getAuth(req).companyId, image: null, actor: actor(req) },
          deps
        )
        return { status: 204 }
      })
    )

    // ── employee photo (own, or the Admin for anyone) ──
    const photoParams = z.object({ id: z.uuid() })
    router.put(
      "/employees/:id/photo",
      auth,
      route({ params: photoParams }, async ({ params, req }) => {
        await authorize(getAuth(req), "employeePhoto", "edit", params.id)
        const image = await readImageUpload(req)
        const result = await setEmployeePhoto(
          {
            companyId: getAuth(req).companyId,
            employeeId: params.id,
            image,
            actor: actor(req),
          },
          deps
        )
        if (!result) throw apiErrors.notFound()
        return { status: 200, body: { photoUrl: fileUrl(result.fileId) } }
      })
    )
    router.delete(
      "/employees/:id/photo",
      auth,
      route({ params: photoParams }, async ({ params, req }) => {
        await authorize(getAuth(req), "employeePhoto", "edit", params.id)
        const result = await setEmployeePhoto(
          {
            companyId: getAuth(req).companyId,
            employeeId: params.id,
            image: null,
            actor: actor(req),
          },
          deps
        )
        if (!result) throw apiErrors.notFound()
        return { status: 204 }
      })
    )

    // ── files (signed URLs, no login: used by <img src>) ──
    router.get(
      "/files/:id",
      route(
        {
          params: z.object({ id: z.uuid() }),
          query: z.object({
            expires: z.coerce.number().int(),
            signature: z.string().max(100),
          }),
        },
        async ({ params, query, res }) => {
          const signed = isValidFileSignature(
            { fileId: params.id, ...query },
            { secret: deps.config.authTokenSecret, now: deps.clock.now() }
          )
          const file = signed ? await loadSignedFile(params.id) : null
          if (!file) throw apiErrors.notFound()
          res
            .status(200)
            .set({
              "Content-Type": file.contentType,
              "Cache-Control": "private, max-age=3600",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "default-src 'none'",
            })
            .end(file.bytes)
          return { status: 200 }
        }
      )
    )

    // ── holidays ──
    router.get(
      "/company/holidays",
      auth,
      route(
        {
          query: z.object({
            year: z.coerce.number().int().min(2000).max(2100).optional(),
          }),
        },
        async ({ query, req }) => {
          const { companyId } = getAuth(req)
          let year = query.year
          if (year === undefined) {
            const company = await CompanyModel.findById(companyId, {
              timezone: 1,
              timezoneHistory: 1,
            }).lean()
            year = Number(companyToday(company!, deps.clock.now()).slice(0, 4))
          }
          return {
            status: 200,
            body: { year, items: await listHolidays({ companyId, year }) },
          }
        }
      )
    )
    router.post(
      "/company/holidays",
      auth,
      adminOnly,
      route({ body: holidayBody }, async ({ body, req }) => ({
        status: 201,
        body: await addHoliday(
          {
            companyId: getAuth(req).companyId,
            holiday: body,
            actor: actor(req),
          },
          deps
        ),
      }))
    )
    router.patch(
      "/company/holidays/:id",
      auth,
      adminOnly,
      route(
        { params: z.object({ id: z.uuid() }), body: holidayBody.partial() },
        async ({ params, body, req }) => {
          const result = await changeHoliday(
            {
              companyId: getAuth(req).companyId,
              id: params.id,
              change: body,
              actor: actor(req),
            },
            deps
          )
          if (!result) throw apiErrors.notFound()
          return { status: 200, body: result }
        }
      )
    )
    router.delete(
      "/company/holidays/:id",
      auth,
      adminOnly,
      route({ params: z.object({ id: z.uuid() }) }, async ({ params, req }) => {
        const removed = await removeHoliday(
          {
            companyId: getAuth(req).companyId,
            id: params.id,
            actor: actor(req),
          },
          deps
        )
        if (!removed) throw apiErrors.notFound()
        return { status: 204 }
      })
    )

    // ── departments and employees (BE-06) ──
    addEmployeeRoutes(router, deps, auth)

    // ── work calendar ──
    router.get(
      "/company/calendar",
      auth,
      route(
        {
          query: z.object({
            from: plainDate,
            to: plainDate,
            halfDayStart: booleanFlag,
            halfDayEnd: booleanFlag,
          }),
        },
        async ({ query, req }) => {
          if (query.to < query.from) {
            throw apiErrors.fieldError(
              "to",
              "OUT_OF_RANGE",
              "to must be on or after from"
            )
          }
          if (addDays(query.from, MAX_CALENDAR_DAYS - 1) < query.to) {
            throw apiErrors.fieldError(
              "to",
              "OUT_OF_RANGE",
              `at most ${MAX_CALENDAR_DAYS} days`
            )
          }
          const calendar = await loadWorkCalendar({
            companyId: getAuth(req).companyId,
            from: query.from,
            to: query.to,
          })
          if (!calendar) throw apiErrors.notFound()
          const days = []
          for (
            let date = query.from;
            date <= query.to;
            date = addDays(date, 1)
          ) {
            const holiday = holidayOn(calendar, date)
            days.push({
              date,
              weekday: weekdayOf(date),
              working: isWorkingDay(calendar, date),
              holiday: holiday ? { id: holiday.id, name: holiday.name } : null,
            })
          }
          return {
            status: 200,
            body: {
              from: query.from,
              to: query.to,
              workingDayCount: workingDaysBetween(
                calendar,
                query.from,
                query.to,
                query
              ),
              days,
            },
          }
        }
      )
    )

    return router
  },
}
