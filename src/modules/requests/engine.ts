import { withTransaction } from "../../platform/db/connection.ts"
import { publish } from "../../platform/events.ts"
import { apiErrors, type FieldError } from "../../platform/http/errors.ts"
import { toFieldErrors } from "../../platform/http/validation.ts"
import type { Logger } from "../../platform/logging/logger.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { addDays, type PlainDate } from "../../platform/time/time.ts"
import { registerDayEffectsProvider } from "../attendance/day-effects.ts"
import {
  listHistoryEntries,
  recordHistory,
  type HistoryActor,
} from "../history/history.service.ts"
import {
  authorize,
  isActiveDirectReport,
  scopedEmployeeIds,
} from "../identity/access.ts"
import { countActiveAdmins } from "../identity/accounts.ts"
import type { AuthContext } from "../identity/authenticate.ts"
import { loadCompanyToday } from "../organization/calendar.ts"
import { LOCAL_TIME } from "../organization/company.model.ts"
import { registerOffboardingHook } from "../organization/employees.service.ts"
import {
  getEmployeeNames,
  getReportingLine,
} from "../organization/organization.service.ts"
import { registerAffectedRequestFinder } from "../organization/settings.service.ts"
import {
  getRequestType,
  listRequestTypes,
  type HookContext,
  type RequestRecord,
  type RequestTypeDefinition,
} from "./registry.ts"
import { RequestModel, type RequestStatus } from "./request.model.ts"

/**
 * The request & approval engine (Trello BE-09): submission, the lifecycle,
 * who decides, first-decision-wins, cancellations, lists and detail. Every
 * status change runs the type's effect hook and writes history (BE-04) in
 * one transaction, then publishes a domain event (BE-15).
 */
export type Deps = { clock: Clock; logger?: Logger }

/** Statuses during which an approved request is in effect. */
const IN_EFFECT: RequestStatus[] = ["APPROVED", "CANCELLATION_REQUESTED"]
/** The longest request, in days. */
export const MAX_REQUEST_DAYS = 366

type RequestDoc = {
  _id: string
  companyId: string
  type: string
  requesterId: string
  startDate?: string | null
  endDate?: string | null
  startTime?: string | null
  endTime?: string | null
  reason?: string | null
  data?: unknown
  status: string
  createdBy: string
  decidedBy?: string | null
  decidedAt?: Date | null
  decisionComment?: string | null
  selfApproved?: boolean | null
  cancellationRequestedAt?: Date | null
  cancellationReason?: string | null
  cancelledBy?: string | null
  cancelledAt?: Date | null
  createdAt?: Date
}

const toRecord = (doc: RequestDoc): RequestRecord => ({
  id: doc._id,
  companyId: doc.companyId,
  type: doc.type,
  requesterId: doc.requesterId,
  startDate: doc.startDate!,
  endDate: doc.endDate!,
  startTime: doc.startTime ?? null,
  endTime: doc.endTime ?? null,
  reason: doc.reason ?? null,
  data: (doc.data ?? {}) as Record<string, unknown>,
  status: doc.status as RequestStatus,
})

function requireType(key: string): RequestTypeDefinition {
  const definition = getRequestType(key)
  if (!definition) {
    throw apiErrors.fieldError(
      "type",
      "UNKNOWN_REFERENCE",
      "unknown request type"
    )
  }
  return definition
}

const companyToday = async (companyId: string, deps: Deps) =>
  (await loadCompanyToday(companyId, deps.clock.now()))!

const statusConflict = (status: string) =>
  apiErrors.conflictWith(
    "REQUEST_STATUS_CONFLICT",
    `The request is ${status} now; refresh and try again`
  )

const publishLater = (
  deps: Deps,
  name: string,
  record: RequestRecord,
  actor: HistoryActor
) =>
  publish(
    {
      name,
      companyId: record.companyId,
      at: deps.clock.now(),
      payload: {
        requestId: record.id,
        type: record.type,
        requesterId: record.requesterId,
        status: record.status,
        actorId: actor.type === "USER" ? actor.userId : null,
      },
    },
    (error, event) =>
      deps.logger?.error("event handler failed", { event: event.name, error })
  )

