import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      // Configuration is read in one place only (src/config/env.ts).
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read configuration through src/config/env.ts (loadConfig).",
        },
      ],
    },
  },
  {
    files: ["src/config/env.ts", "tests/**", "*.config.ts"],
    rules: { "no-restricted-properties": "off" },
  }
)
