import type { Logger } from "../../platform/logging/logger.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { addDays, type PlainDate } from "../../platform/time/time.ts"
import { companyToday } from "../organization/calendar.ts"
import {
  getAttendanceRules,
  listCompanyIds,
} from "../organization/settings.service.ts"
import { AttendanceCloseRunModel } from "./attendance.model.ts"
import { closeAttendanceDay } from "./attendance.service.ts"

/** How many missed days the job catches up after downtime. */
export const MAX_CATCH_UP_DAYS = 7

/**
 * The end-of-day job (Trello BE-07). Each company's day closes at midnight in
 * the company's own timezone: every run closes, per company, the days that
 * are over and not yet closed (yesterday, plus up to a week missed while the
 * server was down). Runs every minute; running twice closes nothing twice.
 */
export async function runAttendanceClose(deps: {
  clock: Clock
  logger: Logger
}): Promise<{ companyId: string; date: PlainDate }[]> {
  const closed: { companyId: string; date: PlainDate }[] = []
  for (const companyId of await listCompanyIds()) {
    try {
      const rules = await getAttendanceRules(companyId)
      if (!rules) continue
      const yesterday = addDays(companyToday(rules, deps.clock.now()), -1)
      const last = await AttendanceCloseRunModel.findOne({ companyId })
        .sort({ date: -1 })
        .lean()
      const earliest = addDays(yesterday, -(MAX_CATCH_UP_DAYS - 1))
      let date = last?.date ? addDays(last.date, 1) : yesterday
      if (date < earliest) date = earliest
      for (; date <= yesterday; date = addDays(date, 1)) {
        await closeAttendanceDay({ companyId, date }, deps)
        await AttendanceCloseRunModel.updateOne(
          { companyId, date },
          { $setOnInsert: { closedAt: deps.clock.now() } },
          { upsert: true }
        )
        closed.push({ companyId, date })
      }
    } catch (error) {
      deps.logger.error("attendance close failed", { companyId, error })
    }
  }
  if (closed.length) deps.logger.info("attendance days closed", { closed })
  return closed
}
