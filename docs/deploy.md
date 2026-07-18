# Deploying canvai on another machine (incl. no VPN)

This is the path for putting canvai on a repo that lives on a **different machine** —
a collaborator's laptop, a lab workstation, the machine your real project is on — and
watching it from where you are while it's still early and rough.

## Setup

On the target machine, from the repo you want boards in:

```bash
cd /path/to/your/project
npx @chuck00lin/canvai init      # writes .mcp.json + pre-approves it for Claude Code
```

`npx @chuck00lin/canvai init` writes a `canvai` MCP server into `.mcp.json` — spawned as `npx -y canvai mcp`,
so it always resolves to an installed canvai and runs under a Node that can execute it (no
absolute paths, works in headless `claude -p` handoffs) — and pre-approves it in
`.claude/settings.json` (`enabledMcpjsonServers: ["canvai"]`) so a headless handoff can use the
tools without interactive `/mcp` approval. canvai has **no undo** yet — keep your project under
git and start the hub with `--autocommit` so git *is* the undo.

**From source instead** (contributing, air-gapped, or a Node without npx): clone canvai and run
the equivalent setup script, which builds the web client and pins `.mcp.json` to an absolute
Node ≥ 23.6 path (a bare `node` can resolve to the Claude CLI's own older Node and fail to run
canvai's TypeScript entry):

```bash
git clone git@github.com:chuck00lin/canvai.git
node canvai/scripts/setup.mjs --repo /path/to/your/project
```

## Reaching the board with no VPN

The hub binds `127.0.0.1`. If the target machine is on your VPN or LAN, use
`--host 0.0.0.0 --token` (see the README's Remote section). If it has **no VPN and no
port-forward**, put a tunnel in front — [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
gives a public HTTPS URL over an outbound-only connection, no inbound ports opened:

```bash
# terminal 1 — serve (keep it local; the tunnel is the only thing exposed)
npx @chuck00lin/canvai serve --root /path/to/your/project --autocommit --token choose-a-secret

# terminal 2 — public URL
cloudflared tunnel --url http://localhost:5199
# → https://<random>.trycloudflare.com   (open it with ?token=choose-a-secret)
```

Bonus: the tunnel serves HTTPS, so the browser gets a *secure context* — clipboard
paste and other secure-context-only features work that don't over plain `http://<ip>`.

Keep `--token` on even behind a tunnel: the URL is public. The token guards `/api` and
`/ws`; the static shell carries no data.

## Watching for problems remotely (`--report-url`)

While a remote install is new and you're not sitting next to it, have the hub **report its
own crashes and errors** to an endpoint you control. Opt in with `--report-url`:

```bash
npx @chuck00lin/canvai serve --root /path/to/your/project \
    --autocommit --host 0.0.0.0 --token choose-a-secret \
    --report-url https://your-endpoint.example/report
```

When set, the hub POSTs compact JSON events to that URL:

| kind | when |
|---|---|
| `startup` | the hub came up (so you know the remote install is live) |
| `crash` | an uncaught exception / unhandled rejection took the process down |
| `error` | an API request threw (method, path, message, short stack) |
| `client-error` | the browser hit an uncaught error (forwarded from the web client) |

Each event carries only diagnostics — `hubVersion`, Node version, platform, the repo
folder's **basename**, and error text. **It never sends board content, file contents, or
full paths.** No URL set → nothing is sent; the feature is off by default.

The receiver is anything that accepts `POST` with a JSON body — a serverless function, a
tiny Node HTTP server, a logging service. If the target machine has no VPN, run your
receiver behind its own `cloudflared` tunnel so the remote can reach it. A ~30-line
reference receiver:

```js
import { createServer } from 'node:http'
createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => { console.log(body); res.writeHead(200); res.end('ok') })
}).listen(5196)
```