// ─────────────────────────────── who decides ───────────────────────────────

type DecisionRight = "MANAGER" | "ADMIN" | "SOLE_ADMIN_SELF"

/**
 * May the caller approve, reject or decide a cancellation of this request?
 *  - nobody decides their own request, except the company's only Admin
 *    when no manager is above them ("self-approved");
 *  - Admins decide any request;
 *  - the requester's current manager decides, unless the type is Admin-only.
 */
async function decisionRight(
  auth: AuthContext,
  request: RequestRecord,
  definition: RequestTypeDefinition
): Promise<DecisionRight | null> {
  if (auth.userId === request.requesterId) {
    if (auth.role !== "ADMIN") return null
    const [admins, line] = await Promise.all([
      countActiveAdmins(auth.companyId),
      getReportingLine({ id: auth.userId, companyId: auth.companyId }),
    ])
    return admins === 1 && !line?.managerId ? "SOLE_ADMIN_SELF" : null
  }
  if (auth.role === "ADMIN") return "ADMIN"
  if (definition.approverPolicy === "ADMIN_ONLY") return null
  if (
    auth.role === "MANAGER" &&
    (await isActiveDirectReport(auth, request.requesterId))
  ) {
    return "MANAGER"
  }
  return null
}

async function loadVisible(auth: AuthContext, id: string) {
  const doc = await RequestModel.findOne({
    _id: id,
    companyId: auth.companyId,
  }).lean()
  if (!doc) throw apiErrors.notFound()
  await authorize(auth, "requests", "view", doc.requesterId)
  return doc as RequestDoc
}

async function assertMayDecide(auth: AuthContext, doc: RequestDoc) {
  const record = toRecord(doc)
  const definition = requireType(doc.type)
  const right = await decisionRight(auth, record, definition)
  if (!right) {
    throw auth.userId === doc.requesterId
      ? apiErrors.selfApproval()
      : apiErrors.forbidden(
          "Only the requester's manager or an Admin can decide"
        )
  }
  return { record, definition, right }
}

// ─────────────────────────────── status changes ───────────────────────────────

/**
 * Moves a request from one of `from` to `to` — only if it is still in one of
 * `from` when the write happens, so of two simultaneous decisions exactly
 * one wins (the other gets 409 REQUEST_STATUS_CONFLICT). The type's hook and
 * the history entry run in the same transaction.
 */
async function transition(
  input: {
    companyId: string
    id: string
    from: RequestStatus[]
    to: RequestStatus
    set?: Record<string, unknown>
    actor: HistoryActor
    reason?: string | null
    hook?: (ctx: HookContext, before: RequestRecord) => Promise<void>
    event: string
  },
  deps: Deps
): Promise<RequestRecord> {
  const today = await companyToday(input.companyId, deps)
  const record = await withTransaction(async () => {
    const before = await RequestModel.findOneAndUpdate(
      {
        _id: input.id,
        companyId: input.companyId,
        status: { $in: input.from },
      },
      { $set: { status: input.to, ...input.set } },
      { returnDocument: "before" }
    ).lean()
    if (!before) {
      const current = await RequestModel.findOne(
        { _id: input.id, companyId: input.companyId },
        { status: 1 }
      ).lean()
      throw current ? statusConflict(current.status) : apiErrors.notFound()
    }
    const previous = toRecord(before as RequestDoc)
    const after = { ...previous, status: input.to }
    await input.hook?.(
      { request: after, actor: input.actor, today, deps },
      previous
    )
    await recordHistory(
      {
        companyId: input.companyId,
        action: "request.statusChanged",
        entityId: input.id,
        subjectEmployeeId: previous.requesterId,
        actor: input.actor,
        before: { status: previous.status },
        after: { status: input.to },
        reason: input.reason,
      },
      deps
    )
    return after
  })
  await publishLater(deps, input.event, record, input.actor)
  return record
}

