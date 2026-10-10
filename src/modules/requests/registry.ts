import type { z } from "zod"

import type { Clock } from "../../platform/time/clock.ts"
import type { PlainDate } from "../../platform/time/time.ts"
import type { DayEffect } from "../attendance/status.ts"
import type { HistoryActor } from "../history/history.service.ts"
import type { RequestStatus } from "./request.model.ts"

/**
 * The request type registry (Trello BE-09). A request type is added by
 * registering its definition (BE-10 registers Leave; BE-11 WFH, Permission,
 * Business Trip and Attendance Correction). The engine needs no change.
 */

/** A request as type hooks see it. */
export type RequestRecord = {
  id: string
  companyId: string
  type: string
  requesterId: string
  startDate: PlainDate
  endDate: PlainDate
  startTime: string | null
  endTime: string | null
  reason: string | null
  data: Record<string, unknown>
  status: RequestStatus
}

export type HookContext = {
  request: RequestRecord
  /** Who caused the change (requester, approver, Admin or a system job) */
  actor: HistoryActor
  /** The company's today */
  today: PlainDate
  deps: { clock: Clock }
}

export type RequestTypeDefinition = {
  /** Stable key stored on requests, e.g. "LEAVE" */
  key: string
  /** Shown in lists (the frontend translates by key) */
  label: string
  /**
   * MANAGER_WITH_ADMIN_FALLBACK: the requester's manager decides, or any
   * Admin (always; and alone when there is no manager). ADMIN_ONLY: Admins.
   */
  approverPolicy: "MANAGER_WITH_ADMIN_FALLBACK" | "ADMIN_ONLY"
  /** SINGLE_DAY: endDate must equal startDate. RANGE: endDate ≥ startDate. */
  dates: "SINGLE_DAY" | "RANGE"
  /** Whether startTime/endTime ("HH:mm") are expected */
  times: "NONE" | "OPTIONAL" | "REQUIRED"
  reason: "OPTIONAL" | "REQUIRED"
  /** The type's own fields (`data`), validated with Zod: errors come back as data.<field> */
  data: z.ZodType<Record<string, unknown>>
  /**
   * How colleagues may see it in "who is out" views (BE-03): as "Out"
   * (leave), "WFH", or not at all (trips, permissions, corrections).
   */
  colleagueVisibility: "OUT" | "WFH" | "HIDDEN"
  /** What an approved request means for attendance on a day of it (BE-07), if anything */
  dayEffect?: (request: RequestRecord, date: PlainDate) => DayEffect | null
  /** Extra checks at submission (throw a field error to refuse) */
  validate?: (
    ctx: HookContext & { data: Record<string, unknown> }
  ) => Promise<void>
  /**
   * Effects, run inside the same transaction as the status change: a
   * throw refuses the change. onCancel runs for withdrawal and cancellation.
   */
  onSubmit?: (ctx: HookContext) => Promise<void>
  onApprove?: (ctx: HookContext) => Promise<void>
  onReject?: (ctx: HookContext) => Promise<void>
  onCancel?: (
    ctx: HookContext & {
      from: "PENDING" | "APPROVED" | "CANCELLATION_REQUESTED"
    }
  ) => Promise<void>
}

const definitions = new Map<string, RequestTypeDefinition>()

/** Registers a type. Registering the same key again replaces it (tests, hot reload). */
export function registerRequestType(
  definition: RequestTypeDefinition
): () => void {
  definitions.set(definition.key, definition)
  return () => {
    if (definitions.get(definition.key) === definition) {
      definitions.delete(definition.key)
    }
  }
}

export function getRequestType(key: string): RequestTypeDefinition | undefined {
  return definitions.get(key)
}

export function listRequestTypes(): RequestTypeDefinition[] {
  return [...definitions.values()]
}
