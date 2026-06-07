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
  -> chatgpt.js CLI/client request builder
  -> chatgpt-core.js local HTTP daemon/session lifecycle
  -> chatgpt-dom.js ChatGPT Web DOM/artifact adapter
  -> Puppeteer-controlled Edge/Chrome tab
  -> chatgpt.com project/chat page
```

The daemon starts on first use and writes its random local port to the state
directory. MCP `ask` calls pass long prompt/context payloads to `chatgpt.js`
through stdin rather than Windows command-line arguments, so the wrapper does not
need to leave full request JSON in the OS temp directory.

## Files

```text
chatgpt.js       CLI/client layer: argv, stdin, git/context, JSON payload, HTTP call
chatgpt-core.js  Daemon, project/session registry, pending recovery, result persistence
chatgpt-dom.js   Single ChatGPT Web DOM adapter for upload/wait/extract/artifacts
mcp-server.js    MCP stdio server for OpenCode and other MCP clients
agent.js         No-exec one-shot ChatGPT helper CLI; no local RUN/FILE actions
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
CHATGPT_BROWSER_USER_DATA_DIR     Browser user-data dir to reuse an existing logged-in profile
CHATGPT_BROWSER_PROFILE_DIRECTORY Browser profile name inside the user-data dir, for example Default
CHATGPT_BROWSER_DEBUG_PORT        Optional DevTools port for reusing/launching a debuggable browser
CHATGPT_BROWSER_CDP_URL           Optional http://127.0.0.1:<port> DevTools endpoint to connect
CHATGPT_BROWSER_WS_ENDPOINT       Optional websocket DevTools endpoint to connect
CHATGPT_BROWSER_CONNECT_TIMEOUT_MS DevTools connect preflight timeout, default 3000
CHATGPT_PROJECT                   Fixed ChatGPT Project name, id, or URL
CHATGPT_STATE_DIR                 Browser profile, project cache, daemon, and log directory
CHATGPT_SESSION_DIR               Optional user-level #xxxxxxxxxx session registry directory
CHATGPT_RESPONSE_TIMEOUT_MS       Browser response wait timeout, default 540000
CHATGPT_ASYNC_DETACH_MS           Concurrent-session detach threshold, default 12000
CHATGPT_HTTP_TIMEOUT_MS           Short local daemon HTTP timeout for status/stop, default 30000
CHATGPT_ASK_HTTP_TIMEOUT_MS       Long local daemon HTTP timeout for ask, default 620000
CHATGPT_HTTP_RESPONSE_MAX_BYTES   Local daemon response body cap, default 10485760
CHATGPT_CLI_TIMEOUT_MS            MCP wrapper CLI timeout, default 635000
CHATGPT_MCP_CHILD_OUTPUT_MAX_BYTES Child stdout/stderr cap, default 12582912
CHATGPT_MCP_STDIN_LINE_MAX_BYTES  MCP JSON-RPC line cap before parsing, default 26214400
CHATGPT_MCP_MAX_ACTIVE_CALLS      Concurrent ask cap, default 4
CHATGPT_MCP_TIMEOUT_RECOVERY_HOLD_MS Stop-safety hold after ask timeout, default 120000
CHATGPT_DAEMON_START_TIMEOUT_MS   Daemon startup timeout, default 60000
CHATGPT_MAX_RETURN_CHARS          Safe response return threshold, default 6000
CHATGPT_RESPONSE_PREVIEW_CHARS    Preview length returned after local save, default 4000
CHATGPT_MCP_MAX_RETURN_CHARS      Final MCP wrapper output cap, default 8000
CHATGPT_MAX_SESSION_PAGES         Idle page pool cap, default 8
CHATGPT_PENDING_TTL_MS            Stale pending marker TTL, default 43200000
CHATGPT_COMPLETED_RETRY_TTL_MS    Same-prompt completed replay window, default 600000
CHATGPT_JSON_LOCK_TIMEOUT_MS      Session/project JSON lock wait, default 30000
CHATGPT_SESSION_MAX_ENTRIES       Max retained ordinary session entries, default 256
CHATGPT_SESSION_MAX_AGE_MS        Max age for ordinary completed session entries, default 7776000000
CHATGPT_DAEMON_MAX_REQUEST_BYTES  Local daemon /ask body cap, default 26214400
CHATGPT_WORKSPACE_ROOTS           Path-delimited allowlist for response/artifact cache roots; defaults to daemon cwd
CHATGPT_WORKSPACE_DIR             Optional override for current project workspace; normally omit under OpenCode
CHATGPT_UPLOAD_ROOTS              Extra upload allowlist roots; default is <current-project>/.opencode/cache/chatgpt/uploads
CHATGPT_MAX_UPLOAD_FILES          Per-request upload file count cap, default 12
CHATGPT_MAX_UPLOAD_BYTES          Per-file upload size cap, default 419430400
CHATGPT_MAX_TOTAL_UPLOAD_BYTES    Per-request aggregate upload cap, default 838860800
CHATGPT_MAX_ARTIFACT_BYTES        Per-response aggregate downloaded artifact cap, default 4294967296
CHATGPT_TEXT_FILE_MAX_BYTES       CLI --file text size cap, default 2097152
CHATGPT_GIT_DIFF_MAX_CHARS        git diff context cap, default 100000
CHATGPT_MAX_FULL_PROMPT_CHARS     Final prompt cap after expansion, default 500000
```

`CHATGPT_PROJECT` is deployment configuration, not an MCP model parameter. The
daemon resolves it on startup as the fixed ChatGPT Project used for all sessions.
Prefer a short project name such as `MCP` for config migration. A project id or
full Project URL is accepted as a troubleshooting override when name discovery is
unreliable. Name discovery reads cached project data and visible sidebar links;
if ChatGPT changes or localizes the project sidebar, set `CHATGPT_PROJECT` to the
full Project URL to bypass sidebar discovery.

Browser reuse has two modes. If an existing Edge/Chrome was started with a DevTools
port, set `CHATGPT_BROWSER_CDP_URL`, `CHATGPT_BROWSER_WS_ENDPOINT`, or
`CHATGPT_BROWSER_DEBUG_PORT` and the daemon connects to that browser. A normal
already-running Edge window cannot be attached after the fact by Puppeteer. To reuse
the normal Edge login state without a DevTools port, set `CHATGPT_BROWSER_USER_DATA_DIR`
and `CHATGPT_BROWSER_PROFILE_DIRECTORY`; Chromium may require closing the regular
Edge process using that profile before the daemon can launch a controlled window.

`CHATGPT_SESSION_DIR` stores the internal global session registry keyed by short
handles such as `#4fa92c9d10`. Entries include the ChatGPT conversation URL, Project
metadata, timestamps, and pending recovery state. If omitted, the default
user-level opencode data directory is used, for example
`%LOCALAPPDATA%\opencode\chatgpt-browser-agent` on Windows.

