#!/usr/bin/env node

/**
 * chatgpt.js — ChatGPT Web bridge 的 CLI/client 层
 *
 * 这个文件承担本地 client 侧职责：解析命令行或 MCP 写入的 JSON payload，
 * 组装完整 prompt，管理 daemon 的本地连接/启动锁/版本探活，并通过带 bearer
 * token 的 HTTP 请求调用 daemon。它不碰 ChatGPT DOM、不决定 pending 恢复策略，
 * 也不下载 artifact；这些职责分别在 chatgpt-core.js 和 chatgpt-dom.js 中维护。
 *
 * Usage:
 *   node chatgpt.js --login
 *   node chatgpt.js "prompt"
 *   node chatgpt.js --session-id #4fa92c9d10 "continue"
 *   node chatgpt.js --upload file.docx --save-to-file "review this"
 *   node chatgpt.js --request-json - --raw
 */


'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const readline = require('readline');
const crypto = require('crypto');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

// ─── Constants and System Prompt ──────────────────────────────────────────────

const CHATGPT_URL = 'https://chatgpt.com';
const CHROME_PATH = process.env.CHATGPT_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const STATE_DIR = path.resolve(process.env.CHATGPT_STATE_DIR || defaultStateDir());
const PROFILE_DIR = path.join(STATE_DIR, 'profile');
const BROWSER_USER_DATA_DIR = path.resolve(process.env.CHATGPT_BROWSER_USER_DATA_DIR || PROFILE_DIR);
const BROWSER_PROFILE_DIRECTORY = process.env.CHATGPT_BROWSER_PROFILE_DIRECTORY || '';
const BROWSER_DEBUG_PORT = Number.parseInt(process.env.CHATGPT_BROWSER_DEBUG_PORT || '', 10);
const BROWSER_CDP_URL = process.env.CHATGPT_BROWSER_CDP_URL || (Number.isFinite(BROWSER_DEBUG_PORT) && BROWSER_DEBUG_PORT > 0 ? `http://127.0.0.1:${BROWSER_DEBUG_PORT}` : '');
const BROWSER_WS_ENDPOINT = process.env.CHATGPT_BROWSER_WS_ENDPOINT || '';
const DAEMON_FILE = path.join(STATE_DIR, 'daemon.json');
const DAEMON_LOCK_FILE = path.join(STATE_DIR, 'daemon.lock');
const DAEMON_LOG = path.join(STATE_DIR, 'daemon.log');
const DEFAULT_PROJECT = process.env.CHATGPT_PROJECT || process.env.CHATGPT_PROJECT_NAME || process.env.CHATGPT_PROJECT_URL || 'MCP';
const DAEMON_VERSION = 17;
const DAEMON_START_TIMEOUT = positiveIntEnv('CHATGPT_DAEMON_START_TIMEOUT_MS', 60_000);
const BROWSER_CONNECT_TIMEOUT_MS = positiveIntEnv('CHATGPT_BROWSER_CONNECT_TIMEOUT_MS', 3_000);
const HTTP_TIMEOUT = positiveIntEnv('CHATGPT_HTTP_TIMEOUT_MS', 30_000);
const ASK_HTTP_TIMEOUT = positiveIntEnv('CHATGPT_ASK_HTTP_TIMEOUT_MS', 620_000);
const HTTP_RESPONSE_MAX_BYTES = positiveIntEnv('CHATGPT_HTTP_RESPONSE_MAX_BYTES', 10 * 1024 * 1024);
const MAX_TEXT_FILE_BYTES = positiveIntEnv('CHATGPT_TEXT_FILE_MAX_BYTES', 2 * 1024 * 1024);
const MAX_GIT_DIFF_CHARS = positiveIntEnv('CHATGPT_GIT_DIFF_MAX_CHARS', 100_000);
const MAX_REQUEST_JSON_BYTES = positiveIntEnv('CHATGPT_DAEMON_MAX_REQUEST_BYTES', 25 * 1024 * 1024);
const MAX_FULL_PROMPT_CHARS = positiveIntEnv('CHATGPT_MAX_FULL_PROMPT_CHARS', 500_000);
const MAX_UPLOAD_FILES = positiveIntEnv('CHATGPT_MAX_UPLOAD_FILES', 12);
const MAX_UPLOAD_BYTES = positiveIntEnv('CHATGPT_MAX_UPLOAD_BYTES', 400 * 1024 * 1024);
const MAX_TOTAL_UPLOAD_BYTES = positiveIntEnv('CHATGPT_MAX_TOTAL_UPLOAD_BYTES', 800 * 1024 * 1024);
const EXPLICIT_UPLOAD_ROOTS = uploadRoots();
let activeStartLock = null;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    // 外层 MCP/终端超时会直接杀 CLI；这里尽力释放自己持有的启动锁，避免下一次 ask 被旧锁拖满超时。
    if (activeStartLock) releaseDaemonStartLock(activeStartLock.fd, activeStartLock.token);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

