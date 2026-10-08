import { z } from "zod"

/**
 * The only place that reads process.env (lint enforces it). Everything else
 * receives a typed, validated Config. The app refuses to start on bad config.
 */
const configSchema = z.object({
  APP_ENV: z.enum(["local", "test", "staging", "production"]),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().min(1).default("0.0.0.0"),
  MONGODB_URI: z
    .string()
    .regex(
      /^mongodb(\+srv)?:\/\//,
      "must start with mongodb:// or mongodb+srv://"
    ),
  LOG_LEVEL: z
    .enum(["error", "warn", "info", "debug", "silent"])
    .default("info"),
})

export type AppEnv = z.infer<typeof configSchema>["APP_ENV"]
export type LogLevel = z.infer<typeof configSchema>["LOG_LEVEL"]

export type Config = Readonly<{
  appEnv: AppEnv
  port: number
  host: string
  mongodbUri: string
  logLevel: LogLevel
}>

export class ConfigError extends Error {
  override readonly name = "ConfigError"
}

/**
 * Validates the environment. Error messages name the variable and the rule,
 * never the value (MONGODB_URI can contain a password).
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env
): Config {
  const parsed = configSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n")
    throw new ConfigError(
      `Invalid environment configuration:\n${problems}\nSee .env.example.`
    )
  }
  const e = parsed.data
  return Object.freeze({
    appEnv: e.APP_ENV,
    port: e.PORT,
    host: e.HOST,
    mongodbUri: e.MONGODB_URI,
    logLevel: e.LOG_LEVEL,
  })
}
