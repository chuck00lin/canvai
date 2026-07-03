#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createHubServer } from './server.ts'
import { startServe } from './serve.ts'

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`pairsketch-hub — repo-native JSON Canvas boards for humans + AI agents

usage:
  pairsketch-hub [--root <path>]           MCP server on stdio (for agent harnesses)
  pairsketch-hub serve [--root] [--port]   HTTP + WebSocket server for the web client

options:
  --root <path>   repo root to serve (default: cwd)
  --port <n>      serve mode port (default: 5199, 127.0.0.1 only)

Both modes coordinate through files (.canvas, .pairsketch/) — run them
side by side, or either one alone.`)
  process.exit(0)
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
  const running = await startServe(root, { port })
  console.error(`pairsketch hub: serving ${root}`)
  console.error(`  web    http://127.0.0.1:${running.port}`)
  console.error(`  api    http://127.0.0.1:${running.port}/api/boards`)
  console.error(`  ws     ws://127.0.0.1:${running.port}/ws`)
} else {
  const server = createHubServer(root)
  await server.connect(new StdioServerTransport())
  // stdout carries the MCP protocol; log to stderr only
  console.error(`pairsketch hub: MCP over stdio, root ${root}`)
}
