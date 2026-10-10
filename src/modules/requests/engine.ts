import { withTransaction } from "../../platform/db/connection.ts"
import { apiErrors, type FieldError } from "../../platform/http/errors.ts"
import { toFieldErrors } from "../../platform/http/validation.ts"
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
import {
  getCompanySettings,
  registerAffectedRequestFinder,
} from "../organization/settings.service.ts"
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
 * one transaction.
 */
export type Deps = { clock: Clock }

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
  submittedAt?: Date | null
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
  const { disabledRequestTypes } = await getCompanySettings(
    auth.companyId,
    deps
  )
  if (disabledRequestTypes.includes(definition.key)) {
    throw apiErrors.conflictWith(
      "REQUEST_TYPE_DISABLED",
      `${definition.label} requests are turned off for this company`
    )
  }
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
        submittedAt: deps.clock.now(),
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
        submittedAt: (d.submittedAt ?? d.createdAt)?.toISOString() ?? null,
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
 * Requests overlapping a date range (for type rules such as "no overlapping
 * leave"), optionally of one requester, some types and some statuses.
 */
export async function findOverlappingRequests(input: {
  companyId: string
  from: PlainDate
  to: PlainDate
  requesterId?: string
  types?: string[]
  statuses: RequestStatus[]
  excludeId?: string
}): Promise<RequestRecord[]> {
  const docs = await RequestModel.find({
    companyId: input.companyId,
    status: { $in: input.statuses },
    startDate: { $lte: input.to },
    endDate: { $gte: input.from },
    ...(input.requesterId ? { requesterId: input.requesterId } : {}),
    ...(input.types ? { type: { $in: input.types } } : {}),
    ...(input.excludeId ? { _id: { $ne: input.excludeId } } : {}),
  })
    .sort({ startDate: 1 })
    .lean()
  return docs.map((doc) => toRecord(doc as RequestDoc))
}

export type ReportRequest = RequestRecord & {
  submittedAt: Date | null
  decidedBy: string | null
  decidedAt: Date | null
  cancelledAt: Date | null
}

/**
 * Requests of some types and employees overlapping a date range, oldest
 * start first, with their decision (reports, BE-14). The caller has already
 * limited the employees to what it may see.
 */
export async function listRequestsForReport(input: {
  companyId: string
  types: string[]
  requesterIds: string[]
  from: PlainDate
  to: PlainDate
  statuses?: RequestStatus[]
  /** LEAVE only: data.leaveTypeId among these */
  leaveTypeIds?: string[]
}): Promise<ReportRequest[]> {
  const docs = await RequestModel.find({
    companyId: input.companyId,
    type: { $in: input.types },
    requesterId: { $in: input.requesterIds },
    startDate: { $lte: input.to },
    endDate: { $gte: input.from },
    ...(input.statuses ? { status: { $in: input.statuses } } : {}),
    ...(input.leaveTypeIds
      ? { "data.leaveTypeId": { $in: input.leaveTypeIds } }
      : {}),
  })
    .sort({ startDate: 1, _id: 1 })
    .lean()
  return docs.map((doc) => ({
    ...toRecord(doc as RequestDoc),
    submittedAt: doc.submittedAt ?? doc.createdAt ?? null,
    decidedBy: doc.decidedBy ?? null,
    decidedAt: doc.decidedAt ?? null,
    cancelledAt: doc.cancelledAt ?? null,
  }))
}

/** One employee's requests, for whoever may see them (self, their manager, Admins). */
export async function listRequestsOf(
  auth: AuthContext,
  employeeId: string,
  filters: ListFilters,
  page: Page,
  deps: Deps
) {
  await authorize(auth, "requests", "view", employeeId)
  return pageOf(
    auth,
    { ...filterQuery(auth.companyId, filters), requesterId: employeeId },
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
      const definition = getRequestType(doc.type)
      if (!definition?.dayEffect) return []
      const entries = []
      const start = record.startDate > from ? record.startDate : from
      const end = record.endDate < to ? record.endDate : to
      for (let date = start; date <= end; date = addDays(date, 1)) {
        const effect = definition.dayEffect(record, date)
        if (effect)
          entries.push({ ...effect, employeeId: record.requesterId, date })
      }
      return entries
    })
  })

  registerAffectedRequestFinder(async ({ companyId, startDate, endDate }) => {
    const docs = (
      await RequestModel.find(overlapping(companyId, startDate, endDate)).lean()
    ).filter((doc) =>
      // Requests that affect attendance (leave, WFH, trips…)
      Boolean(getRequestType(doc.type)?.dayEffect)
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
          },
          deps
        )
      }
    },
  })
}

integrateRequestEngine()

/**
 * The registered types for the company: those it turned off are left out,
 * unless `includeDisabled` (Admins, for the settings screen).
 */
export async function companyRequestTypes(
  companyId: string,
  options: { includeDisabled: boolean },
  deps: Deps
) {
  const { disabledRequestTypes } = await getCompanySettings(companyId, deps)
  return listRequestTypes()
    .map((t) => ({
      definition: t,
      enabled: !disabledRequestTypes.includes(t.key),
    }))
    .filter((t) => t.enabled || options.includeDisabled)
}

/** How long a pending request may wait before it is flagged on dashboards. */
export const OVERDUE_AFTER_DAYS = 3

/** Pending requests per type: how many, how many overdue, and the oldest (BE-13). */
export async function pendingByType(companyId: string, deps: Deps) {
  const docs = (
    await RequestModel.find(
      { companyId, status: "PENDING" },
      { type: 1, createdAt: 1, submittedAt: 1 }
    ).lean()
  )
    .map((doc) => ({
      type: doc.type,
      createdAt: doc.submittedAt ?? doc.createdAt,
    }))
    .sort(
      (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
    )
  const overdueBefore =
    deps.clock.now().getTime() - OVERDUE_AFTER_DAYS * 86_400_000
  const byType = new Map<
    string,
    { count: number; overdue: number; oldest: Date | null }
  >()
  for (const doc of docs) {
    const entry = byType.get(doc.type) ?? { count: 0, overdue: 0, oldest: null }
    entry.count += 1
    if (doc.createdAt && doc.createdAt.getTime() < overdueBefore)
      entry.overdue += 1
    entry.oldest ??= doc.createdAt ?? null
    byType.set(doc.type, entry)
  }
  return [...byType.entries()].map(([type, e]) => ({
    type,
    label: getRequestType(type)?.label ?? type,
    count: e.count,
    overdue: e.overdue,
    oldestSubmittedAt: e.oldest?.toISOString() ?? null,
    oldestAgeDays: e.oldest
      ? Math.floor(
          (deps.clock.now().getTime() - e.oldest.getTime()) / 86_400_000
        )
      : null,
  }))
}
