#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createHubServer } from './server.ts'

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`pairsketch-hub — MCP server for repo-native JSON Canvas boards

usage: pairsketch-hub [--root <path>]

  --root <path>   repo root to serve (default: cwd)

Register in .mcp.json (Claude Code) or any MCP client, stdio transport.`)
  process.exit(0)
}

let root = process.cwd()
const rootIndex = args.indexOf('--root')
if (rootIndex >= 0) {
  const value = args[rootIndex + 1]
  if (!value) {
    console.error('--root needs a path')
    process.exit(1)
  }
  root = path.resolve(value)
}

const server = createHubServer(root)
await server.connect(new StdioServerTransport())
// stdout carries the MCP protocol; log to stderr only
console.error(`pairsketch hub: serving ${root}`)
