// Vercel Function for the "history" module (see "rewrites" in vercel.json and
// src/serverless.ts), compiled to dist/ by the "vercel-build" script.
import { createServerlessHandler } from "../dist/serverless.js"

export default createServerlessHandler("history")