const approverActor = (auth: AuthContext): HistoryActor => ({
  type: "USER",
  userId: auth.userId,
  source: "APPROVAL",
})

export async function approveRequest(
  input: { auth: AuthContext; id: string; comment?: string | null },
  deps: Deps
) {
  const doc = await loadVisible(input.auth, input.id)
  const { definition, right } = await assertMayDecide(input.auth, doc)
  return transition(
    {
      companyId: input.auth.companyId,
      id: input.id,
      from: ["PENDING"],
      to: "APPROVED",
      set: {
        decidedBy: input.auth.userId,
        decidedAt: deps.clock.now(),
        decisionComment: input.comment?.trim() || null,
        selfApproved: right === "SOLE_ADMIN_SELF",
      },
      actor: approverActor(input.auth),
      reason: input.comment,
      hook: (ctx) => definition.onApprove?.(ctx) ?? Promise.resolve(),
      event: "request.approved",
    },
    deps
  )
}

/** Rejection requires a reason (422 reason REQUIRED). */
export async function rejectRequest(
  input: { auth: AuthContext; id: string; reason: string | null | undefined },
  deps: Deps
) {
  if (!input.reason?.trim()) {
    throw apiErrors.fieldError(
      "reason",
      "REQUIRED",
      "a reason is required to reject"
    )
  }
  const doc = await loadVisible(input.auth, input.id)
  const { definition } = await assertMayDecide(input.auth, doc)
  return transition(
    {
      companyId: input.auth.companyId,
      id: input.id,
      from: ["PENDING"],
      to: "REJECTED",
      set: {
        decidedBy: input.auth.userId,
        decidedAt: deps.clock.now(),
        decisionComment: input.reason.trim(),
      },
      actor: approverActor(input.auth),
      reason: input.reason,
      hook: (ctx) => definition.onReject?.(ctx) ?? Promise.resolve(),
      event: "request.rejected",
    },
    deps
  )
}

/** The requester withdraws a pending request; the type's on-cancel effects run. */
export async function withdrawRequest(
  input: { auth: AuthContext; id: string },
  deps: Deps
) {
  const doc = await loadVisible(input.auth, input.id)
  if (doc.requesterId !== input.auth.userId) {
    throw apiErrors.forbidden("Only the requester can withdraw")
  }
  const definition = requireType(doc.type)
  return transition(
    {
      companyId: input.auth.companyId,
      id: input.id,
      from: ["PENDING"],
      to: "WITHDRAWN",
      actor: { type: "USER", userId: input.auth.userId },
      hook: (ctx) =>
        definition.onCancel?.({ ...ctx, from: "PENDING" }) ?? Promise.resolve(),
      event: "request.withdrawn",
    },
    deps
  )
}

/**
 * The requester asks to cancel an approved request that hasn't started
 * (409 REQUEST_STARTED otherwise: only an Admin cancels those). It stays in
 * effect as CANCELLATION_REQUESTED until the approver accepts or declines.
 */
export async function requestCancellation(
  input: { auth: AuthContext; id: string; reason?: string | null },
  deps: Deps
) {
  const doc = await loadVisible(input.auth, input.id)
  if (doc.requesterId !== input.auth.userId) {
    throw apiErrors.forbidden("Only the requester can ask to cancel")
  }
  if (doc.startDate! <= (await companyToday(input.auth.companyId, deps))) {
    throw apiErrors.conflictWith(
      "REQUEST_STARTED",
      "The request has started; ask an Admin to cancel it"
    )
  }
  return transition(
    {
      companyId: input.auth.companyId,
      id: input.id,
      from: ["APPROVED"],
      to: "CANCELLATION_REQUESTED",
      set: {
        cancellationRequestedAt: deps.clock.now(),
        cancellationReason: input.reason?.trim() || null,
      },
      actor: { type: "USER", userId: input.auth.userId },
      reason: input.reason,
      event: "request.cancellationRequested",
    },
    deps
  )
}

