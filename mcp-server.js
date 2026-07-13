#!/usr/bin/env node
'use strict';

/**
 * mcp-server.js — OpenCode 调用 ChatGPT Web bridge 的 MCP stdio wrapper
 *
 * 这个文件只处理 JSON-RPC/MCP 协议、child process 生命周期、超时、取消和入参校验。
 * 它不理解 ChatGPT DOM，也不自己保存 session；真正的浏览器状态机在 chatgpt-core.js，
 * 命令行/prompt 组装在 chatgpt.js。
 *
 * Exposed tools:
 *   ask    — 发送 prompt / 附件 / git/context，并返回 ChatGPT 回答或本地保存路径。
 *   status — 只读查看 daemon 状态，不启动、不修复。
 *   stop   — 停止 daemon，并取消其他仍在运行的本地 child。
 *
 * MCP schema 保持克制：prompt、sessionID、context、git、file、saveToFile。
 * Project、下载目录、保存目录和 daemon 生命周期都是本地部署策略，不暴露给模型选择。
 */

const { spawn, spawnSync } = require('child_process');
const path          = require('path');
const fs            = require('fs');
const crypto        = require('crypto');

const SCRIPT = path.join(__dirname, 'chatgpt.js');
const MCP_PROTOCOL_VERSION = '2024-11-05';
// mode 只保留会改变产物类型的 UI 入口；网页检索交给 prompt/ChatGPT 自己判断，避免 schema 诱导过度搜索。
// 代理/任务/外部 App 入口暂不进 schema，因为它们会触发隐私确认、计划任务或第三方应用语义。
const ASK_MODES = new Set(['auto', 'image']);
const IMAGE_ASPECT_RATIOS = new Set(['auto', 'square', 'portrait', 'story', 'landscape', 'wide']);
const CHATGPT_ASK_HTTP_TIMEOUT = positiveIntEnv('CHATGPT_ASK_HTTP_TIMEOUT_MS', 620_000);
// 旧版 opencode config 可能只覆盖 CLI timeout，留下更长的 ask HTTP 默认值；这里自动抬高外层预算。
const CHATGPT_CLI_TIMEOUT = cliTimeout();
const CHATGPT_STOP_TIMEOUT = positiveIntEnv('CHATGPT_STOP_TIMEOUT_MS', 30_000);
const MCP_MAX_RETURN_CHARS = positiveIntEnv('CHATGPT_MCP_MAX_RETURN_CHARS', 8_000);
const MCP_CHILD_OUTPUT_MAX_BYTES = positiveIntEnv('CHATGPT_MCP_CHILD_OUTPUT_MAX_BYTES', 12 * 1024 * 1024);
const MCP_STDIN_LINE_MAX_BYTES = positiveIntEnv('CHATGPT_MCP_STDIN_LINE_MAX_BYTES', 25 * 1024 * 1024);
const MCP_MAX_ACTIVE_CALLS = positiveIntEnv('CHATGPT_MCP_MAX_ACTIVE_CALLS', 4);
const MCP_TIMEOUT_RECOVERY_HOLD_MS = positiveIntEnv('CHATGPT_MCP_TIMEOUT_RECOVERY_HOLD_MS', 120_000);
const MAX_UPLOAD_FILES = positiveIntEnv('CHATGPT_MAX_UPLOAD_FILES', 12);
const MAX_UPLOAD_BYTES = positiveIntEnv('CHATGPT_MAX_UPLOAD_BYTES', 400 * 1024 * 1024);
const MAX_TOTAL_UPLOAD_BYTES = positiveIntEnv('CHATGPT_MAX_TOTAL_UPLOAD_BYTES', 800 * 1024 * 1024);
const EXPLICIT_UPLOAD_ROOTS = uploadRoots();
const WORKSPACE_ROOTS = workspaceRoots();
const WORKSPACE_DIR = process.env.CHATGPT_WORKSPACE_DIR ? path.resolve(process.env.CHATGPT_WORKSPACE_DIR) : null;

