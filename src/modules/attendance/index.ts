import type { AppModule } from "../module.ts"

/**
 * Attendance: check-in/out, daily status, history and corrections.
 * No endpoints yet (BE-01 is foundation only). BE-07 will add a router here.
 */
export const attendanceModule: AppModule = {
  name: "attendance",
  routes: () => undefined,
}
