import type { AuthContext } from "../modules/identity/authenticate.ts"
import type { Logger } from "../platform/logging/logger.ts"

declare global {
  namespace Express {
    interface Request {
      /** Request ID: the caller's X-Request-Id when safe, otherwise a UUID. */
      id: string
      /** Logger whose lines all carry this request's ID (and user/company once authenticated). */
      log: Logger
      /** The authenticated caller; set by requireAuth (read it with getAuth(req)). */
      auth?: AuthContext
    }
  }
}

export {}