`CHATGPT_PENDING_TTL_MS` controls how long a pending session is considered fresh
for page retention and automatic recovery. Stale pending markers still get one
live DOM recovery attempt before being cleared. Old ordinary session entries are
retained by `CHATGPT_SESSION_MAX_ENTRIES` (default `256`) and
`CHATGPT_SESSION_MAX_AGE_MS` (default 90 days). Corrupt `sessions.json` backups use
the same private file mode and age-based cleanup. Conversation URLs are still local
private metadata; remove the user-level state directory only when you intentionally
want to forget all ChatGPT session handles.

The state directory contains:

```text
profile\       Dedicated browser profile
projects.json  Resolved Project name/id/url cache
daemon.json    Current daemon pid, port, and local bearer token
daemon.log     Daemon startup/request logs
```

`daemon.json` contains the bearer token required by the local HTTP daemon. Prefer
a user-private state directory outside a shared repository checkout. Any local
process that can read this file can intentionally drive the same logged-in
browser session, request uploads from the project chatgpt upload cache, and write
response/artifact caches for the `workspaceDir` supplied by the caller. Under
OpenCode this is the current instance directory unless explicitly overridden. In
repo-local OpenCode config, keep `CHATGPT_WORKSPACE_ROOTS` at the checkout root
instead of a broad parent directory unless you intentionally trust sibling projects.
If roots are omitted, the daemon only accepts its launch cwd as the workspace root.

Older experiments may leave `.chatgpt-poc/sessions.json` with `legacyProjects`.
That file is migration residue; active `#xxxxxxxxxx` sessions live in
`CHATGPT_SESSION_DIR`, not in the daemon state directory.

Current-project artifacts are stored separately from the global session registry:

```text
<current-project>/.opencode/cache/chatgpt/
  responses/
    #4fa92c9d10/
      2026-06-01T10-30-15Z.md
  uploads/
    paper.pdf
    data.csv
  downloads/
    #4fa92c9d10/
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
node chatgpt.js --session-id #4fa92c9d10 "continue the previous research"
node chatgpt.js --raw "Reply exactly: OK"
node chatgpt.js --context "project uses Effect v4" "review this approach"
node chatgpt.js --git "summarize these local changes"
node chatgpt.js --file <upload-staging-dir>\error.log "explain this staged text file"
node chatgpt.js --upload <upload-staging-dir>\file.txt --upload <upload-staging-dir>\notes.docx "analyze these staged files"
node chatgpt.js --save-to-file "write a long research report"
node chatgpt.js --status
node chatgpt.js --stop
```

