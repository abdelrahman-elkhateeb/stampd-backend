import type { PlainDate } from "../../platform/time/time.ts"
import type { DayEffect } from "./status.ts"

/**
 * The "approved day effects" interface (Trello BE-07): how leave and requests
 * (BE-10, BE-11) tell attendance which days an approved leave, WFH, business
 * trip or permission covers, without attendance waiting for them. They
 * register a provider; until then no day has effects.
 */
export type DayEffectEntry = DayEffect & { employeeId: string; date: PlainDate }

export type DayEffectsProvider = (input: {
  companyId: string
  employeeIds: string[]
  from: PlainDate
  to: PlainDate
}) => Promise<DayEffectEntry[]>

const providers: DayEffectsProvider[] = []

export function registerDayEffectsProvider(
  provider: DayEffectsProvider
): () => void {
  providers.push(provider)
  return () => {
    providers.splice(providers.indexOf(provider), 1)
  }
}

/** Effects by "employeeId|date". */
export async function loadDayEffects(input: {
  companyId: string
  employeeIds: string[]
  from: PlainDate
  to: PlainDate
}): Promise<Map<string, DayEffect[]>> {
  const byKey = new Map<string, DayEffect[]>()
  if (input.employeeIds.length === 0) return byKey
  const lists = await Promise.all(providers.map((provide) => provide(input)))
  for (const entry of lists.flat()) {
    const key = `${entry.employeeId}|${entry.date}`
    byKey.set(key, [
      ...(byKey.get(key) ?? []),
      {
        kind: entry.kind,
        fullDay: entry.fullDay,
        ...(entry.until ? { until: entry.until } : {}),
      },
    ])
  }
  return byKey
}
