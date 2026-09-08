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
  -> chatgpt-project.js pure Project/conversation identity policy
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
chatgpt-project.js Pure Unicode/origin/Project/conversation identity policy
chatgpt-dom.js   Single ChatGPT Web DOM adapter for upload/wait/extract/artifacts
mcp-server.js    MCP stdio server for OpenCode and other MCP clients
agent.js         No-exec one-shot ChatGPT helper CLI; no local RUN/FILE actions
```

## Requirements

- Node.js 18 or newer.
- Microsoft Edge or Google Chrome.
- A logged-in ChatGPT account.

The browser executable is auto-detected on Windows, macOS, and Linux. Override it
with `CHATGPT_BROWSER_PATH` if needed.

## Configuration

Runtime behavior is controlled by environment variables:

```text
CHATGPT_BROWSER_PATH              Browser executable path
CHATGPT_BROWSER_USER_DATA_DIR     Browser user-data dir to reuse an existing logged-in profile
CHATGPT_BROWSER_PROFILE_DIRECTORY Browser profile name inside the user-data dir, for example Default
CHATGPT_BROWSER_DEBUG_PORT        Optional fixed DevTools port; omit or set 0 for a random local port
CHATGPT_BROWSER_CDP_URL           Optional http://127.0.0.1:<port> DevTools endpoint to connect
CHATGPT_BROWSER_WS_ENDPOINT       Optional websocket DevTools endpoint to connect
CHATGPT_BROWSER_CONNECT_TIMEOUT_MS DevTools connect preflight timeout, default 3000
CHATGPT_PROJECT                   Fixed ChatGPT Project name, id, or URL
CHATGPT_STATE_DIR                 Browser profile, project cache, daemon, and log directory
CHATGPT_SESSION_DIR               Optional user-level #xxxxxxxxxx session registry directory
CHATGPT_RESPONSE_TIMEOUT_MS       Browser response wait timeout, default 540000
CHATGPT_HTTP_TIMEOUT_MS           Short local daemon HTTP timeout for status/stop, default 30000
CHATGPT_ASK_HTTP_TIMEOUT_MS       Long local daemon HTTP timeout for ask, default 620000
CHATGPT_HTTP_RESPONSE_MAX_BYTES   Local daemon response body cap, default 10485760
CHATGPT_CLI_TIMEOUT_MS            MCP wrapper CLI timeout, default 635000
CHATGPT_MCP_CHILD_OUTPUT_MAX_BYTES Child stdout/stderr cap, default 12582912
CHATGPT_MCP_STDIN_LINE_MAX_BYTES  MCP JSON-RPC line cap before parsing, default 26214400
CHATGPT_MCP_MAX_ACTIVE_CALLS      Concurrent ask cap, default 4
CHATGPT_MCP_TIMEOUT_RECOVERY_HOLD_MS Stop-safety hold after ask timeout, default 120000
CHATGPT_DAEMON_START_TIMEOUT_MS   Daemon startup timeout, default derived from login wait + 60s buffer
CHATGPT_LOGIN_WAIT_TIMEOUT_MS     Login wait window when cookies expire, default 120000. Must stay below CHATGPT_CLI_TIMEOUT_MS
CHATGPT_MAX_RETURN_CHARS          Safe response return threshold, default 6000
CHATGPT_RESPONSE_PREVIEW_CHARS    Preview length returned after local save, default 4000
CHATGPT_MCP_MAX_RETURN_CHARS      Final MCP wrapper output cap, default 8000
CHATGPT_MAX_SESSION_PAGES         Idle page pool cap, default 12
CHATGPT_PENDING_TTL_MS            Stale pending marker TTL, default 43200000
CHATGPT_COMPLETED_RETRY_TTL_MS    Same-prompt completed replay window, default 600000
CHATGPT_JSON_LOCK_TIMEOUT_MS      Session/project JSON lock wait, default 30000
CHATGPT_SESSION_MAX_ENTRIES       Max retained ordinary session entries, default 256
CHATGPT_SESSION_MAX_AGE_MS        Max age for ordinary completed session entries, default 7776000000
CHATGPT_DAEMON_MAX_REQUEST_BYTES  Local daemon /ask body cap, default 26214400
CHATGPT_WORKSPACE_ROOTS           Path-delimited allowlist for response/artifact cache roots; omit to trust caller workspaceDir
CHATGPT_WORKSPACE_DIR             Optional override for current project workspace; normally omit under OpenCode
CHATGPT_UPLOAD_ROOTS              Optional path-delimited upload allowlist; omit to accept user-selected absolute file paths
CHATGPT_MAX_UPLOAD_FILES          Per-request upload file count cap, default 12
CHATGPT_MAX_UPLOAD_BYTES          Per-file upload size cap, default 419430400
CHATGPT_MAX_TOTAL_UPLOAD_BYTES    Per-request aggregate upload cap, default 838860800
CHATGPT_MAX_ARTIFACT_BYTES        Per-response aggregate downloaded artifact cap, default 4294967296
CHATGPT_VOICE_FILE_MAX_BYTES      Voice WAV size cap, default 52428800
CHATGPT_VOICE_TRANSCRIBE_TIMEOUT_MS Complete direct transcription timeout from queue entry, default 80000
CHATGPT_VOICE_PAGE_MAX_AGE_MS     Dedicated voice-page reuse age, default 600000
CHATGPT_TEXT_FILE_MAX_BYTES       CLI --file text size cap, default 2097152
CHATGPT_GIT_DIFF_MAX_CHARS        git diff context cap, default 100000
CHATGPT_MAX_FULL_PROMPT_CHARS     Final prompt cap after expansion, default 500000
```

`CHATGPT_PROJECT` is deployment configuration, not an MCP model parameter. The
daemon resolves it lazily when a new session first needs the default Project; voice
startup and existing sessions with a stored Project identity do not depend on it.
Prefer a short project name such as `MCP` for config migration. A project id or
full Project URL is accepted as a troubleshooting override. Resolution validates an
exact cached candidate before opening the root/sidebar. A transient render, network,
login, or execution-context failure preserves the candidate and returns a diagnostic;
only a stable non-Project route or different Project id triggers live sidebar
rediscovery. A validated replacement atomically replaces the old aliases. Different Project identities with the requested name are rejected instead of
guessing; same-href responsive copies and unrelated duplicate names do not block discovery. Name-only sidebar rows are still rejected when the requested target is ambiguous. A stale explicit id/URL with no discoverable current-account match cannot
be repaired by name, because its URL slug is not treated as a verified display name.

Browser reuse has two modes. If an existing Edge/Chrome was started with a DevTools
port, set `CHATGPT_BROWSER_CDP_URL`, `CHATGPT_BROWSER_WS_ENDPOINT`, or
`CHATGPT_BROWSER_DEBUG_PORT` and the daemon connects to that browser. A normal
already-running Edge window cannot be attached after the fact by Puppeteer. For a
daemon-managed profile, omit `CHATGPT_BROWSER_DEBUG_PORT` (or set it to `0`): the
daemon starts a normal visible Edge process with a random nonzero loopback port, saves
that port in its private state sidecar, then attaches through CDP. This avoids
Chromium's special `--remote-debugging-port=0` automation marker while retaining
persistent cookies across daemon restarts and computer reboots. To reuse a normal
Edge login state without a fixed DevTools port,
set `CHATGPT_BROWSER_USER_DATA_DIR` and `CHATGPT_BROWSER_PROFILE_DIRECTORY`; Chromium
may require closing the regular Edge process using that profile before the daemon can
launch a controlled window.
Connect mode treats the browser as shared: it creates a dedicated bootstrap tab and
never adopts or closes pre-existing/untracked tabs. Launch mode owns its profile and
may reclaim only pages created inside that dedicated browser process. In both private
and externally configured profile modes, the browser is started by the normal Edge or
Chrome executable and then attached through CDP; Puppeteer does not launch the login
browser.

The default state profile is daemon-private. Its `browser-port.json` sidecar lets a
new daemon reconnect after the previous daemon exits without closing the browser;
older profiles can still reconnect through `DevToolsActivePort`. Only a missing
browser triggers a cold start. Cold start opens an internal blank page until CDP is
ready, then the single bootstrap owner navigates to ChatGPT. An endpoint whose
browser is no longer reachable never aborts startup: the daemon records the private
browser's main PID in `browser-pid.json` after every successful acquisition, verifies
the PID command line still carries the daemon's own `--user-data-dir` (a reused PID
is never touched), clears stale sidecars/lock leftovers, and completes the cold spawn.
Without a PID record the leftovers are treated as stale the same way.
Normal owned shutdown uses CDP `Browser.close` and never force-kills Edge; the
termination path above is reserved for browsers whose DevTools endpoint is already
unreachable. A fixed
`CHATGPT_BROWSER_DEBUG_PORT` preserves ownership across daemon crashes only when
the current CDP browser PID, port, and profile match the daemon's private owner
record; unknown endpoints remain shared and are never closed.

`CHATGPT_SESSION_DIR` stores the internal global session registry keyed by short
handles such as `#4fa92c9d10`. Entries include the ChatGPT conversation URL, Project
metadata, timestamps, and pending recovery state. If omitted, the default
user-level opencode data directory is used, for example
`%LOCALAPPDATA%\opencode\chatgpt-browser-agent` on Windows.
New sessions must expose `/g/{project}/c/{conversation}` before they are recorded.
For registries created by older releases, a plain `/c/{conversation}` entry remains
usable only when it already carries the same stored Project id and every later
navigation preserves that exact conversation id; plain routes are never accepted
for newly created sessions and never establish Project ownership by themselves.

