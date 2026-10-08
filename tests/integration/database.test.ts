import mongoose, { model, Schema } from "mongoose"
import { describe, expect, it } from "vitest"

import { CompanyModel } from "../../src/modules/organization/company.model.ts"
import { pingDatabase } from "../../src/platform/db/connection.ts"
import {
  runMigrations,
  type Migration,
} from "../../src/platform/db/migrations.ts"
import {
  baseSchemaOptions,
  plainDateField,
  uuidId,
} from "../../src/platform/db/schema.ts"
import { DEMO_COMPANY, seedDemoData } from "../../src/platform/db/seed.ts"
import { useTestDatabase } from "./database.ts"

useTestDatabase()

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A model used only here, to prove the column conventions on a real server. */
const ProbeModel = model(
  "Probe",
  new Schema(
    {
      _id: uuidId(),
      day: plainDateField({ required: true }),
      at: { type: Date, required: true },
    },
    baseSchemaOptions
  )
)

describe("connection", () => {
  it("answers the health ping", async () => {
    expect(await pingDatabase()).toBe(true)
  })

  it("runs as a replica set, so transactions work (and roll back)", async () => {
    const session = await mongoose.startSession()
    await expect(
      session.withTransaction(async () => {
        await CompanyModel.create([{ name: "Rolled back", timezone: "UTC" }], {
          session,
        })
        throw new Error("abort")
      })
    ).rejects.toThrow("abort")
    await session.endSession()
    expect(await CompanyModel.countDocuments({ name: "Rolled back" })).toBe(0)
  })

  it("refuses queries on fields the schema doesn't have", async () => {
    await expect(CompanyModel.find({ companyIdTypo: "x" })).rejects.toThrow(
      /strictQuery/i
    )
  })
})

describe("migrations", () => {
  it("created the indexes declared on the models", async () => {
    const indexes = await CompanyModel.collection.indexes()
    expect(indexes.map((i) => i.name)).toContain("_id_")
  })

  it("applies each data migration once, in order, and records it", async () => {
    const ran: string[] = []
    const migrations: Migration[] = [
      { id: "t-001", up: async () => void ran.push("t-001") },
      { id: "t-002", up: async () => void ran.push("t-002") },
    ]
    const first = await runMigrations(mongoose.connection, migrations)
    const second = await runMigrations(mongoose.connection, migrations)
    expect(first.applied).toEqual(["t-001", "t-002"])
    expect(second.applied).toEqual([])
    expect(ran).toEqual(["t-001", "t-002"])
    expect(first.indexedModels).toContain("Company")
    const recorded = await mongoose.connection
      .collection("migrations")
      .find()
      .toArray()
    expect(recorded.map((r) => r._id)).toEqual(
      expect.arrayContaining(["t-001", "t-002"])
    )
  })

  it("rejects duplicate migration ids", async () => {
    const twice: Migration = { id: "dup", up: async () => {} }
    await expect(
      runMigrations(mongoose.connection, [twice, twice])
    ).rejects.toThrow(/unique/)
  })
})

describe("seed", () => {
  it("created the demo company", async () => {
    const company = await CompanyModel.findById(DEMO_COMPANY._id).lean()
    expect(company).toMatchObject(DEMO_COMPANY)
    expect(company?.createdAt).toBeInstanceOf(Date)
  })

  it("is idempotent", async () => {
    await seedDemoData()
    await seedDemoData()
    expect(await CompanyModel.countDocuments({ _id: DEMO_COMPANY._id })).toBe(1)
  })
})

describe("conventions", () => {
  it("gives new documents random, non-sequential UUID string ids", async () => {
    const [a, b] = await CompanyModel.create([
      { name: "Tenant A", timezone: "Asia/Dubai" },
      { name: "Tenant B", timezone: "Asia/Dubai" },
    ])
    expect(a!._id).toMatch(UUID_V4)
    expect(b!._id).toMatch(UUID_V4)
    expect(a!._id).not.toBe(b!._id)
    const raw = await CompanyModel.collection.findOne({ _id: a!._id as never })
    expect(typeof raw?._id).toBe("string")
  })

  it("stores calendar days as YYYY-MM-DD strings and instants as UTC dates", async () => {
    const doc = await ProbeModel.create({
      day: "2026-10-07",
      at: new Date("2026-10-07T05:02:00.000Z"),
    })
    const types = await ProbeModel.collection
      .aggregate([
        { $match: { _id: doc._id } },
        {
          $project: {
            day: { $type: "$day" },
            at: { $type: "$at" },
            createdAt: { $type: "$createdAt" },
          },
        },
      ])
      .toArray()
    expect(types[0]).toMatchObject({
      day: "string",
      at: "date",
      createdAt: "date",
    })

    const read = await ProbeModel.findById(doc._id).lean()
    expect(read?.day).toBe("2026-10-07")
    expect(read?.at.toISOString()).toBe("2026-10-07T05:02:00.000Z")
  })

  it("rejects calendar days that don't exist", async () => {
    await expect(
      ProbeModel.create({ day: "2026-02-30", at: new Date() })
    ).rejects.toThrow(/YYYY-MM-DD/)
  })

  it("rejects unknown timezones on a company", async () => {
    await expect(
      CompanyModel.create({ name: "Bad", timezone: "Mars/Olympus" })
    ).rejects.toThrow(/IANA/)
  })

  it("serialises documents with `id`, without `_id` or `__v`", async () => {
    const json = (await CompanyModel.findById(
      DEMO_COMPANY._id
    ))!.toJSON() as Record<string, unknown>
    expect(json.id).toBe(DEMO_COMPANY._id)
    expect(json).not.toHaveProperty("_id")
    expect(json).not.toHaveProperty("__v")
  })
})
