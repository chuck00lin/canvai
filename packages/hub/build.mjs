#!/usr/bin/env node
// Build the publishable `canvai` package: bundle the hub (TypeScript, workspace
// deps and all) into one standalone ESM file that runs on plain Node ≥18, and
// copy the prebuilt web client alongside it. The result under dist/ is the whole
// npm package (see package.json "files").
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const hubDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(hubDir, '..', '..')
const webDist = path.join(repoRoot, 'packages', 'web', 'dist')
const outDir = path.join(hubDir, 'dist')

// 1 — make sure the web client is built (it's a separate build step)
if (!existsSync(path.join(webDist, 'index.html'))) {
  console.log('web client not built — running web:build …')
  execFileSync('npm', ['run', 'build', '-w', '@canvai/web'], { cwd: repoRoot, stdio: 'inherit' })
}

// 2 — bundle the hub into a single self-contained ESM entry
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
await esbuild.build({
  entryPoints: [path.join(hubDir, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: path.join(outDir, 'canvai.mjs'),
  // createRequire shim so bundled CJS deps' dynamic require() works under ESM.
  // (No shebang here — esbuild preserves the one already at the top of cli.ts.)
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  logLevel: 'info',
})

// 3 — ship the web client next to the bundle (cli.ts resolves ./web at runtime)
cpSync(webDist, path.join(outDir, 'web'), { recursive: true })

console.log('built canvai → dist/canvai.mjs + dist/web/')