/** The approver accepts (→ CANCELLED, on-cancel effects run) or declines (→ APPROVED). */
export async function decideCancellation(
  input: {
    auth: AuthContext
    id: string
    accept: boolean
    comment?: string | null
  },
  deps: Deps
) {
  const doc = await loadVisible(input.auth, input.id)
  const { definition } = await assertMayDecide(input.auth, doc)
  return input.accept
    ? transition(
        {
          companyId: input.auth.companyId,
          id: input.id,
          from: ["CANCELLATION_REQUESTED"],
          to: "CANCELLED",
          set: {
            cancelledBy: input.auth.userId,
            cancelledAt: deps.clock.now(),
          },
          actor: approverActor(input.auth),
          reason: input.comment,
          hook: (ctx) =>
            definition.onCancel?.({ ...ctx, from: "CANCELLATION_REQUESTED" }) ??
            Promise.resolve(),
          event: "request.cancelled",
        },
        deps
      )
    : transition(
        {
          companyId: input.auth.companyId,
          id: input.id,
          from: ["CANCELLATION_REQUESTED"],
          to: "APPROVED",
          actor: approverActor(input.auth),
          reason: input.comment,
          event: "request.cancellationDeclined",
        },
        deps
      )
}

/** An Admin cancels an approved request directly (started or not), with a reason. */
export async function cancelRequest(
  input: { auth: AuthContext; id: string; reason: string | null | undefined },
  deps: Deps
) {
  if (input.auth.role !== "ADMIN") throw apiErrors.forbidden()
  if (!input.reason?.trim()) {
    throw apiErrors.fieldError(
      "reason",
      "REQUIRED",
      "a reason is required to cancel"
    )
  }
  const doc = await loadVisible(input.auth, input.id)
  const definition = requireType(doc.type)
  return transition(
    {
      companyId: input.auth.companyId,
      id: input.id,
      from: IN_EFFECT,
      to: "CANCELLED",
      set: {
        cancelledBy: input.auth.userId,
        cancelledAt: deps.clock.now(),
        cancellationReason: input.reason.trim(),
      },
      actor: approverActor(input.auth),
      reason: input.reason,
      hook: (ctx, before) =>
        definition.onCancel?.({
          ...ctx,
          from: before.status as "APPROVED" | "CANCELLATION_REQUESTED",
        }) ?? Promise.resolve(),
      event: "request.cancelled",
    },
    deps
  )
}

// ─────────────────────────────── submission ───────────────────────────────

export type SubmitInput = {
  type: string
  /** An Admin submitting for someone else */
  employeeId?: string
  startDate: PlainDate
  endDate?: PlainDate
  startTime?: string | null
  endTime?: string | null
  reason?: string | null
  data?: Record<string, unknown>
  /** Admin on behalf of an employee: record it as already approved */
  approved?: boolean
}

function checkShape(
  definition: RequestTypeDefinition,
  input: SubmitInput
): FieldError[] {
  const errors: FieldError[] = []
  const end = input.endDate ?? input.startDate
  if (definition.dates === "SINGLE_DAY" && end !== input.startDate) {
    errors.push({
      field: "endDate",
      code: "OUT_OF_RANGE",
      message: "this request is for a single day",
    })
  } else if (end < input.startDate) {
    errors.push({
      field: "endDate",
      code: "OUT_OF_RANGE",
      message: "endDate must be on or after startDate",
    })
  } else if (addDays(input.startDate, MAX_REQUEST_DAYS - 1) < end) {
    errors.push({
      field: "endDate",
      code: "OUT_OF_RANGE",
      message: `at most ${MAX_REQUEST_DAYS} days`,
    })
  }
  const times = [input.startTime, input.endTime]
  if (definition.times === "NONE" && times.some(Boolean)) {
    errors.push({
      field: "startTime",
      code: "INVALID_FORMAT",
      message: "this request type has no times",
    })
  }
  if (definition.times === "REQUIRED") {
    if (!input.startTime)
      errors.push({
        field: "startTime",
        code: "REQUIRED",
        message: "startTime is required",
      })
    if (!input.endTime)
      errors.push({
        field: "endTime",
        code: "REQUIRED",
        message: "endTime is required",
      })
  }
  for (const [field, value] of [
    ["startTime", input.startTime],
    ["endTime", input.endTime],
  ] as const) {
    if (value && !LOCAL_TIME.test(value)) {
      errors.push({
        field,
        code: "INVALID_FORMAT",
        message: "must be a time (HH:mm)",
      })
    }
  }
  if (input.startTime && input.endTime && input.endTime <= input.startTime) {
    errors.push({
      field: "endTime",
      code: "OUT_OF_RANGE",
      message: "endTime must be after startTime",
    })
  }
  if (definition.reason === "REQUIRED" && !input.reason?.trim()) {
    errors.push({
      field: "reason",
      code: "REQUIRED",
      message: "a reason is required",
    })
  }
  return errors
}

