import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto"
import { promisify } from "node:util"

import type { FieldErrorCode } from "../../platform/http/errors.ts"
import { COMMON_PASSWORDS } from "./common-passwords.ts"

/**
 * Password hashing with scrypt (Node's built-in crypto; no extra library).
 * Stored as "scrypt$N$r$p$salt$hash", so the cost can be raised later without
 * breaking existing hashes.
 */
const COST = { N: 32_768, r: 8, p: 1 }
const KEY_LENGTH = 64
const MAX_MEM = 128 * 1024 * 1024

const scryptAsync = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions
) => Promise<Buffer>
const scrypt = (password: string, salt: Buffer, options: ScryptOptions) =>
  scryptAsync(password, salt, KEY_LENGTH, options)

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, { ...COST, maxmem: MAX_MEM })
  return [
    "scrypt",
    COST.N,
    COST.r,
    COST.p,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$")
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split("$")
  if (scheme !== "scrypt" || !salt || !hash) return false
  const expected = Buffer.from(hash, "base64url")
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEM,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

let dummyHash: Promise<string> | undefined
/**
 * Spends the same time as a real check, for logins with an unknown email,
 * so response times don't reveal which emails have accounts.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("timing-equaliser-password")
  await verifyPassword(password, await dummyHash)
}

export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_LENGTH = 128

/**
 * The password rule (Trello BE-02, same as the frontend's password field):
 * 10–128 characters, not a common password, and not containing the person's
 * name or the local part of their email (3+ character parts; never the domain). Returns the field error code, or undefined when it passes.
 * Length is also checked by the Zod schemas; this is the full rule for the
 * service layer.
 */
export function passwordProblem(
  password: string,
  person: { name?: string; email?: string }
): FieldErrorCode | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) return "TOO_SHORT"
  if (password.length > PASSWORD_MAX_LENGTH) return "TOO_LONG"

  const lower = password.toLowerCase()
  if (COMMON_PASSWORDS.has(lower)) return "TOO_COMMON"

  // The email's local part (before @) and each word of it ("sara.harbi" →
  // sara.harbi, sara, harbi), and each word of the name. Only parts of 3+
  // characters count, and the domain never does ("gmail", "com" are fine).
  const words = (text: string) => text.split(/[^\p{L}\p{N}]+/u)
  const personal: string[] = []
  if (person.email) {
    const local = person.email.toLowerCase().split("@")[0] ?? ""
    personal.push(local, ...words(local))
  }
  if (person.name) personal.push(...words(person.name.toLowerCase()))
  if (personal.some((part) => part.length >= 3 && lower.includes(part))) {
    return "CONTAINS_PERSONAL_INFO"
  }
  return undefined
}
