# Deploying canvai on another machine (incl. no VPN)

This is the path for putting canvai on a repo that lives on a **different machine** —
a collaborator's laptop, a lab workstation, the machine your real project is on — and
watching it from where you are while it's still early and rough.

## One-shot setup

On the target machine, clone canvai next to (not inside) the repo you want boards in,
then run the setup script against that repo:

```bash
git clone git@github.com:chuck00lin/canvai.git
cd canvai
node scripts/setup.mjs --repo /path/to/your/project    # or: npm run setup -- --repo /path/to/your/project
```

`setup.mjs` is idempotent. It:

1. checks Node ≥ 23.6 (the hub runs TypeScript directly — no build step),
2. installs deps and builds the browser client if needed,
3. writes a `canvai` server into your project's `.mcp.json` (so Claude Code / any MCP client can reach it),
4. tells you whether your project is under git (canvai has **no undo** yet — git *is* the undo; start the hub with `--autocommit`),
5. prints the exact serve / tunnel / monitoring commands, filled in with your paths.

## Reaching the board with no VPN

The hub binds `127.0.0.1`. If the target machine is on your VPN or LAN, use
`--host 0.0.0.0 --token` (see the README's Remote section). If it has **no VPN and no
port-forward**, put a tunnel in front — [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
gives a public HTTPS URL over an outbound-only connection, no inbound ports opened:

```bash
# terminal 1 — serve (keep it local; the tunnel is the only thing exposed)
node /path/to/canvai/packages/hub/src/cli.ts serve --root /path/to/your/project --autocommit --token choose-a-secret

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
node /path/to/canvai/packages/hub/src/cli.ts serve --root /path/to/your/project \
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