`CHATGPT_PENDING_TTL_MS` controls how long a pending session is considered fresh
for page retention and automatic recovery. Stale pending markers still get one
live DOM recovery attempt before being cleared. New pending markers retain the
pre-submit user/assistant turn counts, so an older visible assistant message cannot
be returned as the answer to a prompt whose accepted turn has not advanced. Old ordinary session entries are
retained by `CHATGPT_SESSION_MAX_ENTRIES` (default `256`) and
`CHATGPT_SESSION_MAX_AGE_MS` (default 90 days). Corrupt `sessions.json` backups use
the same private file mode and age-based cleanup. Conversation URLs are still local
private metadata; remove the user-level state directory only when you intentionally
want to forget all ChatGPT session handles.

The state directory contains:

```text
profile\       Dedicated browser profile
projects.json  Resolved Project name/id/url cache
browser-owner.json  PID/profile/port ownership for fixed-debug-port recovery
daemon.json    Current daemon pid, port, and local bearer token
daemon.log     Daemon startup/request logs
```

Login state is stored in the browser profile, not in `opencode.json` or the MCP
tool schema. Copying MCP JSON to another machine only migrates configuration; it
does not migrate ChatGPT cookies. The profile under `CHATGPT_STATE_DIR\profile`
or a profile selected by `CHATGPT_BROWSER_USER_DATA_DIR` contains browser cookie
databases that Chrome/Edge encrypt through the operating-system account store,
such as Windows DPAPI or macOS Keychain. Copying that profile across operating
systems or users is therefore not a reliable login transfer and should be treated
as copying credentials.

