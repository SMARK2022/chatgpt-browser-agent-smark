# chatgpt-browser-agent-smark

Private SMARK-maintained mirror of
[`abdallhMoukdad/chatgpt-browser-agent`](https://github.com/abdallhMoukdad/chatgpt-browser-agent).

This fork provides a local MCP bridge that lets OpenCode call the user's logged-in
ChatGPT web session through a persistent browser daemon. It is intended as an
external ChatGPT/Web research and engineering assistant for tasks such as current
documentation lookup, ecosystem and issue investigation, repository research,
debugging ideas, implementation guidance, summarization, and comparison.

Upstream copyright and license notices are preserved. The upstream project is
MIT licensed.

## Disclaimer

This project automates a browser session on `chatgpt.com` and is not affiliated
with or endorsed by OpenAI. Automated access may violate ChatGPT's Terms of
Use. Your account may be rate-limited or blocked. Use at your own risk.

## How It Works

```text
OpenCode MCP client
  -> mcp-server.js (JSON-RPC stdio)
  -> chatgpt.js CLI
  -> local HTTP daemon
  -> Puppeteer-controlled Edge/Chrome tab
  -> chatgpt.com project/chat page
```

The daemon starts on first use, writes its random local port to the state

## Files

```text
chatgpt.js      Persistent browser daemon and CLI
mcp-server.js   MCP stdio server for OpenCode and other MCP clients
agent.js        Experimental unsafe ChatGPT-driven local agent loop
```

## Requirements

- Node.js 18 or newer.
- Microsoft Edge or Google Chrome.
- A logged-in ChatGPT account.

This fork defaults to Windows Edge:

```text
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

Override it with `CHATGPT_BROWSER_PATH` if needed.

## Configuration

Runtime behavior is controlled by environment variables:

```text
CHATGPT_BROWSER_PATH              Browser executable path
CHATGPT_PROJECT_URL               ChatGPT Project URL to open for new chats
CHATGPT_STATE_DIR                 Profile, session, daemon, and log directory
CHATGPT_RESPONSE_TIMEOUT_MS       Browser response wait timeout, default 300000
CHATGPT_CLI_TIMEOUT_MS            MCP wrapper CLI timeout, default 310000
CHATGPT_DAEMON_START_TIMEOUT_MS   Daemon startup timeout, default 60000
```

If `CHATGPT_PROJECT_URL` is set, new chats start from that Project page. The
current local setup uses the ChatGPT Project named `MCP`.

The state directory contains:

```text
profile\       Dedicated browser profile
session        Last ChatGPT conversation/project URL
daemon.json    Current daemon pid and port
daemon.log     Daemon startup/request logs
```

## First Login

Run once:

```powershell
node chatgpt.js --login
```

The login flow opens a normal browser process with the dedicated profile instead
of logging in through Puppeteer. This avoids common Google OAuth rejections such
as "This browser or app may not be secure".

After the ChatGPT page is fully logged in, close the browser window and press
Enter in the terminal.

## CLI Usage

```powershell
node chatgpt.js --new "explain this error"
node chatgpt.js --raw --new "Reply exactly: OK"
node chatgpt.js --code "write a binary search in Go"
node chatgpt.js --context "project uses Effect v4" "review this approach"
node chatgpt.js --git "summarize these local changes"
node chatgpt.js --upload F:\path\to\file.txt "analyze this file"
node chatgpt.js --save F:\path\to\answer.txt "write a migration plan"
node chatgpt.js --status
node chatgpt.js --stop
```

`--raw` prints only ChatGPT's response body. MCP uses this mode so OpenCode gets
clean tool output without CLI framing.

## OpenCode MCP Setup

Use project-local config, for example `.opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "chatgpt": {
      "type": "local",
      "command": [
        "node",
        "F:\\ML\\PythonAIProject\\Claude-Code\\opencode\\.temp\\chatgpt-browser-agent\\mcp-server.js"
      ],
      "environment": {
        "CHATGPT_BROWSER_PATH": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "CHATGPT_PROJECT_URL": "https://chatgpt.com/g/g-p-6a1b384bc3688191b5e2c522d45fbe20/project",
        "CHATGPT_STATE_DIR": "F:\\ML\\PythonAIProject\\Claude-Code\\opencode\\.temp\\chatgpt-browser-agent\\.chatgpt-poc",
        "CHATGPT_RESPONSE_TIMEOUT_MS": "300000",
        "CHATGPT_CLI_TIMEOUT_MS": "310000",
        "CHATGPT_DAEMON_START_TIMEOUT_MS": "60000"
      },
      "enabled": true,
      "timeout": 320000
    }
  }
}
```

OpenCode prefixes MCP tool names with the server name. This server exposes these
internal MCP tools:

```text
ask
status
stop
```

OpenCode will present them as:

```text
chatgpt_ask
chatgpt_status
chatgpt_stop
```

For compatibility, `mcp-server.js` still accepts legacy calls named
`chatgpt_ask`, `chatgpt_status`, and `chatgpt_stop`, but it no longer advertises
those duplicate names in `tools/list`.

Restart OpenCode after changing MCP config or server code. MCP config is loaded
at startup.

## MCP Tool: ask

Inputs:

```json
{
  "prompt": "The question or task to send to ChatGPT",
  "context": "Optional additional context",
  "git": true,
  "newChat": true,
  "codeOnly": false,
  "file": "F:\\absolute\\path\\file.txt",
  "downloadDir": "F:\\optional\\download\\directory",
  "savePath": "F:\\absolute\\path\\answer.txt"
}
```

`git: true` attaches `git branch --show-current`, `git status --short`, and
`git diff HEAD` from the OpenCode working directory.

`file` uploads a local file through the ChatGPT attachment input.

`downloadDir` downloads generated ChatGPT sandbox files from the last assistant
message into the given local directory, then appends the downloaded file paths to
the tool result. When omitted, MCP downloads to the current OpenCode project cache:

```text
<current-project>/.opencode/cache/chatgpt-downloads
```

Override the default with `CHATGPT_DOWNLOAD_DIR` or
`OPENCODE_CHATGPT_DOWNLOAD_DIR`.

`savePath` writes the ChatGPT response to a local file. Calls with `savePath` do
not use the short dedup cache, so each save request writes the requested file.

## MCP Error Semantics

`mcp-server.js` maps non-zero `chatgpt.js` exits, spawn failures, and timeouts to
MCP tool results with `isError: true`. Successful `ask` calls return only the
raw ChatGPT response text.

## Experimental agent.js

`agent.js` is not the primary OpenCode integration path. It is an experimental
standalone loop where ChatGPT can request local shell commands and file writes
using `===RUN===` and `===FILE===` blocks.

By default it asks before each command or file write. Unattended execution now
requires both flags:

```powershell
node agent.js --auto --i-understand-this-runs-chatgpt-generated-commands "task"
```

Do not expose `agent.js` as an MCP tool unless you intentionally want a separate
agent loop outside OpenCode's normal tool flow.

## Upstream Tracking

Local remotes are intended to be:

```text
origin    https://github.com/SMARK2022/chatgpt-browser-agent-smark.git
upstream  https://github.com/abdallhMoukdad/chatgpt-browser-agent.git
```

Recommended sync flow:

```powershell
git fetch upstream --prune --tags
git switch master
git merge --ff-only upstream/master
git push origin master

git switch smark/main
git merge master
git push
```

## Limitations

- This uses the unofficial ChatGPT web UI and can break when the DOM changes.
- ChatGPT requests are serialized; one browser tab handles one request at a time.
- File uploads depend on the `#upload-files` input existing in the page.
- Response extraction depends on `[data-message-author-role="assistant"]`.
- Headless mode is not used; the browser runs visibly.

## License

MIT. See `LICENSE`.
