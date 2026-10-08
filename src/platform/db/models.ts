/**
 * Every Mongoose model, imported once so they are registered before
 * migrations sync their indexes. A ticket that adds a model adds one line here.
 */
export { CompanyModel } from "../../modules/organization/company.model.ts"