/**
 * Submits a request: PENDING at once (no drafts), with the type's on-submit
 * effect. An Admin may submit for an employee, optionally already approved
 * (then on-approve runs too).
 */
export async function submitRequest(
  input: { auth: AuthContext; request: SubmitInput },
  deps: Deps
): Promise<RequestRecord> {
  const { auth, request } = input
  const definition = requireType(request.type)
  const requesterId = request.employeeId ?? auth.userId
  const onBehalf = requesterId !== auth.userId
  if ((onBehalf || request.approved) && auth.role !== "ADMIN") {
    throw apiErrors.forbidden("Only an Admin can submit for someone else")
  }
  if (request.approved && !onBehalf) {
    throw apiErrors.fieldError(
      "approved",
      "INVALID_FORMAT",
      "only for a request on someone else's behalf"
    )
  }
  if (onBehalf) await authorize(auth, "requests", "view", requesterId)

  const errors = checkShape(definition, request)
  const parsed = definition.data.safeParse(request.data ?? {})
  if (!parsed.success) {
    errors.push(
      ...toFieldErrors(parsed.error.issues, "data", request.data ?? {}).map(
        (e) => ({
          ...e,
          field: e.field === "data" ? "data" : `data.${e.field}`,
        })
      )
    )
  }
  if (errors.length) throw apiErrors.validationFailed(errors)

  const today = await companyToday(auth.companyId, deps)
  const actor: HistoryActor = { type: "USER", userId: auth.userId }
  const draft: RequestRecord = {
    id: "",
    companyId: auth.companyId,
    type: definition.key,
    requesterId,
    startDate: request.startDate,
    endDate: request.endDate ?? request.startDate,
    startTime: request.startTime ?? null,
    endTime: request.endTime ?? null,
    reason: request.reason?.trim() || null,
    data: parsed.data!,
    status: request.approved ? "APPROVED" : "PENDING",
  }
  await definition.validate?.({
    request: draft,
    actor,
    today,
    deps,
    data: parsed.data!,
  })

  const record = await withTransaction(async () => {
    const [created] = await RequestModel.create([
      {
        companyId: auth.companyId,
        type: draft.type,
        requesterId,
        startDate: draft.startDate,
        endDate: draft.endDate,
        startTime: draft.startTime,
        endTime: draft.endTime,
        reason: draft.reason,
        data: draft.data,
        status: draft.status,
        createdBy: auth.userId,
        ...(request.approved
          ? { decidedBy: auth.userId, decidedAt: deps.clock.now() }
          : {}),
      },
    ])
    const saved = { ...draft, id: created!._id }
    const ctx = { request: saved, actor, today, deps }
    await definition.onSubmit?.(ctx)
    if (request.approved) await definition.onApprove?.(ctx)
    await recordHistory(
      {
        companyId: auth.companyId,
        action: "request.statusChanged",
        entityId: saved.id,
        subjectEmployeeId: requesterId,
        actor,
        before: {},
        after: {
          status: saved.status,
          type: saved.type,
          startDate: saved.startDate,
          endDate: saved.endDate,
          ...(onBehalf ? { submittedBy: auth.userId } : {}),
        },
      },
      deps
    )
    return saved
  })
  await publishLater(deps, "request.submitted", record, actor)
  if (request.approved)
    await publishLater(deps, "request.approved", record, actor)
  return record
}

