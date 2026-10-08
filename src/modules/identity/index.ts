import type { AppModule } from "../module.ts"

/**
 * Identity: sign-up, login, sessions, invitations, passwords, current user, roles and data scopes.
 * No endpoints yet (BE-01 is foundation only). BE-02 and BE-03 will add a router here.
 */
export const identityModule: AppModule = {
  name: "identity",
  routes: () => undefined,
}
