// Vercel Function: every request (see "rewrites" in vercel.json) reaches the
// Express app, compiled to dist/ by the build ("vercel-build" in package.json).
import { createServerlessHandler } from "../dist/serverless.js"

export default createServerlessHandler()