// ─────────────────────────────── reading ───────────────────────────────

export type RequestAction =
  | "APPROVE"
  | "REJECT"
  | "WITHDRAW"
  | "REQUEST_CANCELLATION"
  | "APPROVE_CANCELLATION"
  | "DECLINE_CANCELLATION"
  | "CANCEL"

/** What the caller may do with the request now (for buttons; the server checks again). */
async function actionsFor(
  auth: AuthContext,
  doc: RequestDoc,
  today: PlainDate
): Promise<RequestAction[]> {
  const definition = getRequestType(doc.type)
  const actions: RequestAction[] = []
  const own = doc.requesterId === auth.userId
  const right = definition
    ? await decisionRight(auth, toRecord(doc), definition)
    : null
  if (doc.status === "PENDING") {
    if (right) actions.push("APPROVE", "REJECT")
    if (own) actions.push("WITHDRAW")
  }
  if (doc.status === "APPROVED" && own && doc.startDate! > today) {
    actions.push("REQUEST_CANCELLATION")
  }
  if (doc.status === "CANCELLATION_REQUESTED" && right) {
    actions.push("APPROVE_CANCELLATION", "DECLINE_CANCELLATION")
  }
  if (
    IN_EFFECT.includes(doc.status as RequestStatus) &&
    auth.role === "ADMIN"
  ) {
    actions.push("CANCEL")
  }
  return actions
}

async function toViews(auth: AuthContext, docs: RequestDoc[], deps: Deps) {
  const ids = new Set<string>()
  for (const d of docs) {
    for (const id of [d.requesterId, d.createdBy, d.decidedBy, d.cancelledBy])
      if (id) ids.add(id)
  }
  const [names, today] = await Promise.all([
    getEmployeeNames({ companyId: auth.companyId, ids: [...ids] }),
    companyToday(auth.companyId, deps),
  ])
  const person = (id: string | null | undefined) =>
    id ? { id, name: names.get(id) ?? null } : null
  return Promise.all(
    docs.map(async (d) => {
      const definition = getRequestType(d.type)
      return {
        id: d._id,
        type: d.type,
        typeLabel: definition?.label ?? d.type,
        requester: person(d.requesterId)!,
        startDate: d.startDate!,
        endDate: d.endDate!,
        startTime: d.startTime ?? null,
        endTime: d.endTime ?? null,
        reason: d.reason ?? null,
        data: (d.data ?? {}) as Record<string, unknown>,
        status: d.status as RequestStatus,
        approverPolicy: definition?.approverPolicy ?? null,
        createdBy: person(d.createdBy)!,
        createdAt: d.createdAt?.toISOString() ?? null,
        decision: d.decidedBy
          ? {
              by: person(d.decidedBy)!,
              at: d.decidedAt?.toISOString() ?? null,
              comment: d.decisionComment ?? null,
              selfApproved: Boolean(d.selfApproved),
            }
          : null,
        cancellation:
          d.cancellationRequestedAt || d.cancelledAt
            ? {
                requestedAt: d.cancellationRequestedAt?.toISOString() ?? null,
                reason: d.cancellationReason ?? null,
                cancelledBy: person(d.cancelledBy),
                cancelledAt: d.cancelledAt?.toISOString() ?? null,
              }
            : null,
        actions: await actionsFor(auth, d, today),
      }
    })
  )
}

export type RequestView = Awaited<ReturnType<typeof toViews>>[number]

/** One request with its approval timeline (from history, BE-04). */
export async function getRequestDetail(
  auth: AuthContext,
  id: string,
  deps: Deps
) {
  const doc = await loadVisible(auth, id)
  const [view] = await toViews(auth, [doc], deps)
  const entries = await listHistoryEntries({
    companyId: auth.companyId,
    entityType: "REQUEST",
    entityId: id,
  })
  const names = await getEmployeeNames({
    companyId: auth.companyId,
    ids: [...new Set(entries.flatMap((e) => (e.actorId ? [e.actorId] : [])))],
  })
  return {
    ...view!,
    timeline: entries.map((e) => ({
      status: (e.newValues.status ?? null) as RequestStatus | null,
      previousStatus: (e.oldValues.status ?? null) as RequestStatus | null,
      actor: e.actorId
        ? {
            type: "USER" as const,
            id: e.actorId,
            name: names.get(e.actorId) ?? null,
          }
        : { type: "SYSTEM" as const, job: e.systemJob },
      source: e.source,
      reason: e.reason,
      at: e.at.toISOString(),
    })),
  }
}