For a new machine, the supported path is: copy the MCP config, install the
project, then run `node chatgpt.js --login` once. To reuse a browser already
logged in on that machine, point `CHATGPT_BROWSER_USER_DATA_DIR` and
`CHATGPT_BROWSER_PROFILE_DIRECTORY` at that local browser profile, or attach to a
browser started with a DevTools port through `CHATGPT_BROWSER_CDP_URL`.

`daemon.json` contains the bearer token required by the local HTTP daemon. Prefer
a user-private state directory outside a shared repository checkout. Any local
process that can read this file can intentionally drive the same logged-in
browser session, request uploads from the project chatgpt upload cache, and write
response/artifact caches for the `workspaceDir` supplied by the caller. Under
OpenCode this is the current instance directory unless explicitly overridden.

When `CHATGPT_WORKSPACE_ROOTS` is omitted, the daemon accepts the caller-supplied
`workspaceDir` so one user-level browser daemon can serve multiple OpenCode TUI
instances without pinning cache writes to the first project that started it. To
turn this into a stricter deployment boundary, set `CHATGPT_WORKSPACE_ROOTS` to
one or more trusted roots; in repo-local config, prefer the checkout root instead
of a broad parent directory unless you intentionally trust sibling projects.

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

If login cookies expire during use, the daemon will keep the browser window open
and wait for you to log in again (default 2 minutes). Email/password login works
directly; for Google OAuth, close the window and run `node chatgpt.js --login`
instead.

