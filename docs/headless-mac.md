# Running canvai on an always-on Mac

The hub is designed to live on a 24/7 machine: boards are files in repos, the
serve process watches them, and you reach the web client over your tailnet/VPN.

## One-time setup

```bash
# requirements: Node >= 23.6 (runs the TS directly), git
git clone <your-private-repo-url> ~/canvai
cd ~/canvai && npm install && npm run web:build
```

If you want the **handoff button to spawn agent turns** on this machine
(`--handoff-mode spawn`, the default), it additionally needs:

1. **Claude Code CLI installed and authenticated** (`claude` on PATH for the
   launchd user — note launchd does not read your shell profile, so use an
   absolute path in the plist or symlink into /usr/local/bin).
2. **Workspace trust** for every repo you serve, or headless turns can't use
   the repo's `.mcp.json` permissions:
   `projects["<repo path>"].hasTrustDialogAccepted: true` in `~/.claude.json`
   (or run `claude` interactively there once and accept the dialog).

`--handoff-mode signal` (a long-running session answers instead) is for a
machine where you keep an interactive session attached — usually *not* the
headless box; leave the 24/7 machine on `spawn`.

## Serving a repo with launchd

`~/Library/LaunchAgents/com.canvai.hub.plist` — adjust the three paths,
the token, and the target repo:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.canvai.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/canvai/packages/hub/src/cli.ts</string>
    <string>serve</string>
    <string>--root</string><string>/Users/YOU/work/some-repo</string>
    <string>--host</string><string>0.0.0.0</string>
    <string>--token</string><string>CHOOSE-A-SECRET</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/canvai-hub.log</string>
  <key>StandardErrorPath</key><string>/tmp/canvai-hub.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.canvai.hub.plist
tail -f /tmp/canvai-hub.log   # prints every reachable URL incl. your tailnet IP
```

Then open `http://<tailnet-ip>:5199/?token=CHOOSE-A-SECRET` from anywhere on
your VPN. One plist per served repo (give each a distinct `Label` and
`--port`).

## Checklist for exposing beyond localhost

- always pair `--host 0.0.0.0` with `--token` (the CLI warns if you don't);
- macOS application firewall: allow incoming connections for the node binary
  the first time, or pre-approve it
  (`sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(readlink -f "$(which node)")" && sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(readlink -f "$(which node)")"`);
- prevent sleep: Energy Saver → never sleep, or `sudo pmset -a sleep 0`;
- `.canvai/` (chat/events/pins) is per-checkout working state and stays
  gitignored — boards (`*.canvas`) are the content that syncs through git.