// CLI 层只负责给 ChatGPT 拼“外部助手”身份，不在这里写浏览器状态机规则；
// 状态机规则必须留在 core，避免 prompt 文案和本地 pending/retry 行为互相污染。
const SYSTEM_PROMPT = `\
You are ChatGPT working as an external web, source-gathering, analysis, and artifact helper for OpenCode.

Use the provided context first. Use web/source lookup for current facts, docs, issues,
repositories, or claims that need evidence; keep source markers next to the
claims they support. Use sandbox/data-analysis or file-generation tools when the
task benefits from computation, fitting, tables, documents, or downloadable
artifacts. When local commands or edits are relevant, describe the recommendation
for the main OpenCode agent to perform; this browser bridge is not the local
executor.

Prioritize:
- accurate, current answers grounded in evidence;
- practical debugging and implementation guidance;
- broad ecosystem, documentation, issue, and repository research when useful;
- appropriate use of web/source lookup, data-analysis, sandbox, native image,
  and file-generation tools;
- concrete tradeoffs, risks, commands, code, or next steps when they help.

Return the most useful result for the task: concise for simple answers, detailed
for investigations, and explicit about uncertainty when evidence is incomplete.
---
`;

// ─── Input Assembly ───────────────────────────────────────────────────────────

function positiveIntEnv(name, fallback) {
  // 环境变量是部署层配置，解析失败时回到代码默认值；不要把无效值继续传给超时逻辑。
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function uploadRoots() {
  const value = process.env.CHATGPT_UPLOAD_ROOTS || '';
  return value.split(path.delimiter).map(item => item.trim()).filter(Boolean).map(item => path.resolve(item));
}

function defaultUploadRoot(workspaceDir) {
  // 默认 staging 与 responses/downloads 同根，避免项目外再散落 opencode-chatgpt-uploads 这类目录。
  return path.join(path.resolve(workspaceDir || process.cwd()), '.opencode', 'cache', 'chatgpt', 'uploads');
}

function defaultStateDir() {
  // 默认状态目录不能落在插件 checkout：daemon.json 是本地 bearer token，profile 里也有登录态浏览器数据。
  // 显式配置仍可覆盖此路径；默认值只选择用户级 opencode 数据区，降低误提交和被全文搜索扫到的概率。
  // 有些 OpenCode 部署会把 OPENCODE_DATA_DIR 指到项目内；这里回退用户目录，避免默认把 daemon token 写进 checkout。
  if (process.env.OPENCODE_DATA_DIR && !runtimeUnsafeRoots().some(root => isInside(root, process.env.OPENCODE_DATA_DIR))) return path.join(process.env.OPENCODE_DATA_DIR, 'chatgpt-browser-agent', 'state');
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'opencode', 'chatgpt-browser-agent', 'state');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'chatgpt-browser-agent', 'state');
}

function runtimeUnsafeRoots() {
  // cwd 可能不是 OpenCode workspace；显式 workspace env 也要参与 OPENCODE_DATA_DIR 的项目内判定。
  return [process.cwd(), __dirname, process.env.CHATGPT_WORKSPACE_DIR, ...(process.env.CHATGPT_WORKSPACE_ROOTS || '').split(path.delimiter)].filter(Boolean).map(item => path.resolve(item));
}

function normalizePathList(value) {
  // MCP 的 file 可以是字符串或数组；CLI 后续只处理数组，避免每个调用点重复判断类型。
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map(item => String(item || '').trim()).filter(Boolean);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createSessionID() {
  return `#${crypto.randomBytes(5).toString('hex')}`;
}

function readStdin() {
  // 只有真正有管道输入时才读取 stdin；交互式终端不能阻塞，否则普通 `node chatgpt.js "..."` 会卡住。
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data, 'utf8') > MAX_FULL_PROMPT_CHARS) process.stdin.destroy(new Error(`stdin exceeds ${MAX_FULL_PROMPT_CHARS} bytes`));
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(data.trim() || null));
  });
}

