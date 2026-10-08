import { z } from "zod"

/**
 * List conventions for every paginated endpoint (Trello BE-00):
 *   ?page=1&pageSize=20&sort=-createdAt   →   { items, meta }
 *
 * Usage in a future list endpoint:
 *   const query = listQuery({ sortFields: ["name", "joinedOn"], defaultSort: "name" })
 *     .extend({ status: multiValue(z.enum(["ACTIVE", "INVITED"])).optional() })
 *   router.get("/employees", route({ query }, async ({ query }) => {
 *     const page = toPageRequest(query)
 *     const [items, total] = await Promise.all([
 *       Employee.find(filter).sort(page.mongoSort).skip(page.skip).limit(page.limit),
 *       Employee.countDocuments(filter),
 *     ])
 *     return { status: 200, body: toPage(items, total, page) }
 *   }))
 */

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export type PageMeta = {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
}

/** Zod schema for page, pageSize and sort. Unknown sort fields → INVALID_FORMAT on `sort`. */
export function listQuery<const F extends string>(options: {
  sortFields: readonly F[]
  defaultSort: F | `-${F}`
}) {
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE),
    sort: z
      .string()
      .default(options.defaultSort)
      .refine(
        (value) => options.sortFields.includes(value.replace(/^-/, "") as F),
        {
          message: `sort must be one of ${options.sortFields.join(", ")} (prefix "-" for descending)`,
        }
      ),
  })
}

/** `?status=A&status=B` and `?status=A` both become ["A", "B"] / ["A"]. */
export function multiValue<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (value) => (value === undefined ? undefined : [value].flat()),
    z.array(item)
  )
}

export type PageRequest = {
  page: number
  pageSize: number
  skip: number
  limit: number
  sort: { field: string; direction: "asc" | "desc" }
  /** Ready for Mongoose .sort(); _id breaks ties so pages are stable. */
  mongoSort: Record<string, 1 | -1>
}

export function toPageRequest(query: {
  page: number
  pageSize: number
  sort: string
}): PageRequest {
  const descending = query.sort.startsWith("-")
  const field = descending ? query.sort.slice(1) : query.sort
  return {
    page: query.page,
    pageSize: query.pageSize,
    skip: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
    sort: { field, direction: descending ? "desc" : "asc" },
    mongoSort: { [field]: descending ? -1 : 1, _id: 1 },
  }
}

export function toPage<T>(
  items: T[],
  totalItems: number,
  request: Pick<PageRequest, "page" | "pageSize">
): { items: T[]; meta: PageMeta } {
  return {
    items,
    meta: {
      page: request.page,
      pageSize: request.pageSize,
      totalItems,
      totalPages: Math.max(Math.ceil(totalItems / request.pageSize), 1),
    },
  }
}
