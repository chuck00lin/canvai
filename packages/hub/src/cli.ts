#!/usr/bin/env node
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createHubServer } from './server.ts'
import { startServe } from './serve.ts'
import { createReporter, errorDetail } from './report.ts'

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`canvai-hub — repo-native JSON Canvas boards for humans + AI agents

usage:
  canvai-hub [--root <path>]                              MCP server on stdio (for agent harnesses)
  canvai-hub serve [--root] [--port] [--host] [--token]   HTTP + WebSocket server for the web client

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

const root = path.resolve(flag('--root') ?? process.cwd())

if (args[0] === 'serve') {
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
  const running = await startServe(root, { port, host, token, agentCmd, handoffMode, handoffTimeoutMs, autoCommit, reporter })
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