// ─── Active Call Registry ────────────────────────────────────────────────────

// MCP 取消通知只能取消本地 child/daemon 生命周期，不能假装取消远端 ChatGPT 已提交的问题。
// 因此 child 被杀只代表本地等待停止；ask 调用保留 daemon 运行，给 core 继续写 pending 的机会。
// 只有 status/stop 这类无 session 调用超时，wrapper 才会重启 daemon 清理坏状态。
// activeCalls 只跟踪 MCP request id 到 child process 的映射，不保存业务状态。
const activeCalls = new Map();
let timeoutRecoveryHoldUntil = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(obj) {
  // stdout 是 MCP 协议流，只能写 JSON-RPC；调试日志不要从这里输出，否则会污染 host 解析。
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function positiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cliTimeout() {
  // wrapper 必须晚于 chatgpt.js 的 /ask HTTP 超时，否则外层先杀进程，core 没机会返回 pending/recovery 状态。
  // 这里不在启动期 throw：MCP server 一旦退出，OpenCode 只能看到 Connection closed，反而丢失可诊断性。
  return Math.max(positiveIntEnv('CHATGPT_CLI_TIMEOUT_MS', 635_000), CHATGPT_ASK_HTTP_TIMEOUT + 15_000);
}

function uploadRoots() {
  const value = process.env.CHATGPT_UPLOAD_ROOTS || '';
  return value.split(path.delimiter).map(item => item.trim()).filter(Boolean).map(item => path.resolve(item));
}

function workspaceRoots() {
  const value = process.env.CHATGPT_WORKSPACE_ROOTS || '';
  return value.split(path.delimiter).map(item => item.trim()).filter(Boolean).map(item => path.resolve(item));
}

function currentWorkspaceDir() {
  // OpenCode local MCP 会把 cwd 设为当前 InstanceState.directory；显式 roots 只作为部署收窄策略。
  const cwd = WORKSPACE_DIR || path.resolve(process.cwd());
  if (WORKSPACE_ROOTS.length === 0) return cwd;
  const realCwd = fs.realpathSync.native(cwd);
  // symlink/junction 之后再匹配 root，避免显式 allowlist 被路径表象绕过。
  const workspace = WORKSPACE_ROOTS.map(root => fs.realpathSync.native(root)).find(root => isInside(root, realCwd));
  if (!workspace) throw new Error(`current working directory is outside CHATGPT_WORKSPACE_ROOTS: ${cwd}`);
  return realCwd;
}

function sendToolResult(id, result, emit = send) {
  // MCP 工具结果即使是错误也走 result.content，再用 isError 标记；不要把工具错误变成 JSON-RPC 协议错误。
  const payload = { content: [{ type: 'text', text: limitToolText(result.text) }] };
  if (result.isError) payload.isError = true;
  emit({ jsonrpc: '2.0', id, result: payload });
}

function limitToolText(text) {
  // core 正常会先保存长回答；这里是最后保险，避免任何异常路径把超长文本直接冲进 OpenCode。
  const value = String(text || '');
  if (value.length <= MCP_MAX_RETURN_CHARS) return value;
  return `${value.slice(0, MCP_MAX_RETURN_CHARS).trimEnd()}\n\n[Output truncated by chatgpt MCP wrapper before reaching OpenCode. Characters returned: ${MCP_MAX_RETURN_CHARS}; original characters: ${value.length}.]`;
}

function normalizeToolName(name) {
  // 只在入口兼容旧工具名，tools/list 不再重复暴露旧名字，避免模型看到两套等价工具。
  if (name === 'chatgpt_ask') return 'ask';
  if (name === 'chatgpt_status') return 'status';
  if (name === 'chatgpt_stop') return 'stop';
  return name;
}

function normalizeFiles(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map(item => {
      if (typeof item !== 'string') throw new Error('file entries must be strings');
      return item.trim();
    })
    .filter(Boolean);
}

function normalizeSessionID(value) {
  if (!value) return null;
  const text = String(value).trim().toLowerCase();
  if (/^#?[a-f0-9]{6}$/i.test(text)) return `${text.startsWith('#') ? text : `#${text}`}0000`;
  if (/^#?[a-f0-9]{10}$/i.test(text)) return text.startsWith('#') ? text : `#${text}`;
  throw new Error('sessionID must be a short handle like #4fa92c9d10');
}

function normalizeImageAspectRatio(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (IMAGE_ASPECT_RATIOS.has(text)) return text;
  throw new Error(`imageAspectRatio must be one of: ${[...IMAGE_ASPECT_RATIOS].join(', ')}`);
}

function createSessionID() {
  return `#${crypto.randomBytes(5).toString('hex')}`;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realUploadRoots() {
  // 默认信任用户明确传给 Tool 的绝对文件路径；显式 roots 仅作为部署方主动开启的收窄策略。
  return EXPLICIT_UPLOAD_ROOTS.map(root => {
    try { return fs.realpathSync.native(root); }
    catch { throw new Error(`upload root does not exist: ${root}`); }
  });
}

function uploadRootDiagnostics() {
  // 未配置 roots 不是异常，而是允许用户指定任意本地文件；status 仍暴露显式收窄策略是否有效。
  if (EXPLICIT_UPLOAD_ROOTS.length === 0) return 'Upload roots: unrestricted (only attach files explicitly selected by the user)';
  const lines = EXPLICIT_UPLOAD_ROOTS.map(root => fs.existsSync(root) ? `Upload root ok: ${root}` : `Upload root missing: ${root}`);
  return lines.join('\n');
}

function assertUploadFileSafe(file) {
  const abs = path.resolve(file);
  const real = fs.realpathSync.native(abs);
  const roots = realUploadRoots();
  if (roots.length > 0 && !roots.some(root => isInside(root, real))) throw new Error(`file is outside allowed upload roots: ${file}`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`file is not a regular file: ${file}`);
  if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`file is too large: ${file}; limit is ${MAX_UPLOAD_BYTES} bytes`);
  return real;
}

function buildAskRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  const allowed = new Set(['prompt', 'sessionID', 'context', 'git', 'file', 'saveToFile', 'mode', 'imageAspectRatio']);
  const unknown = Object.keys(args).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown ask argument(s): ${unknown.join(', ')}`);
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt must be a non-empty string');
  if (args.prompt.length > 200_000) throw new Error('prompt is too long; limit is 200000 characters');
  if (args.context != null && typeof args.context !== 'string') throw new Error('context must be a string');
  if (args.context != null && args.context.length > 200_000) throw new Error('context is too long; limit is 200000 characters');
  if (args.git != null && typeof args.git !== 'boolean') throw new Error('git must be a boolean');
  if (args.saveToFile != null && typeof args.saveToFile !== 'boolean') throw new Error('saveToFile must be a boolean');
  if (args.mode != null && (typeof args.mode !== 'string' || !ASK_MODES.has(args.mode))) throw new Error(`mode must be one of: ${[...ASK_MODES].join(', ')}`);
  const imageAspectRatio = normalizeImageAspectRatio(args.imageAspectRatio);
  const mode = args.mode || (imageAspectRatio ? 'image' : 'auto');
  if (imageAspectRatio && mode !== 'image') throw new Error('imageAspectRatio requires mode=image or omitted mode');
  const workspace = currentWorkspaceDir();
  const files = normalizeFiles(args.file);
  if (files.length > MAX_UPLOAD_FILES) throw new Error(`file accepts at most ${MAX_UPLOAD_FILES} paths`);
  const safeFiles = [];
  for (const file of files) {
    if (!path.isAbsolute(file)) throw new Error(`file must be an absolute path: ${file}`);
    safeFiles.push(assertUploadFileSafe(file));
  }
  const uploadBytes = safeFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  // composer 匹配依赖 basename，MCP 层先拒绝同名文件，daemon 层仍会重复校验作为最终边界。
  assertUniqueBasenames(safeFiles);
  if (uploadBytes > MAX_TOTAL_UPLOAD_BYTES) throw new Error(`total upload size is too large; limit is ${MAX_TOTAL_UPLOAD_BYTES} bytes`);
  return {
    prompt: args.prompt,
    sessionID: normalizeSessionID(args.sessionID) || createSessionID(),
    newSession: !args.sessionID,
    context: args.context == null ? null : args.context,
    git: !!args.git,
    file: safeFiles,
    saveToFile: !!args.saveToFile,
    mode,
    imageAspectRatio,
    workspace,
    cwd: workspace,
  };
}

function assertUniqueBasenames(files) {
  const names = files.map(file => path.basename(file).toLowerCase());
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error(`file basenames must be unique for ChatGPT attachment matching: ${duplicate}`);
}

function assertNoArguments(args, tool) {
  if (args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0) return;
  throw new Error(`${tool} does not accept arguments`);
}

// ─── Daemon Cleanup and Error Policy ─────────────────────────────────────────

function stopDaemon() {
  // stopDaemon 是清理动作，调用者不依赖它的输出；失败/超时也不能让 wrapper 崩溃。
  spawnSync(process.execPath, [SCRIPT, '--stop'], {
    encoding: 'utf8',
    timeout: CHATGPT_STOP_TIMEOUT,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}

function isBrowserContextError(text) {
  // 这类错误说明 daemon/浏览器上下文可能坏了；wrapper 只清理状态，不自动重发 prompt。
  return /detached Frame|Execution context was destroyed|Cannot find context|Target closed|Protocol error|Runtime\.callFunctionOn timed out/i.test(text);
}

function killProcess(pid, options = {}) {
  if (!pid) return;
  const tree = options.tree !== false;
  if (process.platform === 'win32' && tree) {
    // 诊断/status 类调用没有远端 prompt，可杀整棵树清理坏浏览器；ask 则只杀 CLI，保留 daemon 做 pending 恢复。
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: CHATGPT_STOP_TIMEOUT, windowsHide: true });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

function cancelCall(id, reason) {
  // 取消是“本地止损”，不是远端撤回；ChatGPT 若已收到 prompt，后续仍需用同 sessionID 恢复。
  const active = activeCalls.get(requestKey(id)) || activeCalls.get(alternateRequestKey(id));
  cancelActive(active, reason);
}

function cancelCallKey(key, reason) {
  // stop 遍历的是 activeCalls 内部 key，不能再按 JSON-RPC id 二次 normalize。
  cancelActive(activeCalls.get(key), reason);
}

function cancelActive(active, reason) {
  if (!active) return;
  active.cancelled = reason || 'cancelled';
  if (active.sessionID) timeoutRecoveryHoldUntil = Math.max(timeoutRecoveryHoldUntil, Date.now() + MCP_TIMEOUT_RECOVERY_HOLD_MS);
  if (active.child) killProcess(active.child.pid, { tree: !active.sessionID });
}

// ─── chatgpt.js Child Runner ─────────────────────────────────────────────────

/**
 * 运行一次 chatgpt.js 子进程并返回 MCP tool result。
 *
 * wrapper timeout 是最后一道本地保险：如果 child 或 Puppeteer HTTP 调用卡死，就杀掉进程树
 * 并 stop daemon，避免坏浏览器上下文继续阻塞后续调用。浏览器 context 错误只触发清理，
 * 不自动重发 prompt，因为错误可能发生在 ChatGPT 已经收到用户消息之后。
 */
function runChatgpt(args, id, timeout = CHATGPT_CLI_TIMEOUT, sessionID = null, stdin = null) {
  // runChatgpt 始终 resolve 工具结果对象，不向外 throw；handleRequest 只负责把结果发回 MCP host。
  return new Promise(resolve => {
    if (sessionID && [...activeCalls.values()].filter(call => call.sessionID && call.child).length >= MCP_MAX_ACTIVE_CALLS) {
      resolve({ text: `Error: too many active ChatGPT MCP calls; limit is ${MCP_MAX_ACTIVE_CALLS}`, isError: true });
      return;
    }
    const key = requestKey(id);
    if (key && activeCalls.has(key)) {
      // JSON-RPC client 不应并发复用 id；拒绝比覆盖 active child 更安全，否则取消会找不到旧请求。
      resolve({ text: `Error: duplicate active JSON-RPC request id: ${id}`, isError: true });
      return;
    }
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      windowsHide: true,
      stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    // stdin 只活在父子进程管道里；相比 temp file，更适合承载包含 prompt/context/git diff 的敏感 payload。
    if (stdin != null) child.stdin.end(stdin);
    const active = { child, cancelled: null, sessionID };
    // activeCalls 只保存 request id 到 child 的映射，用于取消；它不表达 ChatGPT session 的并发关系。
    if (key) activeCalls.set(key, active);

    let out = '';
    let err = '';
    const append = (key, chunk) => {
      if (key === 'out') out += chunk.toString('utf8');
      else err += chunk.toString('utf8');
      if (Buffer.byteLength(out, 'utf8') + Buffer.byteLength(err, 'utf8') > MCP_CHILD_OUTPUT_MAX_BYTES) {
        active.cancelled = `child output exceeded ${MCP_CHILD_OUTPUT_MAX_BYTES} bytes`;
        killProcess(child.pid, { tree: !active.sessionID });
      }
    };
    child.stdout.on('data', chunk => append('out', chunk));
    child.stderr.on('data', chunk => append('err', chunk));

    const timer = setTimeout(() => {
      // ask 超时后保留 daemon，给已提交的远端会话继续落 pending；无 session 的诊断命令才重启。
      killProcess(child.pid, { tree: !sessionID });
      if (!sessionID && Date.now() >= timeoutRecoveryHoldUntil && ![...activeCalls.values()].some(call => call.sessionID)) stopDaemon();
      if (key && sessionID) {
        // child 已被杀，但 daemon 可能还在处理 clientClosed 后的 pending 落盘；短暂阻止 stop 破坏恢复窗口。
        activeCalls.delete(key);
        timeoutRecoveryHoldUntil = Math.max(timeoutRecoveryHoldUntil, Date.now() + MCP_TIMEOUT_RECOVERY_HOLD_MS);
      } else if (key) activeCalls.delete(key);
      resolve({
        // timeout 可能发生在排队阶段，也可能发生在 prompt 已提交后；文案必须同时覆盖“可恢复”和“未发送”。
        text: [`Error: ChatGPT request timed out after ${timeout}ms; ${sessionID ? 'submission state is unknown. If the prompt reached ChatGPT, the daemon was left running so visible output may still be recoverable; if the queued ask never started, the same sessionID may report unknown and no prompt was sent' : 'daemon was restarted automatically'}. Retry with the same sessionID once to inspect/recover; if it reports an unknown session, resend only if you deliberately want a new prompt.`, sessionID ? `Session: ${sessionID}` : null].filter(Boolean).join('\n'),
        isError: true,
      });
    }, timeout);

    child.on('error', error => {
      // spawn 失败说明本地 node/路径层出错，还没进入 ChatGPT 业务状态，直接作为工具错误返回。
      clearTimeout(timer);
      if (key) activeCalls.delete(key);
      resolve({ text: `Error: ${error.message}`, isError: true });
    });

    child.on('close', status => {
      clearTimeout(timer);
      if (key && activeCalls.get(key) === active) activeCalls.delete(key);
      out = out.trim();
      err = err.trim();

      if (active.cancelled) {
        // 被取消的请求即使 child 后续退出码为 0，也应向 host 报告取消语义。
        resolve({ text: [`Error: ChatGPT request cancelled: ${active.cancelled}`, active.sessionID ? `Session: ${active.sessionID}` : null].filter(Boolean).join('\n'), isError: true });
        return;
      }

      if (status !== 0) {
        if (isBrowserContextError(`${err}\n${out}`)) {
          if (!sessionID && Date.now() >= timeoutRecoveryHoldUntil && ![...activeCalls.values()].some(call => call.sessionID)) stopDaemon();
          resolve({ text: err || out || `Error: browser context failed; ${sessionID ? 'daemon was left running for pending recovery' : 'daemon was restarted automatically'}. Retry with the same sessionID when available.`, isError: true });
          return;
        }
        resolve({ text: err || out || `Error: chatgpt.js exited with status ${status}`, isError: true });
        return;
      }

      resolve({ text: out || err || '(no output)', isError: false });
    });
  });
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'ask',
    description:
      'Send a task to ChatGPT Web through the user\'s logged-in browser. Use for external/current-source research, repository or issue investigation, large-file review, data/sandbox analysis, document artifacts, or native image generation. ' +
      'This bridge does not execute local commands or edit local files. Put web/source requirements in prompt text; use mode=image only for native images. Detectable sandbox files and native images are saved under the current project cache. ' +
      'Omit sessionID for a new conversation; pass one to continue or recover it. If that session is still generating, the new prompt is not sent and the current assistant snapshot is returned/saved instead.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 200000,
          description: 'Task for ChatGPT. Include web-search/source requirements directly in this text when needed.',
        },
        sessionID: {
          type: 'string',
          pattern: '^#?(?:[a-fA-F0-9]{10}|[a-fA-F0-9]{6})$',
          description: 'Optional ChatGPT conversation handle, e.g. #4fa92c9d10. Omit for a new conversation; pass an existing ID to continue or recover it.',
        },
        context: {
          type: 'string',
          maxLength: 200000,
          description: 'Curated local context prepended before the task. Keep it focused; large files should use file uploads.',
        },
        git: {
          type: 'boolean',
          description: 'Attach current branch, status, and bounded diff from the OpenCode working directory.',
        },
        file: {
          oneOf: [
            { type: 'string' },
            { type: 'array', maxItems: MAX_UPLOAD_FILES, items: { type: 'string' } },
          ],
          description: 'Absolute path or array of absolute paths to upload through ChatGPT attachments. File contents are sent to ChatGPT: attach only files explicitly selected by the user and never infer sensitive paths. Paths are unrestricted by default; CHATGPT_UPLOAD_ROOTS can opt into an allowlist.',
        },
        saveToFile: {
          type: 'boolean',
          description: 'Save the text response under <current-project>/.opencode/cache/chatgpt/responses/<sessionID>/ and return metadata instead of inline text.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'image'],
          // 这里不暴露 DOM 文案本身；模型只看到稳定语义，具体 selector 漂移由 browser adapter 吸收。
          description: 'Composer mode. auto is normal ChatGPT; ask for web sources in the prompt. image selects native Create Image.',
        },
        imageAspectRatio: {
          type: 'string',
          enum: ['auto', 'square', 'portrait', 'story', 'landscape', 'wide'],
          description: 'Native image aspect ratio. Use only with mode=image or omit mode so image mode is inferred; do not combine with mode=auto. Values: auto, square 1:1, portrait 3:4, story 9:16, landscape 4:3, wide 16:9.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    description: 'Check whether the ChatGPT browser daemon is currently running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'stop',
    description: 'Shut down the ChatGPT browser daemon and close the browser.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ─── Request Dispatcher ───────────────────────────────────────────────────────

async function handleRequest(req, emit = send) {
  if (!req || typeof req !== 'object' || Array.isArray(req) || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    emit({ jsonrpc: '2.0', id: req && typeof req === 'object' && 'id' in req ? req.id : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  if ('id' in req && req.id !== null && typeof req.id !== 'string' && typeof req.id !== 'number') {
    emit({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request id' } });
    return;
  }
  const { id, method, params } = req;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  if (method === 'initialize') {
    if (id === undefined) return;
    emit({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities:   { tools: {} },
        serverInfo:     { name: 'chatgpt', version: '1.0.0' },
      },
    });
    return;
  }

  // 初始化完成通知没有 id，按 JSON-RPC 语义不需要响应。
  if (method === 'notifications/initialized') return;

  if (method === 'ping') {
    if (id !== undefined) emit({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'notifications/cancelled' || method === '$/cancelRequest') {
    // 不同 MCP host 的取消消息字段不同；requestId/id 都接受，reason 只作为诊断文本。
    cancelCall(params && (params.requestId ?? params.id), params && params.reason);
    return;
  }

  if (id === undefined) return;

  // ── Tool discovery ─────────────────────────────────────────────────────────
  if (method === 'tools/list') {
    emit({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'resources/list') {
    // opencode 会探测可选 MCP surface；本桥只提供工具，不提供独立资源，返回空列表比 -32601 更干净。
    emit({ jsonrpc: '2.0', id, result: { resources: [] } });
    return;
  }

  if (method === 'prompts/list') {
    // Prompt 模板会和本地 agent 的职责边界打架；显式返回空列表，避免 host 把缺省能力当错误记录。
    emit({ jsonrpc: '2.0', id, result: { prompts: [] } });
    return;
  }

  // ── Tool invocation ────────────────────────────────────────────────────────
  if (method === 'tools/call') {
    if (!params || typeof params !== 'object' || Array.isArray(params) || typeof params.name !== 'string') {
      emit({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: tools/call requires { name, arguments }' } });
      return;
    }
    const name = normalizeToolName(params && params.name);
    const args = params.arguments === undefined ? {} : params.arguments;

    if (name === 'status') {
      // status 是只读探测，不取消其他调用，也不主动重启 daemon。
      try { assertNoArguments(args, 'status'); }
      catch (err) { sendToolResult(id, { text: `Error: ${err.message}`, isError: true }, emit); return; }
      const result = await runChatgpt(['--status'], id, CHATGPT_STOP_TIMEOUT);
      result.text = `${result.text}\n${uploadRootDiagnostics()}`;
      sendToolResult(id, result, emit);
      return;
    }

    if (name === 'stop') {
      // stop 是全局生命周期操作，先取消其他 child，避免它们继续持有旧 daemon 连接。
      try { assertNoArguments(args, 'stop'); }
      catch (err) { sendToolResult(id, { text: `Error: ${err.message}`, isError: true }, emit); return; }
      if ([...activeCalls.values()].some(call => call.sessionID && call.child)) {
        sendToolResult(id, { text: 'Error: refusing to stop while ask calls are active; cancel/recover those sessions first', isError: true }, emit);
        return;
      }
      if (Date.now() < timeoutRecoveryHoldUntil) {
        sendToolResult(id, { text: 'Error: refusing to stop during timeout recovery hold; retry status/recovery first or wait for the hold to expire', isError: true }, emit);
        return;
      }
      for (const callID of [...activeCalls.keys()]) {
        if (callID !== requestKey(id)) cancelCallKey(callID, 'stop requested');
      }
      sendToolResult(id, await runChatgpt(['--stop'], id, CHATGPT_STOP_TIMEOUT), emit);
      return;
    }

    if (name === 'ask') {
      // process.cwd() 是 OpenCode 启动目录，用它读取当前项目的 git 上下文和项目 cache。
      let request;
      try { request = buildAskRequest(args); }
      catch (err) { sendToolResult(id, { text: `Error: ${err.message}`, isError: true }, emit); return; }
      // 长 prompt/context 通过 stdin 传给 chatgpt.js，避免 Windows argv 限制，也不在 %TEMP% 留敏感 JSON。
      sendToolResult(id, await runChatgpt(['--raw', '--request-json', '-'], id, CHATGPT_CLI_TIMEOUT, request.sessionID, JSON.stringify(request)), emit);
      return;
    }

    sendToolResult(id, { text: `Error: Unknown tool: ${name}`, isError: true }, emit);
    return;
  }

  // 未知方法只在 request 有 id 时回包；notification 不能凭空制造响应。
  if (id !== undefined) {
    // JSON-RPC notification 没有 id，未知 notification 也不能回包；只有 request 才返回 Method not found。
    emit({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

// ─── Stdin Loop ───────────────────────────────────────────────────────────────

let stdinBuffer = '';
let droppingOversizedLine = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  let rest = chunk;
  while (rest) {
    // 按行推进而不是先拼整块：同一个 OS chunk 中，坏的大行后面可能跟着合法 cancel/ping。
    const match = rest.match(/\r?\n/);
    const linePart = match ? rest.slice(0, match.index) : rest;
    const next = match ? rest.slice(match.index + match[0].length) : '';
    if (!droppingOversizedLine) stdinBuffer += linePart;
    if (!droppingOversizedLine && Buffer.byteLength(stdinBuffer, 'utf8') > MCP_STDIN_LINE_MAX_BYTES) {
      // 超限行直接丢弃到下一个换行；返回 parse error 后，后续 MCP 流仍应继续工作。
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: JSON-RPC line exceeds ${MCP_STDIN_LINE_MAX_BYTES} bytes` } });
      stdinBuffer = '';
      droppingOversizedLine = true;
    }
    if (!match) return;
    if (droppingOversizedLine) droppingOversizedLine = false;
    else dispatchLine(stdinBuffer);
    stdinBuffer = '';
    rest = next;
  }
});