## CLI Usage

```powershell
node chatgpt.js "explain this error"
node chatgpt.js --session-id #4fa92c9d10 "continue the previous research"
node chatgpt.js --raw "Reply exactly: OK"
node chatgpt.js --context "project uses Effect v4" "review this approach"
node chatgpt.js --git "summarize these local changes"
node chatgpt.js --file <absolute-directory-path>\error.log "explain this local text file"
node chatgpt.js --upload <absolute-directory-path>\file.txt --upload <absolute-directory-path>\notes.docx "analyze these local files"
node chatgpt.js --save-to-file "write a long research report"
node chatgpt.js --status
node chatgpt.js --stop
```

`--raw` prints tool-oriented output without the CLI `--- RESPONSE ---` framing.
It can still include saved-response metadata, downloads, status, and the stable
`Session: #xxxxxxxxxx` handle that MCP/OpenCode need for continuation.

`--file` reads a local UTF-8 text file and embeds its contents into the prompt.
`--upload` sends local files through ChatGPT's attachment UI and should be used
for DOCX/PDF/images, large files, or anything that ChatGPT should inspect as a
file. Paths are unrestricted by default. Set `CHATGPT_UPLOAD_ROOTS` only when a
deployment needs an explicit allowlist. File contents leave the local machine,
so callers must upload only files the user explicitly selected and must not infer
sensitive paths.

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
  "mode": "image",
  "imageAspectRatio": "wide",
  "saveToFile": true
}
```

`sessionID` is a global short handle for a ChatGPT conversation, such as
`#4fa92c9d10`. Omit it to create a new session; pass an existing ID to continue that
conversation from any OpenCode working directory.

`git: true` attaches `git branch --show-current`, `git status --short`, and
`git diff HEAD` from the OpenCode working directory.

`mode` adds a semantic workflow instruction to the prompt. Supported values are
`auto` and `image`. Use `auto` for normal text, research, file,
sandbox, and document tasks; put any web-search/source requirement directly in
`prompt`. Use `image` only for native ChatGPT image generation.

Only `auto` and `image` are exposed. Other ChatGPT UI modes are intentionally not
part of this MCP API. The bridge keeps Project sessions in Chat and never selects
Work. It also inherits the model and reasoning level already selected by the user
or Project (for example GPT-5.6 Sol with High reasoning) instead of exposing a
second brittle model-selector API.

`imageAspectRatio` is optional and only applies to native ChatGPT image generation.
If it is provided without `mode`, the bridge infers `mode: "image"`. When the live
ChatGPT UI changes, the bridge does not chase its transient ratio menus; the ratio
travels in the image workflow prompt. Supported values are:

```text
auto       -> 自动
square     -> 方形 1:1
portrait   -> 竖版 3:4
story      -> 故事版 9:16
landscape  -> 横版 4:3
wide       -> 宽屏 16:9
```

This is useful when OpenCode needs predictable visual artifacts: square icons,
wide architecture diagrams, portrait posters, or story-sized mobile mockups. The
ratio selector stays separate from `mode` so normal text, analysis, and research
calls do not inherit image-generation state.

Web citations are extracted from ChatGPT's citation-pill DOM whenever ChatGPT uses
web/source lookup in auto mode. ChatGPT may show sources as site-name pills
rather than literal `[1]` text, so the bridge converts those pills into local
`[Ref n]` markers and appends a `References` section with the source URLs. This
avoids relying on the browser clipboard copy button, which is not stable under
automation and would modify the user's system clipboard.