function readFile(filePath) {
  // `--file` 是“把文本粘进 prompt”，不是附件上传；二进制/大型文件应走 `--upload`。
  // 但它同样会把本地内容发给 ChatGPT，所以复用 upload root 和大小边界；敏感性审批留给主 agent。
  const abs = path.resolve(filePath);
  const real = fs.realpathSync.native(abs);
  if (!realUploadRoots().some(root => isInside(root, real))) throw new Error(`Text file is outside allowed roots: ${filePath}`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`Text path is not a regular file: ${filePath}`);
  if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error(`Text file is too large for --file; use --upload instead: ${real}`);
  const bytes = fs.readFileSync(real);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`Text file is not valid UTF-8; use --upload instead: ${real}`); }
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realUploadRoots(workspaceDir) {
  return [...EXPLICIT_UPLOAD_ROOTS, defaultUploadRoot(workspaceDir)].map(root => {
    try { return fs.realpathSync.native(root); }
    catch { throw new Error(`Upload root does not exist: ${root}`); }
  });
}

function validateUploadPaths(files, workspaceDir) {
  // CLI --upload 和 MCP file 使用同一套机械边界；主 agent 决定“是否应上传”，这里不做内容语义审批。
  const list = normalizePathList(files);
  if (list.length > MAX_UPLOAD_FILES) throw new Error(`Upload accepts at most ${MAX_UPLOAD_FILES} files`);
  const safe = list.map(file => {
    const abs = path.resolve(file);
    const real = fs.realpathSync.native(abs);
    if (!realUploadRoots(workspaceDir).some(root => isInside(root, real))) throw new Error(`Upload file is outside allowed roots: ${file}`);
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error(`Upload path is not a regular file: ${file}`);
    // 不按扩展名判断“可上传性”：OpenCode 侧已经负责读取/外发许可，bridge 只做路径和体量边界。
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`Upload file is too large: ${file}; limit is ${MAX_UPLOAD_BYTES} bytes`);
    return real;
  });
  const uploadBytes = safe.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  // ChatGPT composer 只展示文件名；同名不同路径无法可靠区分，直接拒绝比猜测 attachment id 更安全。
  assertUniqueBasenames(safe);
  // 浏览器上传的瓶颈是“本次调用总量”，不是单个文件；多文件合计也必须受同一预算约束。
  if (uploadBytes > MAX_TOTAL_UPLOAD_BYTES) throw new Error(`Total upload size is too large; limit is ${MAX_TOTAL_UPLOAD_BYTES} bytes`);
  return safe;
}

function assertUniqueBasenames(files) {
  const names = files.map(file => path.basename(file).toLowerCase());
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error(`Upload files must have distinct basenames because ChatGPT composer identifies attachments by filename: ${duplicate}`);
}

function getGitContext(cwd) {
  // git 只作为输入上下文读取，不修改 index/working tree；失败时保持静默，最后统一判断是否有内容。
  const run = args => { try { return execFileSync('git', args, { encoding: 'utf8', cwd, windowsHide: true, maxBuffer: Math.max(1024 * 1024, MAX_GIT_DIFF_CHARS * 4) }).trim(); } catch { return ''; } };
  if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') throw new Error('Not inside a git repo.');
  const branch = run(['branch', '--show-current']) || run(['rev-parse', '--short', 'HEAD']);
  const status = run(['status', '--short']);
  const diff = run(['--no-pager', '-c', 'diff.external=', '-c', 'core.externalDiff=false', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD']);
  const boundedDiff = diff.length > MAX_GIT_DIFF_CHARS
    ? `${diff.slice(0, MAX_GIT_DIFF_CHARS)}\n\n[Git diff truncated locally at ${MAX_GIT_DIFF_CHARS} characters.]`
    : diff;
  return [branch ? `Branch: ${branch}\n` : '', status ? `\nStatus:\n${status}\n` : '', boundedDiff ? `\nDiff:\n${boundedDiff}\n` : ''].join('');
}

/**
 * 把所有本地上下文折叠成一个 prompt。
 *
 * 顺序是这个函数最重要的契约：system prompt 先给 ChatGPT 一个“外部助手”
 * 身份，随后是可选 context/git/file/stdin，最后才是用户任务。这样做能避免
 * 本地材料里的句子被误当成最新指令，同时也让 web 检索、sandbox 分析和附件
 * 审阅都围绕同一个明确任务展开。
 */
function buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData, mode, imageAspectRatio }) {
  const parts = [SYSTEM_PROMPT];
  const hint = workflowHint(mode, imageAspectRatio);
  if (hint) parts.push(hint);
  if (contextData) parts.push(`Context:\n${contextData}\n`);
  if (gitData) parts.push(`Git context:\n${gitData}\n`);
  if (fileData) parts.push(fencedBlock('File content', fileData));
  if (stdinData) parts.push(fencedBlock('Input', stdinData));
  parts.push(`Task: ${userPrompt}`);
  const prompt = parts.join('\n');
  if (prompt.length > MAX_FULL_PROMPT_CHARS) throw new Error(`Full prompt is too large after context expansion; limit is ${MAX_FULL_PROMPT_CHARS} characters`);
  return prompt;
}

