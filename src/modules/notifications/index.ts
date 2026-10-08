import type { AppModule } from "../module.ts"

/**
 * Notifications: in-app feed and email from domain events.
 * No endpoints yet (BE-01 is foundation only). BE-15 will add a router here.
 */
export const notificationsModule: AppModule = {
  name: "notifications",
  routes: () => undefined,
}