MCP `file` means browser attachment upload, not CLI `--file` text embedding. It
uploads one local file or an array of local files through the ChatGPT attachment
input. By default it accepts any user-selected absolute regular-file path. If
`CHATGPT_UPLOAD_ROOTS` is configured, every file must remain under one of those
explicit roots. Runtime validation still resolves targets through realpath,
requires distinct basenames, and enforces the count, per-file, and aggregate
upload caps. It does not require a specific file extension or type. Because file
contents are sent to ChatGPT, the caller must not infer sensitive paths; content
approval remains the caller/OpenCode permission layer's responsibility. Uploads
are retried for transient browser frame errors.

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
and downloaded file paths plus the `Session: #xxxxxxxxxx` handle. Response and
artifact caches follow the `workspaceDir` supplied by the MCP wrapper;
`CHATGPT_WORKSPACE_ROOTS` controls which roots that workspace may use. Sandbox artifact
collection is intentionally narrow and selector-based: it attempts currently known
filename-bearing buttons/cards in the latest assistant message, and reports partial
success plus notices when a candidate cannot be discovered or downloaded. Sandbox
files and native images share a 16-artifact count cap and a generous aggregate
byte budget. Artifact downloads inherit the outer browser response budget and are
cancelled earlier after 30 seconds without any file/byte progress, so one broken
download cannot retain the browser-wide queue indefinitely. Generated files are
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

## Voice lifecycle

`transcribe-file` starts or reuses the Edge/profile daemon without opening a
Project page. Before audio upload, the runtime acquires either an idle daemon-owned
Session page or a dedicated voice page. The DOM adapter reads the page's single
`#client-bootstrap` source and classifies it as authenticated, logged out, loading,
or inconsistent without returning credentials. A newly created or navigated voice
page first receives a bounded terminal-convergence wait; an already converged page
then requires two consecutive authenticated snapshots at the exact
`https://chatgpt.com` origin. This prevents normal React composer hydration from
consuming the one pre-upload page-renewal allowance.

Daemon startup also waits for bootstrap and composer facts to agree. A logged-out
page remains open for manual login without refreshing. A persistently mixed page
may be reloaded once before daemon readiness; it never enters a reload loop. The
direct request reads the current bootstrap access token inside the same page task and
sends the web client's `SendIfAvailable` Bearer header together with same-origin
cookies. The token is never returned to Node, status, or logs.

The same-origin direct endpoint is the only transcription success path. HTTP,
transport, origin, and response-shape failures never switch to another algorithm or
opening the composer, installing a fake microphone, navigating, or bringing Edge to
the foreground. One CLI transaction retries the same authenticated direct path up
to three times after the initial attempt for rate-limit, server, transport, page,
browser, or daemon runtime failures, with 1/2/4 second delays. Login, token,
deterministic 4xx, invalid response, local input, and cancellation errors return
immediately. Each daemon request settles or isolates its page before the next
attempt. Shared-CDP shutdown only disconnects; owned browsers close gracefully.

## Concurrency

The daemon uses a bounded page pool. Each active `sessionID` is bound to its own
browser page so one long-running session can keep generating while another
session sends a new prompt on a separate page. Calls targeting the same
`sessionID` are still serialized by a per-session lock, so a model cannot append
two prompts to one unfinished ChatGPT conversation. Idle pages are closed when
the pool exceeds `CHATGPT_MAX_SESSION_PAGES`.

New ChatGPT conversations are created through a short create lock because the
Project home composer is shared by the web app. After a conversation has a real
`/c/...` URL, the session runs on its own page and waits normally. The daemon only
returns `Status: generating` when the caller disconnects, the outer timeout is hit,
or ChatGPT is still visibly processing; the caller can reuse the same `sessionID`
to recover the final response later.

Voice direct uploads and ask composer acceptance also share one short submission
queue. An ask releases it after the accepted user turn has a trusted `/c/...` URL,
before assistant generation and artifact collection, so those longer waits remain
concurrent. Cancellation before queue ownership performs no upload, and a failed submission
still advances the queue before the CLI may start the next approved voice attempt.
Ask prompts are never retried.

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