function workflowHint(mode, imageAspectRatio) {
  // 这些提示只解释“本地已经切好的 ChatGPT UI 模式”，不替用户改写任务；auto 模式保留 ChatGPT 自主检索能力。
  if (mode === 'image') return `Mode: native ChatGPT image generation${imageAspectRatio ? `, aspect ratio=${imageAspectRatio}` : ''}. Produce the requested image, not code or a sandbox artifact, unless the user explicitly asks otherwise. The bridge will save generated images when ChatGPT exposes them.\n`;
  return null;
}

function fencedBlock(label, text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${label}:\n${fence}\n${text}\n${fence}\n`;
}

// ─── Daemon Client ────────────────────────────────────────────────────────────

function readDaemonState() {
  if (!fs.existsSync(DAEMON_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
    process.kill(state.pid, 0); // 仅探测 PID 是否存活；不会终止进程。
    return state;
  } catch {
    return null;
  }
}

function httpJSON(daemon, method, endpoint, body, timeout = HTTP_TIMEOUT) {
  // CLI 与 daemon 只用本地 HTTP JSON 通信。这里保持很薄，不解释业务字段，避免和 core 的 /ask 语义重复。
  return new Promise((resolve, reject) => {
    const state = typeof daemon === 'object' ? daemon : { port: daemon };
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const req = http.request({
      hostname: '127.0.0.1',
      port: state.port,
      path: endpoint,
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    }, res => {
      let raw = '';
      res.on('data', chunk => {
        raw += chunk;
        if (Buffer.byteLength(raw, 'utf8') > HTTP_RESPONSE_MAX_BYTES) req.destroy(new Error(`Daemon response exceeded ${HTTP_RESPONSE_MAX_BYTES} bytes`));
      });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { reject(new Error('Invalid JSON from daemon')); return; }
        if (res.statusCode >= 400) reject(new Error(parsed.error || `Daemon HTTP ${res.statusCode}`));
        else resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`Daemon HTTP request timed out after ${timeout}ms`)));
    if (data) req.write(data);
    req.end();
  });
}

async function isDaemonReachable(state) {
  try {
    // /ping 不带 bearer token，只校验 daemonID；确认身份后才会把 token 发给 /status 或 /stop。
    if (!state.daemonID) return false;
    const status = await httpJSON({ port: state.port }, 'GET', `/ping?daemonID=${encodeURIComponent(state.daemonID)}`, undefined, 3_000);
    return status.ok === true;
  }
  catch { return false; }
}

async function acquireDaemonStartLock() {
  ensureStateDirForDaemon();
  const deadline = Date.now() + DAEMON_START_TIMEOUT;
  while (Date.now() < deadline) {
    const state = readDaemonState();
    if (state?.version === DAEMON_VERSION && await isDaemonReachable(state)) return { state };
    try {
      const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
      const fd = fs.openSync(DAEMON_LOCK_FILE, 'wx');
      fs.writeFileSync(fd, token, 'utf8');
      return { fd, token };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (isStaleLock(DAEMON_LOCK_FILE, DAEMON_START_TIMEOUT)) fs.unlinkSync(DAEMON_LOCK_FILE);
      } catch {}
      await sleep(500);
    }
  }
  throw new Error(`Timed out waiting for daemon startup lock. Check log: ${DAEMON_LOG}`);
}

function isStaleLock(file, maxAge) {
  // 只看 mtime 会误删调试/重负载中的活锁；pid 仍存活时继续等待，避免双 daemon 启动。
  if (Date.now() - fs.statSync(file).mtimeMs <= maxAge) return false;
  const pid = Number((fs.readFileSync(file, 'utf8').split(':')[0] || '').trim());
  return !pid || !isProcessAlive(pid);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

async function assertBrowserReuseCanStart() {
  // 父进程先做可观测 preflight：普通 Edge 占着 Default profile 且没有 CDP 时，daemon 子进程只会悬挂到启动超时。
  if (!usesExternalBrowserProfile() || BROWSER_WS_ENDPOINT || !BROWSER_CDP_URL || await devtoolsPortReachable(BROWSER_CDP_URL)) return;
  if (browserProfileLooksLocked()) throw new Error(`Configured Edge profile is already open but no DevTools endpoint is reachable at ${BROWSER_CDP_URL}. Restart Edge with --remote-debugging-port=${BROWSER_DEBUG_PORT || 9222}, set CHATGPT_BROWSER_CDP_URL/CHATGPT_BROWSER_WS_ENDPOINT, or close Edge before asking. Profile: ${BROWSER_USER_DATA_DIR}`);
}

function usesExternalBrowserProfile() {
  // 默认 profile 是插件私有目录；只有显式指向 Edge User Data 时，才需要考虑“现有浏览器占用”。
  return path.resolve(BROWSER_USER_DATA_DIR) !== path.resolve(PROFILE_DIR);
}

function browserProfileLooksLocked() {
  // lockfile 不是完美锁，但足够做启动前提示：真正启动仍由 Chromium 自己做最终裁决。
  return ['lockfile', 'SingletonLock'].some(name => fs.existsSync(path.join(BROWSER_USER_DATA_DIR, name)));
}

async function devtoolsPortReachable(browserURL) {
  try {
    const url = new URL(browserURL);
    await tcpConnect(url.hostname || '127.0.0.1', Number(url.port || 80));
    return true;
  } catch {
    return false;
  }
}

function tcpConnect(host, port) {
  // 只探测 TCP，不发 HTTP 请求；目标是快速判断 DevTools 端口是否存在，避免 Puppeteer.connect 长时间悬挂。
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, BROWSER_CONNECT_TIMEOUT_MS);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('error', err => { clearTimeout(timer); reject(err); });
  });
}

function releaseDaemonStartLock(fd, token) {
  try { if (fd !== undefined) fs.closeSync(fd); } catch {}
  try {
    if (fs.existsSync(DAEMON_LOCK_FILE) && fs.readFileSync(DAEMON_LOCK_FILE, 'utf8') === token) fs.unlinkSync(DAEMON_LOCK_FILE);
  } catch {}
}

function unlinkDaemonFiles() {
  for (const file of [DAEMON_FILE, path.join(STATE_DIR, 'daemon.run.json')]) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  }
}

function ensureStateDirForDaemon() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STATE_DIR, 0o700); } catch {}
}

/**
 * 读取本次启动之后追加的 daemon.log 错误。
 *
 * daemon 子进程启动失败只能写日志，父进程看不到异常栈；按 offset 读取能避免旧的
 * Startup error 误杀新启动，也让“未登录/项目不存在”这类失败在数秒内返回给 MCP。
 */
function daemonStartupErrorSince(offset) {
  try {
    const text = fs.readFileSync(DAEMON_LOG, 'utf8').slice(offset);
    const line = text.split(/\r?\n/).find(line => line.includes('Startup error:'));
    return line ? line.replace(/^.*Startup error:\s*/, 'Daemon startup failed: ') : null;
  } catch { return null; }
}

/**
 * 确保本地 browser daemon 已经可用，并返回端口与本地 bearer token。
 *
 * daemon.json 只是一个快速索引，不是可信真相；每次读取都用 process.kill(pid, 0)
 * 探测 PID 是否仍存活。若用户手动关掉 daemon 或浏览器导致状态文件过期，这里会
 * 删除旧文件并重新启动，而不是把“stopped”错误直接暴露给 MCP 调用方。
 */
async function ensureDaemon() {
  let state = readDaemonState();
  if (state && state.version !== DAEMON_VERSION) {
    await httpJSON(state, 'POST', '/stop', {}, 3_000).catch(() => {});
    unlinkDaemonFiles();
    state = null;
  }
  if (state && await isDaemonReachable(state)) return state;

  await assertBrowserReuseCanStart();

  const acquired = await acquireDaemonStartLock();
  if (acquired.state) return acquired.state;
  activeStartLock = acquired;

  try {
    state = readDaemonState();
    if (state && await isDaemonReachable(state)) return state;
    unlinkDaemonFiles(); // 清理上次崩溃留下的过期端口文件。
    process.stderr.write('[*] Starting browser daemon (first time ~15s)...\n');
    const logOffset = fs.existsSync(DAEMON_LOG) ? fs.statSync(DAEMON_LOG).size : 0;

    const child = spawn(process.execPath, [__filename, '--daemon-internal'], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env } });
    child.unref();

    const deadline = Date.now() + DAEMON_START_TIMEOUT;
    while (Date.now() < deadline) {
      await sleep(1_000);
      state = readDaemonState();
      if (state && await isDaemonReachable(state)) {
        await sleep(300); // 给 HTTP server 一小段时间完成端口绑定。
        process.stderr.write('[*] Daemon ready.\n');
        return state;
      }
      const startupError = daemonStartupErrorSince(logOffset);
      if (startupError) throw new Error(`${startupError} Check log: ${DAEMON_LOG}`);
    }
    throw new Error(`Daemon did not start. Check log: ${DAEMON_LOG}`);
  } finally {
    releaseDaemonStartLock(acquired.fd, acquired.token);
    if (activeStartLock === acquired) activeStartLock = null;
  }
}

// ─── Login Flow ───────────────────────────────────────────────────────────────

function waitForEnter(prompt) {
  // 登录流程需要用户确认“已经在普通浏览器里完成登录”；这里是唯一保留的 CLI 交互点。
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function login() {
  // 登录必须走普通浏览器进程而不是 Puppeteer 控制页；配置现有 user data dir 时，会复用日常 Edge 登录态。
  console.log('[*] Opening browser for manual login...');
  spawn(CHROME_PATH, browserLoginArgs(projectURL(DEFAULT_PROJECT) || CHATGPT_URL), { detached: true, stdio: 'ignore' }).unref();
  console.log('');
  console.log('  Log in to chatgpt.com in the browser window that opened.');
  console.log('  This login window is not controlled by Puppeteer, so Google OAuth');
  console.log('  is less likely to reject it as an insecure browser.');
  console.log('  When fully logged in and the chat interface is visible, close the browser window.');
  await waitForEnter('  Then press Enter here: ');
  console.log('[*] Done. Run: node chatgpt.js "your prompt here"');
}

function browserLoginArgs(url) {
  // --login 与 daemon 使用同一套浏览器 profile 参数；否则登录进 A profile，自动化却启动 B profile。
  // debug port 只在浏览器从这里启动时生效，普通已运行 Edge 不能事后被这行参数改造成可连接浏览器。
  return [
    `--user-data-dir=${BROWSER_USER_DATA_DIR}`,
    BROWSER_PROFILE_DIRECTORY ? `--profile-directory=${BROWSER_PROFILE_DIRECTORY}` : null,
    Number.isFinite(BROWSER_DEBUG_PORT) && BROWSER_DEBUG_PORT > 0 ? `--remote-debugging-port=${BROWSER_DEBUG_PORT}` : null,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    url,
  ].filter(Boolean);
}

// ─── CLI Argument Model ───────────────────────────────────────────────────────

function projectURL(value) {
  // 登录入口只需要一个可打开的 URL；完整 Project 解析、缓存和发现仍由 core 负责。
  const input = String(value || '').trim();
  if (/^https?:\/\//i.test(input)) return input;
  const token = input.match(/^(g-p-[a-f0-9]+(?:-[a-z0-9-]+)?)$/i)?.[1];
  return token ? `${CHATGPT_URL}/g/${token}/project` : null;
}

function parseArgs(argv) {
  // 参数解析只做机械映射，不做业务校验；真正的会话、上传和保存策略由 daemon 统一判断。
  const args = argv.slice(2);
  const opts = { login: false, file: null, upload: [], git: false, context: null, stop: false, status: false, raw: false, saveToFile: false, sessionID: null, newSession: false, daemonInternal: false, cwd: null, workspace: null, requestJSON: null, mode: null, imageAspectRatio: null, prompt: [] };
  let i = 0;
  const value = flag => {
    const next = args[++i];
    if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`);
    return next;
  };
  for (; i < args.length; i++) {
    switch (args[i]) {
      case '--login': opts.login = true; break;
      case '--git': opts.git = true; break;
      case '--stop': opts.stop = true; break;
      case '--status': opts.status = true; break;
      case '--raw': opts.raw = true; break;
      case '--save-to-file': opts.saveToFile = true; break;
      case '--daemon-internal': opts.daemonInternal = true; break;
      case '--file': opts.file = value('--file'); break;
      case '--upload': opts.upload.push(value('--upload')); break;
      case '--session-id': opts.sessionID = value('--session-id'); break;
      case '--context': opts.context = value('--context'); break;
      case '--mode': opts.mode = value('--mode'); break;
      // 图片比例不是独立模式：CLI 只把用户意图传给 daemon，最终由 core 统一推导 mode=image。
      case '--image-aspect-ratio': opts.imageAspectRatio = value('--image-aspect-ratio'); break;
      case '--cwd': opts.cwd = value('--cwd'); break;
      case '--workspace': opts.workspace = value('--workspace'); break;
      case '--request-json': opts.requestJSON = value('--request-json'); break;
      default: opts.prompt.push(args[i]);
    }
  }
  return loadRequestJSON(opts);
}

