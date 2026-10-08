import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

/**
 * Session tokens (decisions on Trello BE-02, 2026-10-09):
 *  - access token: 15 minutes, a standard JWT (HS256) sent as
 *    "Authorization: Bearer …". Signed with AUTH_TOKEN_SECRET; built with
 *    Node's crypto (no extra library).
 *  - refresh token: 30 days, opaque random string, rotated on every refresh,
 *    stored in MongoDB only as a SHA-256 hash.
 *  - grace window: for 20 s after a rotation, presenting the previous refresh
 *    token returns the SAME new pair (parallel refreshes from several
 *    frontend servers). Later reuse revokes the whole token family.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const REFRESH_GRACE_MS = 20 * 1000

export type AccessClaims = {
  /** user id (= employee id) */
  sub: string
  /** company id: the tenant */
  cid: string
  /** session id: the refresh-token family */
  sid: string
  /** issued at / expires at, in seconds since the epoch */
  iat: number
  exp: number
}

const b64url = (data: Buffer | string) =>
  Buffer.from(data).toString("base64url")
const HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))

function sign(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url")
}

/** Deterministic: the same claims and secret always give the same token. */
export function signAccessToken(claims: AccessClaims, secret: string): string {
  const body = `${HEADER}.${b64url(JSON.stringify(claims))}`
  return `${body}.${sign(body, secret)}`
}

/** Returns the claims of a valid, unexpired token signed with this secret, else undefined. */
export function verifyAccessToken(
  token: string,
  secret: string,
  now: Date
): AccessClaims | undefined {
  const [header, payload, signature] = token.split(".")
  if (header !== HEADER || !payload || !signature) return undefined

  const expected = Buffer.from(sign(`${header}.${payload}`, secret))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return undefined
  }

  let claims: AccessClaims
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
  const valid =
    typeof claims.sub === "string" &&
    typeof claims.cid === "string" &&
    typeof claims.sid === "string" &&
    typeof claims.exp === "number"
  if (!valid || claims.exp * 1000 <= now.getTime()) return undefined
  return claims
}

/** A new random refresh token (also used for invite and reset links). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url")
}

/** What MongoDB stores instead of the token itself. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * The refresh token that replaces `previous`, derived from it with the secret.
 * Re-running it during the grace window gives the identical token, so nothing
 * secret has to be stored to "return the same new pair".
 */
export function rotatedRefreshToken(
  previous: string,
  nextTokenId: string,
  secret: string
): string {
  return createHmac("sha256", secret)
    .update(`refresh-rotation:${nextTokenId}:${previous}`)
    .digest("base64url")
}
