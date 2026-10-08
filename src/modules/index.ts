import { attendanceModule } from "./attendance/index.ts"
import { identityModule } from "./identity/index.ts"
import { leaveModule } from "./leave/index.ts"
import type { AppModule } from "./module.ts"
import { notificationsModule } from "./notifications/index.ts"
import { organizationModule } from "./organization/index.ts"
import { reportingModule } from "./reporting/index.ts"
import { requestsModule } from "./requests/index.ts"
import { systemModule } from "./system/index.ts"

/** Every domain module, mounted in this order by app.ts. */
export const MODULES: readonly AppModule[] = [
  systemModule,
  identityModule,
  organizationModule,
  attendanceModule,
  leaveModule,
  requestsModule,
  reportingModule,
  notificationsModule,
]
