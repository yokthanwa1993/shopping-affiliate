#!/usr/bin/env node
// Build the React/Vite preview app (apps/dashboard/react-dashboard) and copy its
// output into the Astro deploy bundle at dist/dashboard_next/, so a single
// `wrangler deploy` from apps/dashboard ships both the Astro app and the React
// preview. The dashboard Worker serves dist/dashboard_next/ at /dashboard_next/
// (see src/worker.ts).
//
// MUST run AFTER `astro build`, which clears dist/. The package.json `build`
// script sequences it: `astro build && npm run build:next`.
//
// Determinism: this script ensures the preview's deps are installed, builds it,
// asserts the build output exists, then replaces dist/dashboard_next/ wholesale.
// It never commits react-dashboard/dist or node_modules (both gitignored there).
import { execSync } from 'node:child_process'
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dashboardRoot = join(here, '..') // apps/dashboard
const reactRoot = join(dashboardRoot, 'react-dashboard')
const reactDist = join(reactRoot, 'dist')
const astroDist = join(dashboardRoot, 'dist')
const targetDist = join(astroDist, 'dashboard_next')

function run(cmd, cwd) {
  console.log(`[dashboard_next] $ ${cmd}  (cwd: ${cwd})`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

// 1) Ensure preview deps are present, then build it (tsc --noEmit && vite build).
if (!existsSync(reactRoot)) {
  throw new Error(`[dashboard_next] preview app not found at ${reactRoot}`)
}
if (!existsSync(join(reactRoot, 'node_modules'))) {
  run('npm install', reactRoot)
}
run('npm run build', reactRoot)

if (!existsSync(join(reactDist, 'index.html'))) {
  throw new Error(`[dashboard_next] expected build output missing: ${join(reactDist, 'index.html')}`)
}

// 2) Astro must have produced dist/ already (build runs `astro build` first).
if (!existsSync(astroDist)) {
  throw new Error(`[dashboard_next] Astro dist/ not found at ${astroDist}; run "astro build" first`)
}

// 3) Replace dist/dashboard_next/ with the fresh preview build.
rmSync(targetDist, { recursive: true, force: true })
mkdirSync(targetDist, { recursive: true })
cpSync(reactDist, targetDist, { recursive: true })

console.log(`[dashboard_next] copied ${reactDist} -> ${targetDist}`)