function dispatchLine(line) {
  // 不串行阻塞整条 stdio：cancel/status/stop 必须能在长 ask 运行时进入 dispatcher。
  handleLine(line).catch(error => {
    send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: error.message } });
  });
}

function requestKey(id) {
  if (typeof id === 'number') return `n:${id}`;
  if (typeof id === 'string') return `s:${id}`;
  return null;
}

function alternateRequestKey(id) {
  if (typeof id === 'number') return `s:${id}`;
  if (typeof id === 'string' && /^-?\d+(?:\.\d+)?$/.test(id)) return `n:${Number(id)}`;
  return null;
}

async function handleLine(line) {
  // MCP stdio 是一行一个 JSON-RPC 消息；空行忽略，解析失败返回标准 parse error。
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  await handleMessage(req).catch(error => {
    send({ jsonrpc: '2.0', id: req && req.id !== undefined ? req.id : null, error: { code: -32603, message: error.message } });
  });
}

async function handleMessage(req) {
  if (!Array.isArray(req)) return handleRequest(req);
  if (req.length === 0) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid empty batch' } });
    return;
  }
  const responses = [];
  const emit = obj => responses.push(obj);
  for (const item of req) {
    // batch 适合生命周期消息；ask 是长任务，放进 batch 会让同批 ping/tools/list 一起被慢调用拖死。
    if (isBatchedAsk(item)) {
      if (item.id !== undefined) emit({ jsonrpc: '2.0', id: item.id, error: { code: -32600, message: 'ask cannot be sent in a JSON-RPC batch; send it as a standalone request' } });
      continue;
    }
    await handleRequest(item, emit).catch(error => {
      emit({ jsonrpc: '2.0', id: item && item.id !== undefined ? item.id : null, error: { code: -32603, message: error.message } });
    });
  }
  if (responses.length > 0) send(responses);
}

function isBatchedAsk(item) {
  return item && typeof item === 'object' && item.method === 'tools/call' && normalizeToolName(item.params && item.params.name) === 'ask';
}

// MCP server 以 stdin 为生命周期；没有输入时也要常驻等待下一行 JSON-RPC。
process.stdin.resume();
