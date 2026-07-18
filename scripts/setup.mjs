#!/usr/bin/env node
/**
 * canvai one-shot setup. Run from the canvai checkout:
 *
 *   node scripts/setup.mjs --repo /path/to/the/repo/you/want/boards/in
 *
 * It verifies Node, builds the web client if needed, scaffolds a `.mcp.json`
 * in the target repo so Claude Code (or any MCP client) can reach the hub, and
 * prints the exact commands to serve, expose (no VPN), and monitor. Idempotent:
 * re-running is safe.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const CANVAI = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const repo = path.resolve(flag('--repo', process.cwd()))
const cli = path.join(CANVAI, 'packages', 'hub', 'src', 'cli.ts')

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`)
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`)
const run = (cmd, cwd = CANVAI) => execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim()

console.log('\x1b[1mcanvai setup\x1b[0m')
console.log(`  canvai: ${CANVAI}`)
console.log(`  repo:   ${repo}`)

// 1 — Node version
step('1 · Node')
const major = Number(process.versions.node.split('.')[0])
const minor = Number(process.versions.node.split('.')[1])
if (major > 23 || (major === 23 && minor >= 6)) ok(`Node ${process.version} (runs TypeScript natively)`)
else {
  warn(`Node ${process.version} — canvai needs ≥ 23.6 to run the hub's TypeScript directly. Upgrade first.`)
  process.exit(1)
}

// 2 — deps + web build
step('2 · Build')
if (!existsSync(path.join(CANVAI, 'node_modules'))) {
  run('npm install')
  ok('installed dependencies')
} else ok('dependencies present')
if (!existsSync(path.join(CANVAI, 'packages', 'web', 'dist', 'index.html'))) {
  run('npm run web:build')
  ok('built web client')
} else ok('web client already built')

// 3 — .mcp.json + pre-approval in the target repo
step('3 · Point Claude Code at the repo')
const mcpPath = path.join(repo, '.mcp.json')
let mcp = {}
if (existsSync(mcpPath)) {
  try {
    mcp = JSON.parse(readFileSync(mcpPath, 'utf8'))
  } catch {
    warn(`${mcpPath} exists but is not valid JSON — leaving it untouched`)
  }
}
mcp.mcpServers ??= {}
// Use an ABSOLUTE node path, never bare "node". Claude Code spawns the MCP server
// with whatever "command" resolves to — and a Claude CLI running under an older
// Node (e.g. 20) can't execute canvai's TypeScript cli.ts (needs ≥ 23.6): it dies
// with ERR_UNKNOWN_FILE_EXTENSION ".ts". process.execPath is THIS script's own
// interpreter, which step 1 already proved is ≥ 23.6, so it's always safe here.
// (Path is machine-specific by nature — re-run setup on each machine.)
const server = { type: 'stdio', command: process.execPath, args: [cli, '--root', '.'] }
const existing = mcp.mcpServers.canvai
if (existing && existing.command === process.execPath) ok('.mcp.json canvai server already points at this Node')
else {
  mcp.mcpServers.canvai = server
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n')
  ok(`${existing ? 'repaired' : 'wrote'} canvai server in ${mcpPath}\n    → ${process.execPath}`)
}

// Pre-approve the project-scoped server so a headless `claude -p` handoff can use
// it without interactive /mcp approval — otherwise it sits at "Pending approval"
// and a non-interactive session silently falls back to reading .canvai/ files.
const settingsPath = path.join(repo, '.claude', 'settings.json')
let settings = {}
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    warn(`${settingsPath} exists but is not valid JSON — leaving it untouched`)
  }
}
const enabled = new Set(settings.enabledMcpjsonServers ?? [])
if (enabled.has('canvai')) ok('.claude/settings.json already pre-approves canvai')
else {
  enabled.add('canvai')
  settings.enabledMcpjsonServers = [...enabled]
  mkdirSync(path.dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  ok(`pre-approved canvai in ${settingsPath}`)
}

// 4 — git (undo safety net + telemetry via history)
step('4 · Version-control your boards')
let isGit = false
try {
  run('git rev-parse --git-dir', repo)
  isGit = true
} catch {
  isGit = false
}
if (isGit) ok('repo is under git — start the hub with --autocommit so every board change is committed (undo safety net)')
else warn(`${repo} is not a git repo. \`git init\` it (or use one that is) so boards are versioned — canvai has no undo yet; git IS the undo.`)

// 5 — run / expose / monitor
step('5 · Run it')
const q = (s) => (s.includes(' ') ? `"${s}"` : s)
console.log(`
  # serve the board UI (local only)
  node ${q(cli)} serve --root ${q(repo)} --autocommit

  # reach it from anywhere WITHOUT a VPN (public HTTPS, no port-forward):
  #   install: brew install cloudflared   (or see cloudflare docs)
  cloudflared tunnel --url http://localhost:5199

  # early-testing monitoring: report crashes/errors to a URL you control
  node ${q(cli)} serve --root ${q(repo)} --autocommit \\
      --host 0.0.0.0 --token CHOOSE-A-SECRET \\
      --report-url https://YOUR-RECEIVER/report
`)
console.log('\x1b[2m  Privacy: --report-url ships diagnostics only (never board content). Keep any tunnel behind --token and any GitHub mirror private.\x1b[0m')
console.log('\ndone.')