/**
 * 从 MCP JSON payload 恢复请求。
 *
 * MCP wrapper 不把长 prompt/context 直接塞进 argv：Windows 命令行长度限制很容易在大型
 * diff、长论文审阅、多个附件描述时触发。`-` 表示从 stdin 读取，避免把敏感 payload 落到 %TEMP%。
 */
function loadRequestJSON(opts) {
  // JSON payload 字段来自 MCP tool arguments：prompt/context/git/file/saveToFile/sessionID。
  // workspace/cwd 固定为 OpenCode 启动目录，用于 git 上下文和项目 cache 落盘；真实 ChatGPT URL 不进入 schema。
  if (!opts.requestJSON) return opts;
  const request = JSON.parse(opts.requestJSON === '-' ? readStdinLimited() : fs.readFileSync(opts.requestJSON, 'utf8'));
  return { ...opts, prompt: [String(request.prompt || '')], context: request.context ?? opts.context, git: !!request.git, upload: normalizePathList(request.file), workspace: request.workspace || opts.workspace, cwd: request.cwd || opts.cwd, sessionID: request.sessionID || opts.sessionID, newSession: !!request.newSession, saveToFile: !!request.saveToFile, mode: request.mode || opts.mode, imageAspectRatio: request.imageAspectRatio || opts.imageAspectRatio };
}

