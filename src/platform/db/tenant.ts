import type { Query, Schema } from "mongoose"

/**
 * Central tenant isolation (BE-02). Every tenant-owned model declares
 * `companyId: tenantIdField()` and uses `schema.plugin(tenantScoped)`, which
 * makes every query (find, count, update, delete…) and aggregate THROW
 * unless its filter names `companyId`.
 *
 * A query that forgets the tenant fails loudly in development and tests
 * instead of silently reading another company's data. The company always
 * comes from the authenticated session (req.auth.companyId), never from the
 * request body or URL.
 *
 * The only escape hatch is withoutTenantScope(query), for the few lookups
 * that happen before a tenant is known (login by email, token lookups).
 * Every use must say why in a comment.
 */
export class TenantScopeError extends Error {
  override readonly name = "TenantScopeError"
}

const SKIP = Symbol("skipTenantScope")

/** Explicitly run one query across all companies. Use only before a tenant is known. */
export function withoutTenantScope<Q extends Query<unknown, unknown>>(
  query: Q
): Q {
  ;(query as unknown as Record<symbol, boolean>)[SKIP] = true
  return query
}

/** Every query operation that reads or writes existing documents. */
const QUERY_OPS =
  /^(find|findOne|countDocuments|distinct|findOneAndUpdate|findOneAndDelete|findOneAndReplace|updateOne|updateMany|replaceOne|deleteOne|deleteMany)$/

/** The tenant field every tenant-owned model declares (typed, required, indexed). */
export const tenantIdField = () => ({
  type: String,
  required: true as const,
  index: true,
})

export function tenantScoped(schema: Schema): void {
  if (!schema.path("companyId")) {
    throw new Error(
      "tenantScoped models must declare companyId: tenantIdField()"
    )
  }

  schema.pre<Query<unknown, unknown>>(QUERY_OPS, function () {
    if ((this as unknown as Record<symbol, boolean>)[SKIP]) return
    if (this.getFilter().companyId === undefined) {
      const op = (this as unknown as { op?: string }).op
      throw new TenantScopeError(
        `${this.model.modelName}.${op} without companyId: every query on tenant data must be scoped to a company`
      )
    }
  })

  schema.pre("aggregate", function () {
    const first = this.pipeline()[0] as
      { $match?: Record<string, unknown> } | undefined
    if (first?.$match?.companyId === undefined) {
      throw new TenantScopeError(
        "aggregate on tenant data must start with { $match: { companyId } }"
      )
    }
  })
}
