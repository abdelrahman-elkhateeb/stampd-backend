import { model, Schema, type InferSchemaType } from "mongoose"

import {
  baseSchemaOptions,
  plainDateField,
  uuidId,
} from "../../platform/db/schema.ts"
import { tenantIdField, tenantScoped } from "../../platform/db/tenant.ts"

/**
 * One employee request of any type (Trello BE-09): leave, WFH, permission,
 * business trip, attendance correction… The engine owns the lifecycle; each
 * type's own fields live in `data`, validated by the type's definition.
 *
 * No draft state: a request is PENDING from the moment it is submitted, and
 * never edited afterwards (withdraw and resubmit instead).
 *
 *   PENDING → APPROVED | REJECTED | WITHDRAWN
 *   APPROVED → CANCELLATION_REQUESTED → CANCELLED | (declined) APPROVED
 *   APPROVED / CANCELLATION_REQUESTED → CANCELLED (an Admin, with a reason)
 */
export const REQUEST_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
  "CANCELLATION_REQUESTED",
  "CANCELLED",
] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

const requestSchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    /** The registered type's key, e.g. "LEAVE", "WFH" */
    type: { type: String, required: true },
    requesterId: { type: String, required: true },
    startDate: plainDateField({ required: true }),
    endDate: plainDateField({ required: true }),
    /** "HH:mm" in company time, for types with times (e.g. a permission) */
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
    reason: { type: String, default: null },
    /** The type's own fields */
    data: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: REQUEST_STATUSES, required: true },
    /** Who submitted it: the requester, or an Admin on their behalf */
    createdBy: { type: String, required: true },
    /** When it was submitted (the app's clock; ages and "overdue" use it) */
    submittedAt: { type: Date, default: null },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    /** Rejection reason, or an optional comment on approval */
    decisionComment: { type: String, default: null },
    /** The company's only Admin approved their own request */
    selfApproved: { type: Boolean, default: false },
    cancellationRequestedAt: { type: Date, default: null },
    cancellationReason: { type: String, default: null },
    cancelledBy: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { ...baseSchemaOptions, minimize: false }
)
requestSchema.index({ companyId: 1, requesterId: 1, startDate: -1 })
requestSchema.index({ companyId: 1, status: 1, startDate: -1 })
requestSchema.plugin(tenantScoped)

export type Request = InferSchemaType<typeof requestSchema>
export const RequestModel = model("Request", requestSchema)