export type ListFilters = {
  types?: string[]
  statuses?: RequestStatus[]
  employeeId?: string
  /** requests overlapping from…to */
  from?: PlainDate
  to?: PlainDate
}

function filterQuery(companyId: string, filters: ListFilters) {
  return {
    companyId,
    ...(filters.types ? { type: { $in: filters.types } } : {}),
    ...(filters.statuses ? { status: { $in: filters.statuses } } : {}),
    ...(filters.to ? { startDate: { $lte: filters.to } } : {}),
    ...(filters.from ? { endDate: { $gte: filters.from } } : {}),
  } as Record<string, unknown>
}

type Page = { skip: number; limit: number; mongoSort: Record<string, 1 | -1> }

async function pageOf(
  auth: AuthContext,
  query: Record<string, unknown>,
  page: Page,
  deps: Deps
) {
  const [docs, total] = await Promise.all([
    RequestModel.find(query)
      .sort(page.mongoSort)
      .skip(page.skip)
      .limit(page.limit)
      .lean(),
    RequestModel.countDocuments(query),
  ])
  return { items: await toViews(auth, docs as RequestDoc[], deps), total }
}

/** The caller's own requests. */
export async function listMyRequests(
  auth: AuthContext,
  filters: ListFilters,
  page: Page,
  deps: Deps
) {
  return pageOf(
    auth,
    { ...filterQuery(auth.companyId, filters), requesterId: auth.userId },
    page,
    deps
  )
}

/**
 * Requests the caller decides (by default PENDING and CANCELLATION_REQUESTED):
 * a Manager's direct reports (Admin-only types excluded); every employee for
 * an Admin (their own only when they are the company's only Admin).
 */
export async function listApprovals(
  auth: AuthContext,
  filters: ListFilters,
  page: Page,
  deps: Deps
) {
  const query = filterQuery(auth.companyId, {
    statuses: ["PENDING", "CANCELLATION_REQUESTED"],
    ...filters,
  })
  if (auth.role === "ADMIN") {
    const soleAdmin = (await countActiveAdmins(auth.companyId)) === 1
    const ids = filters.employeeId ? [filters.employeeId] : null
    query.requesterId = ids
      ? { $in: soleAdmin ? ids : ids.filter((id) => id !== auth.userId) }
      : soleAdmin
        ? { $exists: true }
        : { $ne: auth.userId }
  } else {
    const team = (await scopedEmployeeIds(
      auth,
      "requests",
      "approve"
    )) as string[]
    const ids = team.filter(
      (id) => !filters.employeeId || id === filters.employeeId
    )
    query.requesterId = { $in: ids }
    const adminOnly = listRequestTypes()
      .filter((t) => t.approverPolicy === "ADMIN_ONLY")
      .map((t) => t.key)
    if (adminOnly.length) {
      query.type = filters.types
        ? { $in: filters.types.filter((t) => !adminOnly.includes(t)) }
        : { $nin: adminOnly }
    }
  }
  return pageOf(auth, query, page, deps)
}

// ─────────────────────────────── integrations ───────────────────────────────

const overlapping = (companyId: string, from: PlainDate, to: PlainDate) => ({
  companyId,
  status: { $in: IN_EFFECT },
  startDate: { $lte: to },
  endDate: { $gte: from },
})

let integrated = false

/**
 * Connects the engine to the modules that were waiting for it, once:
 *  - attendance (BE-07): approved requests become day effects;
 *  - holidays (BE-05): approved requests on a new holiday's dates are listed;
 *  - offboarding (BE-06): pending requests are withdrawn and future approved
 *    ones cancelled, with each type's on-cancel effects.
 */
