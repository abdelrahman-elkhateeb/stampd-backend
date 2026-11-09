// The Vercel Function: vercel.json rewrites every path here (see
// src/serverless.ts), compiled to dist/ by the "vercel-build" script.
import { createServerlessHandler } from "../dist/serverless.js"

export default createServerlessHandler()
