#!/usr/bin/env node
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createHubServer } from './server.ts'
import { startServe } from './serve.ts'

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`pairsketch-hub — repo-native JSON Canvas boards for humans + AI agents

usage:
  pairsketch-hub [--root <path>]                              MCP server on stdio (for agent harnesses)
  pairsketch-hub serve [--root] [--port] [--host] [--token]   HTTP + WebSocket server for the web client

options:
  --root <path>    repo root to serve (default: cwd)
  --port <n>       serve mode port (default: 5199)
  --host <addr>    bind address (default: 127.0.0.1 — local only).
                   Use 0.0.0.0 to reach it over a VPN/LAN; pair it with --token.
  --token <secret> require a bearer token (or ?token=) on /api and /ws

Both modes coordinate through files (.canvas, .pairsketch/) — run them
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
  const running = await startServe(root, { port, host, token })
  console.error(`pairsketch hub: serving ${root}`)
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
  console.error(`pairsketch hub: MCP over stdio, root ${root}`)
}
