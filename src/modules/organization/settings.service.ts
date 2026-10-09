import { withTransaction } from "../../platform/db/connection.ts"
import { apiErrors } from "../../platform/http/errors.ts"
import {
  deleteFile,
  saveFile,
  type ImageType,
} from "../../platform/storage/files.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { addDays, type PlainDate } from "../../platform/time/time.ts"
import { recordHistory, type HistoryActor } from "../history/history.service.ts"
import { companyToday } from "./calendar.ts"
import {
  CompanyModel,
  DEFAULT_SETTINGS,
  type Weekday,
} from "./company.model.ts"
import { EmployeeModel } from "./employee.model.ts"
import { HolidayModel } from "./holiday.model.ts"

/**
 * Company settings, holidays, logo and employee photos (Trello BE-05). Every
 * change is recorded in history (BE-04) in the same transaction.
 */
type Deps = { clock: Clock }

export type CompanySettings = {
  name: string
  logoFileId: string | null
  /** The newest timezone; see timezoneEffectiveFrom */
  timezone: string
  /** The day the newest timezone starts to apply, when that is still ahead; else null */
  timezoneEffectiveFrom: PlainDate | null
  weekStart: Weekday
  workingDays: Weekday[]
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  leaveYearStartMonth: number
}

export type SettingsChange = Partial<
  Omit<CompanySettings, "logoFileId" | "timezoneEffectiveFrom">
>

/** The fields whose changes go to history (everything an Admin can edit). */
const TRACKED = [
  "name",
  "timezone",
  "weekStart",
  "workingDays",
  "workStartTime",
  "workEndTime",
  "lateGraceMinutes",
  "leaveYearStartMonth",
  "logoFileId",
] as const

type CompanyDoc = NonNullable<Awaited<ReturnType<typeof loadCompany>>>
async function loadCompany(companyId: string) {
  return CompanyModel.findById(companyId).lean()
}

function toSettings(company: CompanyDoc, now: Date): CompanySettings {
  const pending = company.timezoneHistory?.at(-1)
  const effectiveFrom = pending?.until ? addDays(pending.until, 1) : null
  return {
    name: company.name,
    logoFileId: company.logoFileId ?? null,
    timezone: company.timezone,
    timezoneEffectiveFrom:
      effectiveFrom && effectiveFrom > companyToday(company, now)
        ? effectiveFrom
        : null,
    weekStart: (company.weekStart ?? "SUN") as Weekday,
    workingDays: company.workingDays as Weekday[],
    workStartTime: company.workStartTime ?? DEFAULT_SETTINGS.workStartTime,
    workEndTime: company.workEndTime ?? DEFAULT_SETTINGS.workEndTime,
    lateGraceMinutes:
      company.lateGraceMinutes ?? DEFAULT_SETTINGS.lateGraceMinutes,
    leaveYearStartMonth:
      company.leaveYearStartMonth ?? DEFAULT_SETTINGS.leaveYearStartMonth,
  }
}

function pick(settings: CompanySettings) {
  return Object.fromEntries(TRACKED.map((key) => [key, settings[key]]))
}

export async function getCompanySettings(
  companyId: string,
  deps: Deps
): Promise<CompanySettings> {
  const company = await loadCompany(companyId)
  if (!company) throw apiErrors.notFound()
  return toSettings(company, deps.clock.now())
}

/**
 * Applies a partial change. Work end must be after work start (422 on
 * workEndTime). A timezone change applies from the company's next day.
 */
export async function updateCompanySettings(
  input: { companyId: string; change: SettingsChange; actor: HistoryActor },
  deps: Deps
): Promise<CompanySettings> {
  const now = deps.clock.now()
  return withTransaction(async () => {
    const company = await loadCompany(input.companyId)
    if (!company) throw apiErrors.notFound()
    const before = toSettings(company, now)
    const after = { ...before, ...input.change }
    if (after.workEndTime <= after.workStartTime) {
      throw apiErrors.fieldError(
        "workEndTime",
        "OUT_OF_RANGE",
        "workEndTime must be after workStartTime"
      )
    }

    const update: Record<string, unknown> = { ...input.change }
    if (input.change.timezone && input.change.timezone !== company.timezone) {
      // Days up to today keep the timezone in force now; a second change on
      // the same day only replaces the newest value.
      const today = companyToday(company, now)
      const history = company.timezoneHistory ?? []
      if (!history.some((entry) => entry.until === today)) {
        update.timezoneHistory = [
          ...history,
          { timezone: company.timezone, until: today },
        ]
      }
    }
    const updated = await CompanyModel.findOneAndUpdate(
      { _id: input.companyId },
      { $set: update },
      { returnDocument: "after", runValidators: true }
    ).lean()

    const result = toSettings(updated!, now)
    await recordHistory(
      {
        companyId: input.companyId,
        action: "companySettings.changed",
        entityId: input.companyId,
        actor: input.actor,
        before: pick(before),
        after: pick(result),
      },
      deps
    )
    return result
  })
}

