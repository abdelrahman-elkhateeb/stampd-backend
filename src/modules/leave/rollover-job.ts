import type { Logger } from "../../platform/logging/logger.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { getAccounts } from "../identity/accounts.ts"
import { loadCompanyToday } from "../organization/calendar.ts"
import { getRoster } from "../organization/organization.service.ts"
import {
  getCompanySettings,
  listCompanyIds,
} from "../organization/settings.service.ts"
import { leaveYearOf } from "./balance-math.ts"
import { openLeaveYear } from "./balance.service.ts"
import { LeaveYearRunModel } from "./leave.model.ts"

/**
 * The leave-year rollover (Trello BE-08). When a company's leave year starts
 * (by its own calendar and leave-year start month), every employee who isn't
 * deactivated gets a new entitlement per tracked type, pro-rated for joiners.
 * Nothing carries over automatically. Runs every 15 minutes and opens each
 * company's year once; entitlements are also created on first use, so a late
 * run loses nothing.
 */
export async function runLeaveRollover(deps: {
  clock: Clock
  logger: Logger
}): Promise<{ companyId: string; year: number; created: number }[]> {
  const opened: { companyId: string; year: number; created: number }[] = []
  for (const companyId of await listCompanyIds()) {
    try {
      const [settings, today] = await Promise.all([
        getCompanySettings(companyId, deps),
        loadCompanyToday(companyId, deps.clock.now()),
      ])
      const year = leaveYearOf(today!, settings.leaveYearStartMonth)
      if (await LeaveYearRunModel.exists({ companyId, year })) continue
      const roster = await getRoster({ companyId })
      const accounts = await getAccounts({
        companyId,
        ids: roster.map((p) => p.id),
      })
      const employeeIds = roster
        .filter((p) => accounts.get(p.id)?.status !== "DEACTIVATED")
        .map((p) => p.id)
      const created = await openLeaveYear(
        { companyId, year, employeeIds },
        deps
      )
      await LeaveYearRunModel.updateOne(
        { companyId, year },
        { $setOnInsert: { openedAt: deps.clock.now() } },
        { upsert: true }
      )
      opened.push({ companyId, year, created })
    } catch (error) {
      deps.logger.error("leave rollover failed", { companyId, error })
    }
  }
  if (opened.length) deps.logger.info("leave years opened", { opened })
  return opened
}
