import type { AppModule } from "../module.ts"

/**
 * Organization: the company (tenant), settings, holidays, uploads, departments and employees. The Company model lives here (company.model.ts).
 * No endpoints yet (BE-01 is foundation only). BE-05 and BE-06 will add a router here.
 */
export const organizationModule: AppModule = {
  name: "organization",
  routes: () => undefined,
}
