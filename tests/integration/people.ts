import { hashPassword } from "../../src/modules/identity/passwords.ts"
import { UserModel, type Role } from "../../src/modules/identity/user.model.ts"
import {
  createEmployee,
  setReportingLine,
} from "../../src/modules/organization/organization.service.ts"
import { signupBody, type Tokens, type useApi } from "./api.ts"

export type Member = { id: string; token: string; name: string }

let counter = 0

/**
 * A signed-up company (its Admin) plus an `add(role, managerId?)` that
 * creates a signed-in member straight in the database.
 */
export async function newCompany(api: ReturnType<typeof useApi>, name: string) {
  const tokens = (
    await api.post<Tokens>(
      "/auth/signup",
      signupBody({ companyName: name, name: `${name} Admin` })
    )
  ).body
  const me = (
    await api.get<{ id: string; company: { id: string } }>(
      "/me",
      tokens.accessToken
    )
  ).body
  const companyId = me.company.id
  const admin: Member = {
    id: me.id,
    token: tokens.accessToken,
    name: `${name} Admin`,
  }

  async function add(role: Role, managerId?: string): Promise<Member> {
    counter += 1
    const email = `person${counter}.${Date.now()}@acme.example`
    const memberName = `${role} ${counter}`
    const [user] = await UserModel.create([
      {
        companyId,
        email,
        role,
        status: "ACTIVE",
        passwordHash: await hashPassword("blue-river-lantern"),
      },
    ])
    await createEmployee({ id: user!._id, companyId, name: memberName })
    if (managerId) {
      await setReportingLine(
        {
          id: user!._id,
          companyId,
          managerId,
          changedBy: { type: "SYSTEM", job: "test" },
        },
        { clock: api.clock }
      )
    }
    const login = await api.post<Tokens>("/auth/login", {
      email,
      password: "blue-river-lantern",
    })
    return { id: user!._id, token: login.body.accessToken, name: memberName }
  }

  return { companyId, admin, add }
}
