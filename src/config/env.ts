import { z } from "zod"

/**
 * The only place that reads process.env (lint enforces it). Everything else
 * receives a typed, validated Config. The app refuses to start on bad config.
 */
const configSchema = z
  .object({
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
    /** Signs access tokens and derives rotated refresh tokens. At least 32 characters. */
    AUTH_TOKEN_SECRET: z.string().min(32, "must be at least 32 characters"),
    /** The web app's base URL, used to build invite and reset links. */
    WEB_APP_URL: z.url().default("http://localhost:3000"),
    /**
     * Protects GET /jobs/{name}, which the scheduler (Vercel Cron) calls with
     * "Authorization: Bearer <CRON_SECRET>". Without it the route doesn't exist.
     */
    CRON_SECRET: z
      .string()
      .min(32, "must be at least 32 characters")
      .optional(),
  })
  .superRefine((env, ctx) => {
    const deployed = env.APP_ENV === "staging" || env.APP_ENV === "production"
    if (deployed && /change-me|local-dev/i.test(env.AUTH_TOKEN_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_TOKEN_SECRET"],
        message:
          "must be a real secret in staging/production, not the example value",
      })
    }
    if (deployed && /localhost|127\.0\.0\.1/.test(env.WEB_APP_URL)) {
      ctx.addIssue({
        code: "custom",
        path: ["WEB_APP_URL"],
        message: "must be the deployed web app URL in staging/production",
      })
    }
  })

export type AppEnv = z.infer<typeof configSchema>["APP_ENV"]
export type LogLevel = z.infer<typeof configSchema>["LOG_LEVEL"]

export type Config = Readonly<{
  appEnv: AppEnv
  port: number
  host: string
  mongodbUri: string
  logLevel: LogLevel
  authTokenSecret: string
  webAppUrl: string
  /** null: the scheduled-job route is off (jobs run in-process, server.ts) */
  cronSecret: string | null
}>

export class ConfigError extends Error {
  override readonly name = "ConfigError"
}

/**
 * Validates the environment. Error messages name the variable and the rule,
 * never the value (MONGODB_URI and AUTH_TOKEN_SECRET are secrets).
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
    authTokenSecret: e.AUTH_TOKEN_SECRET,
    webAppUrl: e.WEB_APP_URL.replace(/\/$/, ""),
    cronSecret: e.CRON_SECRET ?? null,
  })
}
