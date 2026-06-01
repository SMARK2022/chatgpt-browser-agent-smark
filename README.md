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
CHATGPT_PROJECT                   Fixed ChatGPT Project name, id, or URL
CHATGPT_STATE_DIR                 Browser profile, project cache, daemon, and log directory
CHATGPT_SESSION_DIR               Optional user-level #xxxxxx session registry directory
CHATGPT_RESPONSE_TIMEOUT_MS       Browser response wait timeout, default 300000
CHATGPT_CLI_TIMEOUT_MS            MCP wrapper CLI timeout, default 310000
CHATGPT_DAEMON_START_TIMEOUT_MS   Daemon startup timeout, default 60000
CHATGPT_FILE_UPLOAD_TIMEOUT_MS    Wait timeout for ChatGPT file upload readiness, default 180000
CHATGPT_MAX_RETURN_CHARS          Safe response return threshold, default 6000
CHATGPT_RESPONSE_PREVIEW_CHARS    Preview length returned after local save, default 4000
CHATGPT_MCP_MAX_RETURN_CHARS      Final MCP wrapper output cap, default 8000
```

`CHATGPT_PROJECT` is deployment configuration, not an MCP model parameter. The
daemon resolves it once as the fixed ChatGPT Project used for all sessions. It
can be a short project name such as `MCP`, a project id such as `g-p-...`, or a
full Project URL. If name resolution is unreliable, use the full Project URL.

`CHATGPT_SESSION_DIR` stores the global `#xxxxxx -> ChatGPT conversation URL`
registry. If omitted, the default user-level opencode data directory is used,
for example `%LOCALAPPDATA%\opencode\chatgpt-browser-agent` on Windows.

The state directory contains:

```text
profile\       Dedicated browser profile
projects.json  Resolved Project name/id/url cache
daemon.json    Current daemon pid and port
daemon.log     Daemon startup/request logs
```

Current-project artifacts are stored separately from the global session registry:

```text
<current-project>/.opencode/cache/chatgpt/
  responses/
    #4fa92c/
      2026-06-01T10-30-15Z.md
  downloads/
    #4fa92c/
      story.txt
      result.csv
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
node chatgpt.js "explain this error"
node chatgpt.js --session-id #4fa92c "continue the previous research"
node chatgpt.js --raw "Reply exactly: OK"
node chatgpt.js --context "project uses Effect v4" "review this approach"
node chatgpt.js --git "summarize these local changes"
node chatgpt.js --upload F:\path\to\file.txt --upload F:\path\to\notes.docx "analyze these files"
node chatgpt.js --save-to-file "write a long research report"
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
        "CHATGPT_PROJECT": "MCP",
        "CHATGPT_STATE_DIR": "F:\\ML\\PythonAIProject\\Claude-Code\\opencode\\.temp\\chatgpt-browser-agent\\.chatgpt-poc",
        "CHATGPT_RESPONSE_TIMEOUT_MS": "600000",
        "CHATGPT_CLI_TIMEOUT_MS": "580000",
        "CHATGPT_DAEMON_START_TIMEOUT_MS": "60000",
        "CHATGPT_FILE_UPLOAD_TIMEOUT_MS": "180000",
        "CHATGPT_MAX_RETURN_CHARS": "6000",
        "CHATGPT_RESPONSE_PREVIEW_CHARS": "4000",
        "CHATGPT_MCP_MAX_RETURN_CHARS": "8000"
      },
      "enabled": true,
      "timeout": 620000
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
  "sessionID": "#4fa92c",
  "context": "Optional additional context",
  "git": true,
  "file": ["F:\\absolute\\path\\file.txt", "F:\\absolute\\path\\notes.docx"],
  "saveToFile": true
}
```

`sessionID` is a global short handle for a ChatGPT conversation, such as
`#4fa92c`. Omit it to create a new session; pass an existing ID to continue that
conversation from any OpenCode working directory.

`git: true` attaches `git branch --show-current`, `git status --short`, and
`git diff HEAD` from the OpenCode working directory.

`file` uploads one local file or an array of local files through the ChatGPT
attachment input. Uploads are retried for transient browser frame errors.

`saveToFile: true` saves the text response to the current project cache and
returns only metadata instead of the full response body:

```text
<current-project>/.opencode/cache/chatgpt/responses/<sessionID>/<timestamp>.md
```

Generated ChatGPT sandbox/download files are always saved under:

```text
<current-project>/.opencode/cache/chatgpt/downloads/<sessionID>/
```

The model does not control the output directories. The tool returns saved and
downloaded file paths plus the `Session: #xxxxxx` handle.

Long responses are saved before returning to OpenCode even when `saveToFile` is
omitted. In that case the tool returns a bounded preview, the saved file path,
line count, character count, and `Session: #xxxxxx`. This avoids OpenCode's own
tool-output truncation path while preserving the complete answer locally.

## MCP Error Semantics

`mcp-server.js` maps non-zero `chatgpt.js` exits, spawn failures, and timeouts to
MCP tool results with `isError: true`. On wrapper timeout it stops the daemon so
the next call starts cleanly. Browser-frame/protocol errors trigger one automatic
daemon restart and retry before surfacing an error. Successful `ask` calls return
the ChatGPT response text or metadata when the response was saved to file.

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
