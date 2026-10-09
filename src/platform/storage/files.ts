import { createHmac, timingSafeEqual } from "node:crypto"
import type { Request } from "express"
import { model, Schema } from "mongoose"

import { uuidId } from "../db/schema.ts"
import {
  tenantIdField,
  tenantScoped,
  withoutTenantScope,
} from "../db/tenant.ts"
import { apiErrors } from "../http/errors.ts"

/**
 * Uploaded images (Trello BE-05: company logo, employee photos).
 *
 * Stored in MongoDB, one document per file, scoped by company like every
 * other tenant record. Images are at most 2 MB, well under MongoDB's 16 MB
 * document limit, and this keeps the stack to Express + MongoDB (no object
 * storage SDK). Only the functions below touch the bytes, so moving to
 * object storage later changes this file only.
 *
 * Files are served by GET /files/{id} with a signed, expiring URL (see
 * signedFileUrl), so an <img src> works without a login token, and a file id
 * alone (or one from another company) gives 404.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

const storedFileSchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    /** What the file is for, e.g. "company-logo", "employee-photo" */
    purpose: { type: String, required: true },
    contentType: { type: String, enum: IMAGE_TYPES, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },
    uploadedBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false }
)
storedFileSchema.plugin(tenantScoped)

export const StoredFileModel = model("StoredFile", storedFileSchema)

/**
 * The image type from the file's first bytes (its "magic number"), never
 * from the client's Content-Type header or file name. SVG is not accepted
 * (decision 2026-10-09).
 */
export function detectImageType(bytes: Buffer): ImageType | undefined {
  const starts = (signature: number[], offset = 0) =>
    signature.every((byte, i) => bytes[offset + i] === byte)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png"
  }
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg"
  if (
    starts([0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    starts([0x57, 0x45, 0x42, 0x50], 8) // "WEBP"
  ) {
    return "image/webp"
  }
  return undefined
}

const tooLarge = () =>
  apiErrors.fieldError(
    "file",
    "FILE_TOO_LARGE",
    `file must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`
  )

/**
 * Reads an image sent as the raw request body (Content-Type image/png,
 * image/jpeg or image/webp; no multipart). 422 on field "file":
 * REQUIRED (empty), FILE_TOO_LARGE (over 2 MB), UNSUPPORTED_FILE_TYPE (not a
 * PNG, JPEG or WebP by content).
 */
export async function readImageUpload(
  req: Request
): Promise<{ bytes: Buffer; contentType: ImageType }> {
  const declared = Number(req.headers["content-length"])
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    req.resume() // discard the body; the 422 still goes out
    throw tooLarge()
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_IMAGE_BYTES) {
      req.resume()
      throw tooLarge()
    }
    chunks.push(chunk)
  }
  if (size === 0) {
    throw apiErrors.fieldError("file", "REQUIRED", "file is required")
  }
  const bytes = Buffer.concat(chunks)
  const contentType = detectImageType(bytes)
  if (!contentType) {
    throw apiErrors.fieldError(
      "file",
      "UNSUPPORTED_FILE_TYPE",
      "file must be a PNG, JPEG or WebP image"
    )
  }
  return { bytes, contentType }
}

export async function saveFile(input: {
  companyId: string
  purpose: string
  contentType: ImageType
  bytes: Buffer
  uploadedBy: string
}): Promise<string> {
  const [file] = await StoredFileModel.create([
    {
      companyId: input.companyId,
      purpose: input.purpose,
      contentType: input.contentType,
      size: input.bytes.length,
      data: input.bytes,
      uploadedBy: input.uploadedBy,
    },
  ])
  return file!._id
}

export async function deleteFile(input: {
  id: string
  companyId: string
}): Promise<void> {
  await StoredFileModel.deleteOne({ _id: input.id, companyId: input.companyId })
}

// ───────────────────────────── signed URLs ─────────────────────────────

/** URLs stay valid at least 24 hours (and change at most once an hour, so browsers can cache). */
const URL_LIFETIME_S = 24 * 3600
const URL_STEP_S = 3600

function signature(secret: string, fileId: string, expires: number): string {
  return createHmac("sha256", secret)
    .update(`file:${fileId}:${expires}`)
    .digest("base64url")
}

/** A path like /files/{id}?expires=…&signature=…, relative to the API's base URL. */
export function signedFileUrl(
  fileId: string,
  deps: { secret: string; now: Date }
): string {
  const now = Math.floor(deps.now.getTime() / 1000)
  const expires = Math.ceil((now + URL_LIFETIME_S) / URL_STEP_S) * URL_STEP_S
  return `/files/${fileId}?expires=${expires}&signature=${signature(deps.secret, fileId, expires)}`
}

export function isValidFileSignature(
  input: { fileId: string; expires: number; signature: string },
  deps: { secret: string; now: Date }
): boolean {
  if (input.expires * 1000 <= deps.now.getTime()) return false
  const expected = Buffer.from(
    signature(deps.secret, input.fileId, input.expires)
  )
  const given = Buffer.from(input.signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/**
 * A file for GET /files/{id}, after isValidFileSignature() passed. Signed
 * URLs are opened by <img> tags without a login, so there is no company to
 * scope by: the signature, which only the API issues and only to people who
 * may see the file, is what authorizes this one cross-tenant lookup.
 */
export async function loadSignedFile(
  fileId: string
): Promise<{ contentType: ImageType; bytes: Buffer } | undefined> {
  const file = await withoutTenantScope(
    StoredFileModel.findOne({ _id: fileId }, { contentType: 1, data: 1 })
  )
  if (!file) return undefined
  return { contentType: file.contentType as ImageType, bytes: file.data }
}
