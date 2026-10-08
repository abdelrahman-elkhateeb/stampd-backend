import { MongoMemoryReplSet } from "mongodb-memory-server"
import type { TestProject } from "vitest/node"

/**
 * Integration tests run against a real MongoDB server:
 *  - by default a throwaway single-node replica set from mongodb-memory-server
 *    (a real `mongod` binary, downloaded once and cached; a replica set because
 *    later tickets use transactions, which need one);
 *  - or an existing server via TEST_MONGODB_URI (its database name must
 *    contain "test": each test file drops it).
 */
let replSet: MongoMemoryReplSet | undefined

export async function setup(project: TestProject) {
  let uri = process.env.TEST_MONGODB_URI
  if (!uri) {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    })
    uri = replSet.getUri("stampd_test")
  }
  const dbName = new URL(uri).pathname.slice(1)
  if (!dbName.includes("test")) {
    throw new Error(
      `Refusing to use "${dbName}": the test database name must contain "test".`
    )
  }
  project.provide("mongoUri", uri)
}

export async function teardown() {
  await replSet?.stop()
}

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string
  }
}