// ─────────────────────────────── logo & photos ───────────────────────────────

type Image = { bytes: Buffer; contentType: ImageType }

/** Replaces (or with `image: null`, removes) the company logo. Returns the new file id. */
export async function setCompanyLogo(
  input: {
    companyId: string
    image: Image | null
    actor: HistoryActor & { type: "USER" }
  },
  deps: Deps
): Promise<string | null> {
  return withTransaction(async () => {
    const company = await loadCompany(input.companyId)
    if (!company) throw apiErrors.notFound()
    const fileId = input.image
      ? await saveFile({
          companyId: input.companyId,
          purpose: "company-logo",
          uploadedBy: input.actor.userId,
          ...input.image,
        })
      : null
    await CompanyModel.updateOne(
      { _id: input.companyId },
      { $set: { logoFileId: fileId } }
    )
    if (company.logoFileId) {
      await deleteFile({ id: company.logoFileId, companyId: input.companyId })
    }
    await recordHistory(
      {
        companyId: input.companyId,
        action: "companySettings.changed",
        entityId: input.companyId,
        actor: input.actor,
        before: { logoFileId: company.logoFileId ?? null },
        after: { logoFileId: fileId },
      },
      deps
    )
    return fileId
  })
}

/** Replaces (or removes) an employee's photo. Undefined when the employee isn't in the company. */
export async function setEmployeePhoto(
  input: {
    companyId: string
    employeeId: string
    image: Image | null
    actor: HistoryActor & { type: "USER" }
  },
  deps: Deps
): Promise<{ fileId: string | null } | undefined> {
  return withTransaction(async () => {
    const employee = await EmployeeModel.findOne(
      { _id: input.employeeId, companyId: input.companyId },
      { photoFileId: 1 }
    ).lean()
    if (!employee) return undefined
    const fileId = input.image
      ? await saveFile({
          companyId: input.companyId,
          purpose: "employee-photo",
          uploadedBy: input.actor.userId,
          ...input.image,
        })
      : null
    await EmployeeModel.updateOne(
      { _id: input.employeeId, companyId: input.companyId },
      { $set: { photoFileId: fileId } }
    )
    if (employee.photoFileId) {
      await deleteFile({ id: employee.photoFileId, companyId: input.companyId })
    }
    await recordHistory(
      {
        companyId: input.companyId,
        action: "employee.photoChanged",
        entityId: input.employeeId,
        subjectEmployeeId: input.employeeId,
        actor: input.actor,
        before: { photoFileId: employee.photoFileId ?? null },
        after: { photoFileId: fileId },
      },
      deps
    )
    return { fileId }
  })
}

// ─────────────────────────────── holidays ───────────────────────────────

export type HolidayView = {
  id: string
  name: string
  startDate: PlainDate
  endDate: PlainDate
}

export type HolidayInput = {
  name: string
  startDate: PlainDate
  endDate: PlainDate
}

/** The longest holiday allowed, in days. */
export const MAX_HOLIDAY_DAYS = 31

/**
 * An approved request on a holiday's dates (BE-05 AC). Holidays never change
 * approved leave on their own: the API lists them and the Admin decides.
 */
export type AffectedRequest = {
  requestId: string
  employeeId: string
  employeeName: string
  type: string
  startDate: PlainDate
  endDate: PlainDate
}
type AffectedRequestFinder = (input: {
  companyId: string
  startDate: PlainDate
  endDate: PlainDate
}) => Promise<AffectedRequest[]>

const affectedRequestFinders: AffectedRequestFinder[] = []

/**
 * The leave and request modules (BE-09, BE-10) register how to find their
 * approved requests overlapping a date range. Until then the list is empty.
 */
export function registerAffectedRequestFinder(
  finder: AffectedRequestFinder
): () => void {
  affectedRequestFinders.push(finder)
  return () => {
    affectedRequestFinders.splice(affectedRequestFinders.indexOf(finder), 1)
  }
}

async function affectedRequests(
  companyId: string,
  holiday: HolidayInput
): Promise<AffectedRequest[]> {
  const lists = await Promise.all(
    affectedRequestFinders.map((find) =>
      find({
        companyId,
        startDate: holiday.startDate,
        endDate: holiday.endDate,
      })
    )
  )
  return lists.flat().sort((a, b) => a.startDate.localeCompare(b.startDate))
}

function assertHolidayRange(holiday: HolidayInput): void {
  if (holiday.endDate < holiday.startDate) {
    throw apiErrors.fieldError(
      "endDate",
      "OUT_OF_RANGE",
      "endDate must be on or after startDate"
    )
  }
  if (addDays(holiday.startDate, MAX_HOLIDAY_DAYS - 1) < holiday.endDate) {
    throw apiErrors.fieldError(
      "endDate",
      "OUT_OF_RANGE",
      `a holiday is at most ${MAX_HOLIDAY_DAYS} days`
    )
  }
}