`--raw` prints tool-oriented output without the CLI `--- RESPONSE ---` framing.
It can still include saved-response metadata, downloads, status, and the stable
`Session: #xxxxxxxxxx` handle that MCP/OpenCode need for continuation.

`--file` reads a staged text file and embeds its contents into the prompt.
`--upload` sends staged files through ChatGPT's attachment UI and should be used
for DOCX/PDF/images, large files, or anything that ChatGPT should inspect as a
file. Both paths must be under `CHATGPT_UPLOAD_ROOTS`; stage external material
there deliberately instead of pointing the root at an entire user profile.

## OpenCode MCP Setup

Use project-local config, for example `.opencode/opencode.jsonc`. Replace the
paths below with your local checkout:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "chatgpt": {
      "type": "local",
      "command": [
        "<absolute-node-executable>",
        "<repo>\\mcp-server.js"
      ],
      "enabled": true,
      "timeout": 690000
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
  "sessionID": "#4fa92c9d10",
  "context": "Optional additional context",
  "git": true,
  "file": ["F:\\absolute\\path\\file.txt", "F:\\absolute\\path\\notes.docx"],
  "saveToFile": true
}
```

`sessionID` is a global short handle for a ChatGPT conversation, such as
`#4fa92c9d10`. Omit it to create a new session; pass an existing ID to continue that
conversation from any OpenCode working directory.

`git: true` attaches `git branch --show-current`, `git status --short`, and
`git diff HEAD` from the OpenCode working directory.

MCP `file` means browser attachment upload, not CLI `--file` text embedding. It
uploads one local file or an array of local files through the ChatGPT attachment
input. Runtime validation resolves both roots and targets through realpath,
only allows files under `<current-project>/.opencode/cache/chatgpt/uploads` plus optional `CHATGPT_UPLOAD_ROOTS`, requires distinct basenames, and
enforces the count, per-file, and aggregate upload caps. It does not require a
specific file extension or type. Content sensitivity is decided by the
caller/OpenCode permission layer, not by filename heuristics in this transport
bridge. Uploads are retried for transient browser frame errors.

`saveToFile: true` saves the text response to the current project cache and
returns only metadata instead of the full response body:

```text
<current-project>/.opencode/cache/chatgpt/responses/<sessionID>/<timestamp>.md
```

Detected ChatGPT sandbox/download files are saved under:

```text
<current-project>/.opencode/cache/chatgpt/downloads/<sessionID>/
```

The model does not control absolute output directories. ChatGPT-generated filenames
are normalized to a short ASCII-safe local name, prefixed with `chatgpt-`, and kept
under the original extension when one survives sanitization. The tool returns saved
and downloaded file paths plus the `Session: #xxxxxxxxxx` handle. The resolved
project cache follows the `workspaceDir` supplied by the MCP wrapper;
`CHATGPT_WORKSPACE_ROOTS` controls which roots that workspace may use. Sandbox artifact
collection is intentionally narrow and selector-based: it attempts currently known
filename-bearing buttons/cards in the latest assistant message, and reports partial
success plus notices when a candidate cannot be discovered or downloaded. Sandbox
files and native images share a 16-artifact count cap and a generous aggregate
byte budget. Upload parsing and artifact download do not have separate fixed local
timeouts; they follow the outer ask/MCP cancellation lifecycle. Generated files are
kept under their original extension; the bridge does not append `.untrusted`.

Native ChatGPT image-generation results are captured separately from sandbox
files. The daemon detects generated-image `estuary/content` image nodes in the
ChatGPT DOM, fetches the image bytes through the logged-in browser context, and
saves them under the same `downloads/<sessionID>/` directory. This covers native
image UI results that do not appear as normal assistant markdown or sandbox file
buttons.

Artifact collection is best-effort. If ChatGPT's download button or native image
node is unavailable, the daemon still returns and saves the assistant text, and
adds a notice about the artifact collection failure instead of failing the whole
request.

Long responses are saved before returning to OpenCode even when `saveToFile` is
omitted. In that case the tool returns a bounded preview, the saved file path,
line count, character count, and `Session: #xxxxxxxxxx`. This avoids OpenCode's own
tool-output truncation path while preserving the complete answer locally.

## Running and Pending Sessions

`sessionID` recovery is conservative. Before sending a new prompt to an existing
session, the daemon loads the ChatGPT conversation and checks the live DOM.

If the session is still generating, or if the previous prompt has no recoverable
assistant response yet, the new prompt is not sent. The tool returns the current
assistant snapshot when available, saves it under the current project's
`responses/<sessionID>/` directory, and reports:

```text
Status: generating
Prompt sent: no
Session: #4fa92c9d10
```

