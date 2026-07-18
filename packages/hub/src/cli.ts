#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createHubServer } from './server.ts'
import { startServe } from './serve.ts'
import { createReporter, errorDetail } from './report.ts'

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`canvai — repo-native JSON Canvas boards for humans + AI agents

usage:
  canvai init [--root <path>]                             wire canvai into a repo (.mcp.json + Claude Code pre-approval)
  canvai serve [--root] [--port] [--host] [--token]       HTTP + WebSocket server for the web client
  canvai mcp [--root <path>]                              MCP server on stdio (for agent harnesses; also the default)

options:
  --root <path>    repo root to serve (default: cwd)
  --port <n>       serve mode port (default: 5199)
  --host <addr>    bind address (default: 127.0.0.1 — local only).
                   Use 0.0.0.0 to reach it over a VPN/LAN; pair it with --token.
  --token <secret> require a bearer token (or ?token=) on /api and /ws
  --agent-cmd <t>  command for the handoff button; the prompt is piped to
                   stdin, or replaces a {prompt} placeholder if present
                   (default: 'claude -p --mcp-config .mcp.json --allowedTools mcp__canvai')
  --handoff-mode <m>  'spawn' (default) runs a fresh agent turn per handoff;
                   'signal' only broadcasts handoff_requested on /ws, for a
                   long-running session listening with its own context
  --handoff-timeout <s>  kill a spawned agent turn after this many seconds
                   (default: 300)
  --autocommit     commit every board change to the root's git repo
                   (run 'git init' in the root first)
  --report-url <u> POST error telemetry (startup / crash / API+client errors)
                   to this URL. Diagnostics only — never board content. Opt-in.

Both modes coordinate through files (.canvas, .canvai/) — run them
side by side, or either one alone.`)
  process.exit(0)
}

function reachableAddresses(): string[] {
  const addresses = ['127.0.0.1']
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address)
    }
  }
  return addresses
}

function flag(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    console.error(`${name} needs a value`)
    process.exit(1)
  }
  return value
}

function resolveWebDist(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    path.join(here, 'web'), // published bundle: dist/canvai.mjs → dist/web
    path.join(here, '..', '..', 'web', 'dist'), // dev: packages/hub/src → packages/web/dist
  ]
  for (const dir of candidates) if (existsSync(path.join(dir, 'index.html'))) return dir
  return candidates[0]
}

function mergeJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    console.error(`canvai: ${file} is not valid JSON — leaving it untouched`)
    return {}
  }
}

function runInit(target: string): void {
  // MCP server spawned via npx: always resolves to the installed canvai and runs
  // under a Node that can execute it — no absolute paths, works in headless handoffs.
  const mcpPath = path.join(target, '.mcp.json')
  const mcp = mergeJson(mcpPath) as { mcpServers?: Record<string, unknown> }
  mcp.mcpServers ??= {}
  mcp.mcpServers.canvai = { type: 'stdio', command: 'npx', args: ['-y', '@chuck00lin/canvai', 'mcp', '--root', '.'] }
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n')

  // pre-approve the project-scoped server so a headless `claude -p` handoff can
  // use it without interactive /mcp approval.
  const settingsPath = path.join(target, '.claude', 'settings.json')
  const settings = mergeJson(settingsPath) as { enabledMcpjsonServers?: string[] }
  const enabled = new Set(settings.enabledMcpjsonServers ?? [])
  enabled.add('canvai')
  settings.enabledMcpjsonServers = [...enabled]
  mkdirSync(path.dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')

  console.log(`canvai: wired into ${target}`)
  console.log('  .mcp.json               canvai MCP server (npx canvai mcp)')
  console.log('  .claude/settings.json   pre-approved for Claude Code')
  console.log('\nnext — open the board:')
  console.log('  npx @chuck00lin/canvai serve --root . --autocommit    # → http://127.0.0.1:5199')
}

const root = path.resolve(flag('--root') ?? process.cwd())
const command = args[0] && !args[0].startsWith('--') ? args[0] : 'mcp'

if (command === 'init') {
  runInit(root)
} else if (command === 'serve') {
  const port = Number(flag('--port') ?? 5199)
  const host = flag('--host') ?? '127.0.0.1'
  const token = flag('--token')
  const agentCmd = flag('--agent-cmd')
  const handoffMode = flag('--handoff-mode') === 'signal' ? ('signal' as const) : undefined
  const handoffTimeout = flag('--handoff-timeout')
  const handoffTimeoutMs = handoffTimeout ? Number(handoffTimeout) * 1000 : undefined
  const autoCommit = args.includes('--autocommit')
  const reporter = createReporter(flag('--report-url'), path.basename(root))
  // crashes are the whole point of telemetry — catch them before the process dies
  process.on('uncaughtException', (error) => {
    reporter.send('crash', { source: 'uncaughtException', ...errorDetail(error) })
    console.error('canvai hub: uncaught exception', error)
  })
  process.on('unhandledRejection', (reason) => {
    reporter.send('crash', { source: 'unhandledRejection', ...errorDetail(reason) })
  })
  const running = await startServe(root, { port, host, token, agentCmd, handoffMode, handoffTimeoutMs, autoCommit, reporter, webDist: resolveWebDist() })
  reporter.send('startup', { port: running.port })
  console.error(`canvai hub: serving ${root}`)
  const suffix = token ? `/?token=${encodeURIComponent(token)}` : '/'
  for (const address of host === '0.0.0.0' ? reachableAddresses() : [host]) {
    console.error(`  web    http://${address}:${running.port}${suffix}`)
  }
  if (host !== '127.0.0.1' && !token) {
    console.error('  ⚠  exposed beyond localhost WITHOUT --token: anyone on this network can read and edit boards under this root')
  }
} else {
  const server = createHubServer(root)
  await server.connect(new StdioServerTransport())
  // stdout carries the MCP protocol; log to stderr only
  console.error(`canvai hub: MCP over stdio, root ${root}`)
}