function readStdinLimited() {
  // stdin 入口只服务 MCP wrapper；仍然做字节级上限，避免本地误用把超大 payload 先读进内存再校验。
  // 这里按 chunk 读取，而不是 readFileSync(0)，让上限成为真正的传输边界。
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  while (true) {
    const read = fs.readSync(0, buffer, 0, buffer.length, null);
    if (read === 0) break;
    total += read;
    if (total > MAX_REQUEST_JSON_BYTES) throw new Error(`Request JSON exceeds ${MAX_REQUEST_JSON_BYTES} bytes`);
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 把 daemon 的结构化结果转换成稳定文本。
 *
 * 这里的顺序服务两个读者：人类可以先看正文和保存路径，OpenCode agent 可以始终
 * 从末尾解析 `Session: #xxxxxxxxxx`。即使长回答被本地预览截断，会话句柄也不会丢。
 */
function formatResponse(result) {
  // 输出顺序保持稳定：正文/提示/保存路径/下载文件/状态/是否发送/会话句柄，便于人和模型继续引用。
  return [
    result.response || null,
    result.notice || null,
    result.savedResponse ? ['Response saved to:', result.savedResponse.path, `Lines: ${result.savedResponse.lines}`, `Characters: ${result.savedResponse.chars}`].join('\n') : null,
    result.downloads && result.downloads.length > 0 ? ['Downloaded files:', ...result.downloads.map(file => `- ${file.name}: ${file.path}`)].join('\n') : null,
    result.status ? `Status: ${result.status}` : null,
    result.promptSent === false ? 'Prompt sent: no' : null,
    result.sessionID ? `Session: ${result.sessionID}` : null,
  ].filter(Boolean).join('\n\n');
}

// ─── CLI Dispatch ─────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Usage:
  node chatgpt.js --login                               # first-time setup
  node chatgpt.js "prompt"                              # create a new #xxxxxxxxxx session
  node chatgpt.js --session-id #4fa92c9d10 "prompt"     # continue a session
  node chatgpt.js --file <path> "prompt"                # paste file content as text in prompt
  node chatgpt.js --upload <path> [--upload <path>] "prompt" # upload one or more files
  node chatgpt.js --save-to-file "prompt"               # save response under .opencode/cache/chatgpt
  node chatgpt.js --raw "prompt"                        # print tool output without CLI framing
  node chatgpt.js --git "write a commit message"        # attach git diff/status
  node chatgpt.js --context "we use Effect v4" "prompt" # inline context
  node chatgpt.js --mode image --image-aspect-ratio wide "prompt"
  node chatgpt.js --request-json -                       # internal MCP payload mode over stdin
  cat error.log | node chatgpt.js "what is wrong"       # pipe input
  node chatgpt.js --status                              # check if daemon is running
  node chatgpt.js --stop                                # shut down the daemon
`);
}

/**
 * CLI 的唯一入口。
 *
 * 这里故意保持线性分支：daemon internal、login、stop、status、ask。stop/status
 * 是生命周期诊断，不会隐式发送 prompt；ask 才会启动 daemon 并进入 core 的状态机。
 */
async function main(argv = process.argv) {
  const opts = parseArgs(argv);
  if (opts.daemonInternal) return require('./chatgpt-core').startDaemonProcess(); // daemon 模式才加载 core，避免 status/stop 触发 registry 迁移副作用。
  if (opts.login) return (async () => { ensureStateDirForDaemon(); await login(); })().catch(err => { console.error('[ERROR]', err.message); process.exit(1); });

  if (opts.stop) {
    // stop 是显式运维动作；只有端口不可达才清理 stale daemon.json，HTTP 拒绝必须原样报错。
    const state = readDaemonState();
    if (!state) { console.log('[*] No daemon running.'); return; }
    if (!await isDaemonReachable(state)) { unlinkDaemonFiles(); console.log('[*] No daemon running.'); return; }
    try { await httpJSON(state, 'POST', '/stop', {}); }
    catch (err) { console.error('[ERROR]', err.message); process.exit(1); }
    console.log('[*] Daemon stopped.');
    return;
  }

  if (opts.status) {
    // status 是只读探测：不会启动 daemon，也不会修复坏状态，避免诊断命令改变浏览器生命周期。
    const state = readDaemonState();
    if (!state) { console.log('[*] Daemon not running.'); return; }
    if (!await isDaemonReachable(state)) { console.log(`[*] Daemon state exists but identity check failed or stale — PID ${state.pid}, port ${state.port}`); return; }
    try {
      const detail = await httpJSON(state, 'GET', '/status');
      console.log(`[*] Daemon running — PID ${detail.pid || state.pid}, port ${state.port}`);
      if (detail.project) console.log(`Project: ${detail.project}`);
      console.log(`Pages: ${detail.pageCount ?? (detail.pages || []).length}; pending: ${detail.pendingPageCount ?? (detail.pendingPages || []).length}`);
      if (detail.pages) console.log(`Session pages: ${detail.pages.join(', ') || 'none'}`);
      console.log(`Active locks: ${detail.activeLocks || 0}`);
    } catch (err) {
      console.log(`[*] Daemon state exists but HTTP status is unreachable or stale — PID ${state.pid}, port ${state.port}`);
      console.log(`Error: ${err.message}`);
    }
    return;
  }

  if (opts.prompt.length === 0) { printHelp(); process.exit(1); }
  // sessionID 在本地预分配，这样即使长回答超时，错误输出仍能告诉用户用哪个 #id 恢复。
  const sessionID = opts.sessionID || createSessionID();

  const requestMode = opts.mode || (opts.imageAspectRatio ? 'image' : 'auto');
  const fullPrompt = buildFullPrompt({
    userPrompt: opts.prompt.join(' '),
    stdinData: opts.requestJSON ? null : await readStdin(),
    fileData: opts.file ? readFile(opts.file) : null,
    gitData: opts.git ? getGitContext(opts.cwd || process.cwd()) : null,
    contextData: opts.context || null,
    mode: requestMode,
    imageAspectRatio: opts.imageAspectRatio,
  });

  try {
    const daemon = await ensureDaemon();
    // CLI 只提交已归一化的请求；上传、等待、pending、落盘都由 daemon 在同一状态机里处理。
    const workspaceDir = opts.workspace || opts.cwd || process.cwd();
    // imageAspectRatio 能隐式打开 image mode；这样 OpenCode agent 只要表达“宽屏图”，不必重复传两个字段。
    const result = await httpJSON(daemon, 'POST', '/ask', { fullPrompt, uploadPaths: validateUploadPaths(opts.upload, workspaceDir), workspaceDir, sessionID, newSession: opts.newSession || !opts.sessionID, saveToFile: opts.saveToFile, mode: requestMode, imageAspectRatio: opts.imageAspectRatio || null }, ASK_HTTP_TIMEOUT);
    if (!result.ok) throw new Error(result.error || 'Daemon returned an error');
    const responseText = formatResponse(result);
    if (opts.raw) console.log(responseText);
    else console.log(`\n--- RESPONSE ---\n${responseText}\n--- END ---\n`);
  } catch (err) {
    console.error('[ERROR]', err.message);
    if (sessionID) console.error(`Session: ${sessionID}`);
    process.exit(1);
  }
}

if (require.main === module) main().catch(err => { console.error('[ERROR]', err.message); process.exit(1); });