const toHolidayView = (h: {
  _id: string
  name: string
  startDate?: string | null
  endDate?: string | null
}): HolidayView => ({
  id: h._id,
  name: h.name,
  startDate: h.startDate!,
  endDate: h.endDate!,
})

const holidayValues = (h: HolidayView) => ({
  [`holiday:${h.id}`]: {
    name: h.name,
    startDate: h.startDate,
    endDate: h.endDate,
  },
})

/** Holidays with at least one day in `year`, by start date. */
export async function listHolidays(input: {
  companyId: string
  year: number
}): Promise<HolidayView[]> {
  const holidays = await HolidayModel.find({
    companyId: input.companyId,
    startDate: { $lte: `${input.year}-12-31` },
    endDate: { $gte: `${input.year}-01-01` },
  })
    .sort({ startDate: 1, name: 1 })
    .lean()
  return holidays.map(toHolidayView)
}

export async function addHoliday(
  input: { companyId: string; holiday: HolidayInput; actor: HistoryActor },
  deps: Deps
): Promise<{ holiday: HolidayView; affectedRequests: AffectedRequest[] }> {
  assertHolidayRange(input.holiday)
  const holiday = await withTransaction(async () => {
    const [created] = await HolidayModel.create([
      { companyId: input.companyId, ...input.holiday },
    ])
    const view = toHolidayView(created!)
    await recordHistory(
      {
        companyId: input.companyId,
        action: "holiday.added",
        entityId: input.companyId,
        actor: input.actor,
        before: {},
        after: holidayValues(view),
      },
      deps
    )
    return view
  })
  return {
    holiday,
    affectedRequests: await affectedRequests(input.companyId, holiday),
  }
}

/** Undefined when the holiday isn't in the company. */
export async function changeHoliday(
  input: {
    companyId: string
    id: string
    change: Partial<HolidayInput>
    actor: HistoryActor
  },
  deps: Deps
): Promise<
  { holiday: HolidayView; affectedRequests: AffectedRequest[] } | undefined
> {
  const holiday = await withTransaction(async () => {
    const existing = await HolidayModel.findOne({
      _id: input.id,
      companyId: input.companyId,
    }).lean()
    if (!existing) return undefined
    const before = toHolidayView(existing)
    const after = { ...before, ...input.change }
    assertHolidayRange(after)
    await HolidayModel.updateOne(
      { _id: input.id, companyId: input.companyId },
      { $set: input.change },
      { runValidators: true }
    )
    await recordHistory(
      {
        companyId: input.companyId,
        action: "holiday.changed",
        entityId: input.companyId,
        actor: input.actor,
        before: holidayValues(before),
        after: holidayValues(after),
      },
      deps
    )
    return after
  })
  if (!holiday) return undefined
  return {
    holiday,
    affectedRequests: await affectedRequests(input.companyId, holiday),
  }
}

/** false when the holiday isn't in the company. */
export async function removeHoliday(
  input: { companyId: string; id: string; actor: HistoryActor },
  deps: Deps
): Promise<boolean> {
  return withTransaction(async () => {
    const existing = await HolidayModel.findOneAndDelete({
      _id: input.id,
      companyId: input.companyId,
    }).lean()
    if (!existing) return false
    await recordHistory(
      {
        companyId: input.companyId,
        action: "holiday.removed",
        entityId: input.companyId,
        actor: input.actor,
        before: holidayValues(toHolidayView(existing)),
        after: {},
      },
      deps
    )
    return true
  })
}

/** What attendance needs from the settings (BE-07). */
export type AttendanceRules = {
  timezone: string
  timezoneHistory: { timezone: string; until: string }[]
  workStartTime: string
  lateGraceMinutes: number
}

export async function getAttendanceRules(
  companyId: string
): Promise<AttendanceRules | undefined> {
  const company = await loadCompany(companyId)
  if (!company) return undefined
  return {
    timezone: company.timezone,
    timezoneHistory: (company.timezoneHistory ?? []).flatMap((entry) =>
      entry.until ? [{ timezone: entry.timezone, until: entry.until }] : []
    ),
    workStartTime: company.workStartTime ?? DEFAULT_SETTINGS.workStartTime,
    lateGraceMinutes:
      company.lateGraceMinutes ?? DEFAULT_SETTINGS.lateGraceMinutes,
  }
}

/** Every company id (for jobs that run per company, e.g. the attendance close). */
export async function listCompanyIds(): Promise<string[]> {
  const companies = await CompanyModel.find({}, { _id: 1 }).lean()
  return companies.map((company) => company._id)
}