export function integrateRequestEngine(): void {
  if (integrated) return
  integrated = true

  registerDayEffectsProvider(async ({ companyId, employeeIds, from, to }) => {
    const docs = await RequestModel.find({
      ...overlapping(companyId, from, to),
      requesterId: { $in: employeeIds },
    }).lean()
    return docs.flatMap((doc) => {
      const record = toRecord(doc as RequestDoc)
      const effect = getRequestType(doc.type)?.dayEffect?.(record)
      if (!effect) return []
      const entries = []
      const start = record.startDate > from ? record.startDate : from
      const end = record.endDate < to ? record.endDate : to
      for (let date = start; date <= end; date = addDays(date, 1)) {
        entries.push({ ...effect, employeeId: record.requesterId, date })
      }
      return entries
    })
  })

  registerAffectedRequestFinder(async ({ companyId, startDate, endDate }) => {
    const docs = (
      await RequestModel.find(overlapping(companyId, startDate, endDate)).lean()
    ).filter((doc) =>
      getRequestType(doc.type)?.dayEffect?.(toRecord(doc as RequestDoc))
    )
    const names = await getEmployeeNames({
      companyId,
      ids: [...new Set(docs.map((d) => d.requesterId))],
    })
    return docs.map((d) => ({
      requestId: d._id,
      employeeId: d.requesterId,
      employeeName: names.get(d.requesterId) ?? "",
      type: d.type,
      startDate: d.startDate!,
      endDate: d.endDate!,
    }))
  })

  const item = (d: {
    _id: string
    type: string
    startDate?: string | null
    endDate?: string | null
  }) => ({
    id: d._id,
    type: d.type,
    startDate: d.startDate!,
    endDate: d.endDate!,
  })
  const offboardingDocs = async (
    companyId: string,
    employeeId: string,
    lastWorkingDay: PlainDate
  ) => {
    // One after the other: inside the offboarding transaction, two queries
    // may not start it at the same time (MongoDB refuses).
    const pending = await RequestModel.find({
      companyId,
      requesterId: employeeId,
      status: "PENDING",
    }).lean()
    const future = await RequestModel.find({
      companyId,
      requesterId: employeeId,
      status: { $in: IN_EFFECT },
      endDate: { $gt: lastWorkingDay },
    }).lean()
    return { pending, future }
  }
  registerOffboardingHook({
    async preview({ companyId, employeeId, lastWorkingDay }) {
      const { pending, future } = await offboardingDocs(
        companyId,
        employeeId,
        lastWorkingDay
      )
      return {
        pendingRequests: pending.map(item),
        futureApprovedTimeOff: future.map(item),
      }
    },
    async apply({ companyId, employeeId, lastWorkingDay, actor, deps }) {
      const { pending, future } = await offboardingDocs(
        companyId,
        employeeId,
        lastWorkingDay
      )
      for (const doc of pending) {
        const definition = getRequestType(doc.type)
        await transition(
          {
            companyId,
            id: doc._id,
            from: ["PENDING"],
            to: "WITHDRAWN",
            actor,
            reason: "employee offboarded",
            hook: (ctx) =>
              definition?.onCancel?.({ ...ctx, from: "PENDING" }) ??
              Promise.resolve(),
            event: "request.withdrawn",
          },
          deps
        )
      }
      for (const doc of future) {
        const definition = getRequestType(doc.type)
        await transition(
          {
            companyId,
            id: doc._id,
            from: IN_EFFECT,
            to: "CANCELLED",
            set: {
              cancelledAt: deps.clock.now(),
              cancellationReason: "employee offboarded",
            },
            actor,
            reason: "employee offboarded",
            hook: (ctx, before) =>
              definition?.onCancel?.({
                ...ctx,
                from: before.status as "APPROVED" | "CANCELLATION_REQUESTED",
              }) ?? Promise.resolve(),
            event: "request.cancelled",
          },
          deps
        )
      }
    },
  })
}

integrateRequestEngine()