When a later call sees that the stop/generating state has disappeared, it saves
the final assistant text, clears the pending marker, and still does not send the
new prompt in that same call. Call the tool again with the same `sessionID` to
send the next prompt after final recovery. This avoids mixing "recover previous
answer" and "send next instruction" in a single ambiguous operation.

If a request times out after ChatGPT has produced partial assistant text, the
daemon saves that partial text, marks the session pending, and returns
`Status: generating`. If ChatGPT has accepted the user prompt but no assistant
text exists yet, the daemon still marks the session pending and returns
`No assistant text is available yet` instead of allowing a later prompt to be
silently appended to the same unfinished conversation.

## Concurrency

The daemon uses a bounded page pool. Each active `sessionID` is bound to its own
browser page so one long-running session can keep generating while another
session sends a new prompt on a separate page. Calls targeting the same
`sessionID` are still serialized by a per-session lock, so a model cannot append
two prompts to one unfinished ChatGPT conversation. Idle pages are closed when
the pool exceeds `CHATGPT_MAX_SESSION_PAGES`.

New ChatGPT conversations are created through a short create lock because the
Project home composer is shared by the web app. After a conversation has a real
`/c/...` URL, the session can run on its own page. If several sessions are active
and a page does not produce text within `CHATGPT_ASYNC_DETACH_MS`, the daemon
returns `Status: generating` instead of blocking until a hard timeout; the caller
can reuse the same `sessionID` to recover the final response later.

Artifact downloads are serialized because Chrome's download directory is a
browser-context side effect. This prevents sandbox files from different pages
being saved into the wrong session directory while still allowing independent
sessions to generate and answer concurrently.

For short network or host-side failures after a completed response, the daemon also
keeps a short-lived hash of the last completed prompt plus attachment metadata. If
the same `sessionID` receives the same request within `CHATGPT_COMPLETED_RETRY_TTL_MS`,
it replays the saved local snapshot with `Prompt sent: no` instead of appending a
duplicate ChatGPT turn.

## MCP Error Semantics

`mcp-server.js` maps non-zero `chatgpt.js` exits, spawn failures, and timeouts to
MCP tool results with `isError: true`. For `ask`, timeout and browser-context
errors keep the daemon running when a `Session: #xxxxxxxxxx` is available, giving the
core process a chance to mark the session pending for recovery. `status` itself never
sends a ChatGPT prompt, and timeout cleanup avoids stopping the shared daemon while
another `ask` or recovery hold is active. The wrapper never automatically resends a prompt. Successful `ask` calls
return the ChatGPT response text or metadata when the response was saved to file.

The timeout order should be increasing from browser wait to ask HTTP wait to CLI
wrapper to MCP client timeout. This lets the wrapper return a controlled error
before the outer MCP host kills the process.

## Experimental agent.js

`agent.js` is not the primary OpenCode integration path. It is a no-exec CLI
helper that sends one prompt through `chatgpt.js`, optionally with a `--session-id`.
It never reads seed files, runs shell commands, or modifies source files. It may
write ChatGPT response cache files under `.opencode/cache/chatgpt/`, matching the
normal `chatgpt.js` persistence path. It requires explicit `CHATGPT_WORKSPACE_ROOTS`
because it is not launched by OpenCode's per-directory MCP instance wrapper. Local
file access, execution, and code edits should stay in OpenCode's main agent/tool
permission flow.

Do not expose `agent.js` as an MCP tool; the MCP server already provides the
supported OpenCode-facing tool surface.

## Upstream Tracking

Local remotes are intended to be:

```text
origin    https://github.com/SMARK2022/chatgpt-browser-agent-smark.git
upstream  https://github.com/abdallhMoukdad/chatgpt-browser-agent.git
```

Upstream maintenance procedure:

```powershell
git status --short
git fetch upstream --prune --tags
git switch smark/main
git log --oneline --decorate -5
git diff upstream/master...HEAD   # replace with upstream/main if upstream changes default branch
```

Only merge and push after reviewing the upstream diff, confirming the worktree is
clean, confirming no runtime state/request cache/generated artifacts are staged,
and following the repository's branch-protection policy.

## Operational Notes

- This uses the unofficial ChatGPT web UI; selector changes should be fixed in
  `chatgpt-dom.js` rather than scattered through daemon code.
- Same-session calls are serialized by design; different `sessionID` values can
  run on separate pages.
- Artifact downloads are serialized by design because Chrome download behavior is
  browser-context global state.
- Headless mode is not used; the browser runs visibly.
- Dependency hygiene is checked with `npm run audit:registry`; keep browser
  automation dependencies minimal and avoid adding unused stealth/plugin packages.

## License

MIT. See `LICENSE`.
