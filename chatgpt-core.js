
/**
 * chatgpt-core.js — browser daemon 与 #sessionID 状态机
 *
 * daemon 是本项目唯一持有 Puppeteer browser 的进程。CLI 和 MCP 都只通过本地
 * HTTP 调它，因此浏览器 profile、固定 Project、会话 registry、pending 恢复、
 * 长回答落盘和 artifact 收集必须在这一层形成一个闭环。
 *
 * 核心不变量：
 *   - 一个 #xxxxxxxxxx 只映射到固定 ChatGPT Project 下的一条 /c/... conversation。
 *   - 同一 #id 串行执行，避免两个 prompt 写进同一个 composer。
 *   - 不同 #id 可以并发，但新建 conversation 仍串行，规避 ChatGPT Web 的创建竞态。
 *   - pending 会话再次 ask 时只恢复当前 assistant，不发送新的 prompt。
 */

const puppeteer           = require('puppeteer-core');
const path                = require('path');
const fs                  = require('fs');
const http                = require('http');
const net                 = require('net');
const os                  = require('os');
const crypto              = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { createChatGPTDom } = require('./chatgpt-dom');

// ─── Constants and Directories ────────────────────────────────────────────────

// 常量集中在 core，是因为 daemon/browser/profile/cache 必须由同一层统一决定；
// CLI 和 MCP 只传入请求，不重新推导这些路径，避免多个入口算出不同目录。

const CHROME_PATH      = process.env.CHATGPT_BROWSER_PATH || defaultBrowserPath();
const STATE_DIR        = path.resolve(process.env.CHATGPT_STATE_DIR || defaultStateDir());
const USER_DATA_DIR    = path.resolve(process.env.CHATGPT_SESSION_DIR || defaultUserDataDir());
const SESSION_DIR      = USER_DATA_DIR;
const PROFILE_DIR      = path.join(STATE_DIR, 'profile');
const BROWSER_USER_DATA_DIR = path.resolve(process.env.CHATGPT_BROWSER_USER_DATA_DIR || PROFILE_DIR);
const BROWSER_PROFILE_DIRECTORY = process.env.CHATGPT_BROWSER_PROFILE_DIRECTORY || '';
const BROWSER_WS_ENDPOINT = process.env.CHATGPT_BROWSER_WS_ENDPOINT || '';
// 默认 0（禁用）：不走 spawn+connect 路径，直接用 puppeteer.launch 启动浏览器。
// 默认 9222 会导致每次启动都尝试连接 9222 端口（通常失败）→ spawn Edge → 轮询 CDP 30s，
// 在 profile 被锁或 Edge 无法打开 CDP 时完全挂起。需要 CDP 的用户可显式设置此环境变量。
const BROWSER_DEBUG_PORT = Number.parseInt(process.env.CHATGPT_BROWSER_DEBUG_PORT || '0', 10);
const BROWSER_CDP_URL_ENV = process.env.CHATGPT_BROWSER_CDP_URL || '';
const BROWSER_CDP_URL = BROWSER_CDP_URL_ENV || (Number.isFinite(BROWSER_DEBUG_PORT) && BROWSER_DEBUG_PORT > 0 ? `http://127.0.0.1:${BROWSER_DEBUG_PORT}` : '');
const BROWSER_CONNECT_TIMEOUT_MS = positiveIntEnv('CHATGPT_BROWSER_CONNECT_TIMEOUT_MS', 3_000);
const PROJECTS_FILE    = path.join(STATE_DIR, 'projects.json');
const SESSION_INDEX_FILE = path.join(USER_DATA_DIR, 'sessions.json');
const DAEMON_FILE      = path.join(STATE_DIR, 'daemon.json');
const DAEMON_LOG       = path.join(STATE_DIR, 'daemon.log');
const CHATGPT_URL      = 'https://chatgpt.com';
const DEFAULT_PROJECT  = process.env.CHATGPT_PROJECT || process.env.CHATGPT_PROJECT_NAME || process.env.CHATGPT_PROJECT_URL || 'MCP';
const DAEMON_VERSION   = 23;
const RESPONSE_TIMEOUT = positiveIntEnv('CHATGPT_RESPONSE_TIMEOUT_MS', 540_000); // 大文件分析会很慢，默认给 9 分钟。
const MAX_RETURN_CHARS = positiveIntEnv('CHATGPT_MAX_RETURN_CHARS', 6_000);
const RESPONSE_PREVIEW_CHARS = positiveIntEnv('CHATGPT_RESPONSE_PREVIEW_CHARS', 4_000);
const MAX_SESSION_PAGES = positiveIntEnv('CHATGPT_MAX_SESSION_PAGES', 12);
const MAX_DAEMON_REQUEST_BYTES = positiveIntEnv('CHATGPT_DAEMON_MAX_REQUEST_BYTES', 25 * 1024 * 1024);
const PENDING_TTL_MS = positiveIntEnv('CHATGPT_PENDING_TTL_MS', 12 * 60 * 60 * 1000);
const COMPLETED_RETRY_TTL_MS = positiveIntEnv('CHATGPT_COMPLETED_RETRY_TTL_MS', 10 * 60 * 1000);
const JSON_LOCK_TIMEOUT_MS = positiveIntEnv('CHATGPT_JSON_LOCK_TIMEOUT_MS', 30_000);
// 会话索引只服务短句柄恢复；限制普通条目数量，避免把浏览历史长期堆成隐性日志。
const MAX_SESSION_ENTRIES = positiveIntEnv('CHATGPT_SESSION_MAX_ENTRIES', 256);
const SESSION_MAX_AGE_MS = positiveIntEnv('CHATGPT_SESSION_MAX_AGE_MS', 90 * 24 * 60 * 60 * 1000);
const MAX_UPLOAD_FILES = positiveIntEnv('CHATGPT_MAX_UPLOAD_FILES', 12);
const MAX_UPLOAD_BYTES = positiveIntEnv('CHATGPT_MAX_UPLOAD_BYTES', 400 * 1024 * 1024);
const MAX_TOTAL_UPLOAD_BYTES = positiveIntEnv('CHATGPT_MAX_TOTAL_UPLOAD_BYTES', 800 * 1024 * 1024);
const MAX_VOICE_FILE_BYTES = positiveIntEnv('CHATGPT_VOICE_FILE_MAX_BYTES', 50 * 1024 * 1024);
// voice 转写总超时：覆盖 session 获取 + 音频上传 + 转写返回的完整链路。
// 实际转写 2-8s；60s 足够覆盖慢网络和大文件，超时后 voiceLock 被释放。
const VOICE_TRANSCRIBE_TIMEOUT_MS = positiveIntEnv('CHATGPT_VOICE_TRANSCRIBE_TIMEOUT_MS', 60_000);
// voice 页面最大年龄：超过后主动重建，防止 Service Worker 状态退化、cookie 过期等问题累积。
// 10 分钟：voice 通常在短时内多次使用，10 分钟内不会触发重建；长时间空闲后首次使用时重建。
const VOICE_PAGE_MAX_AGE_MS = positiveIntEnv('CHATGPT_VOICE_PAGE_MAX_AGE_MS', 600_000);
const MAX_FULL_PROMPT_CHARS = positiveIntEnv('CHATGPT_MAX_FULL_PROMPT_CHARS', 500_000);
// 登录过期时 daemon 保持浏览器窗口打开，等待用户手动登录；超时后返回明确错误。
// 默认 2 分钟：用户在场时足够完成邮箱/密码登录，不在场时不会让 MCP 调用长时间悬挂。
const LOGIN_WAIT_TIMEOUT_MS = positiveIntEnv('CHATGPT_LOGIN_WAIT_TIMEOUT_MS', 120_000);
const ASK_MODES = new Set(['auto', 'image']);
// 图片比例来自实测的 ChatGPT image popover；保存语义枚举，DOM 本地化标签留给 adapter 翻译。
const IMAGE_ASPECT_RATIOS = new Set(['auto', 'square', 'portrait', 'story', 'landscape', 'wide']);
const EXPLICIT_UPLOAD_ROOTS = uploadRoots();
const WORKSPACE_ROOTS = workspaceRoots();
const VOICE_FILE_ROOTS = voiceFileRoots();
const CHATGPT_DOM = createChatGPTDom({
  responseTimeout: RESPONSE_TIMEOUT,
});

// 运行状态和会话索引分离：浏览器 profile/daemon 放插件状态目录，#xxxxxxxxxx 会话索引放用户级 opencode 数据目录。
ensurePrivateDir(STATE_DIR);
ensurePrivateDir(USER_DATA_DIR);
ensurePrivateDir(PROFILE_DIR);
migrateSessionIndexFile();
compactSessionIndexFile();

// ─── Small Utilities ──────────────────────────────────────────────────────────

function normalizePathList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

/**
 * 启动用户可见的浏览器 profile。
 *
 * 这里不用 headless：ChatGPT 登录、验证码、附件上传和原生图片 UI 都是网页产品的一部分，
 * 可见窗口让用户能在异常时接管。这里不依赖 stealth 插件；首次登录仍由
 * chatgpt.js --login 使用非 Puppeteer 浏览器完成。
 */
async function launchBrowser(log = () => {}) {
  // 优先复用已开远程调试端口的浏览器；普通 Chromium/Edge 进程不能事后被 Puppeteer 附加。
  if (BROWSER_WS_ENDPOINT || BROWSER_CDP_URL) {
    try {
      log(`Connecting to existing browser: ${BROWSER_WS_ENDPOINT || BROWSER_CDP_URL}`);
      // connect 模式才是真正“复用已打开浏览器”；它要求浏览器启动时就带 DevTools 端口。
      // 普通 Edge 窗口没有这个协议入口，不能靠 Puppeteer 事后强行接管。
      if (BROWSER_CDP_URL) await ensureDevtoolsEndpointReachable(BROWSER_CDP_URL);
      return await withTimeout(puppeteer.connect({
        ...(BROWSER_WS_ENDPOINT ? { browserWSEndpoint: BROWSER_WS_ENDPOINT } : { browserURL: BROWSER_CDP_URL }),
        defaultViewport: null,
        protocolTimeout: RESPONSE_TIMEOUT,
      }), BROWSER_CONNECT_TIMEOUT_MS, `Timed out connecting to browser DevTools endpoint: ${BROWSER_WS_ENDPOINT || BROWSER_CDP_URL}`);
    } catch (err) {
      if (BROWSER_WS_ENDPOINT || BROWSER_CDP_URL_ENV || !Number.isFinite(BROWSER_DEBUG_PORT) || BROWSER_DEBUG_PORT <= 0) throw err;
      log(`Existing debug browser is not reachable; launching Edge with --remote-debugging-port=${BROWSER_DEBUG_PORT}`);
      // 用 spawn 启动 Edge（而非 puppeteer.launch），避免 chatgpt.com 检测到 Puppeteer 自动化标志
      // 后拒绝保持登录态。spawn 启动的 Edge 和用户手动启动的一样，不带 navigator.webdriver。
      const child = spawn(CHROME_PATH, [
        `--user-data-dir=${BROWSER_USER_DATA_DIR}`,
        // --profile-directory 必须和 --login / puppeteer.launch 保持一致，否则登录进 Profile A，
        // daemon spawn 却用 Default，cookie 不互通导致登录态丢失。
        BROWSER_PROFILE_DIRECTORY ? `--profile-directory=${BROWSER_PROFILE_DIRECTORY}` : null,
        `--remote-debugging-port=${BROWSER_DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        'https://chatgpt.com',
      ].filter(Boolean), { detached: true, stdio: 'ignore' });
      // spawn 的 error 事件不会通过 Promise 传播；监听后写日志，避免 ENOENT 时进程被 uncaughtException 杀掉。
      child.on('error', err => log(`Edge spawn failed: ${err.message}`));
      child.unref();
      // 轮询等待 CDP 端口可用，再通过 puppeteer.connect 连接（而非 puppeteer.launch 直接控制）。
      const cdpDeadline = Date.now() + 30_000;
      let cdpReady = false;
      while (Date.now() < cdpDeadline) {
        try { await ensureDevtoolsEndpointReachable(BROWSER_CDP_URL); cdpReady = true; break; }
        catch { await new Promise(r => setTimeout(r, 1_000)); }
      }
      // CDP 端口始终不可达说明 Edge 启动失败（路径错误、profile 损坏等）；直接抛错，避免后续 8s 空等。
      if (!cdpReady) throw new Error(`Edge did not open DevTools port ${BROWSER_DEBUG_PORT} within 30s. Check browser path: ${CHROME_PATH}`);
      // 额外等待 Edge 完成 profile/cookie 加载；CDP 端口可用只代表进程启动，cookie 数据库可能尚未载入内存。
      await new Promise(r => setTimeout(r, 8_000));
      return await withTimeout(puppeteer.connect({
        browserURL: BROWSER_CDP_URL,
        defaultViewport: null,
        protocolTimeout: RESPONSE_TIMEOUT,
      }), BROWSER_CONNECT_TIMEOUT_MS, `Timed out connecting to browser DevTools endpoint: ${BROWSER_CDP_URL}`);
    }
  }
  if (usesExternalBrowserProfile() && browserProfileLooksLocked()) {
    throw new Error(`Configured browser profile is already open without a reachable DevTools endpoint. Start Edge with --remote-debugging-port=${BROWSER_DEBUG_PORT || 9222}, set CHATGPT_BROWSER_CDP_URL/CHATGPT_BROWSER_WS_ENDPOINT, or close Edge before launching this daemon. Profile: ${BROWSER_USER_DATA_DIR}`);
  }
  // 没有 CDP 端口时只能复用同一个 user data dir 的登录态；若该 profile 正被普通 Edge 锁住，Chromium 会拒绝启动。
  // 这仍比插件私有空 profile 更符合用户预期：登录 cookie 来自指定 Edge profile，而不是重新登录。
  // 30s 超时防止 profile lock 或其他原因导致 puppeteer.launch 永久挂起（无超时时 daemon 会卡死直到被用户强杀）。
  return withTimeout(puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: BROWSER_USER_DATA_DIR,
    headless: false,
    args: browserLaunchArgs(),
    defaultViewport: null,
    protocolTimeout: RESPONSE_TIMEOUT,
  }), 30_000, 'Browser launch timed out');
}

function browserLaunchArgs() {
  return [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-extensions',
    '--disable-extensions-except=',
    // 阻止 Edge 弹出"恢复上次会话"对话框；多余标签页在启动后由 closeStalePages 统一清理。
    '--disable-session-crashed-bubble',
    '--restore-last-session=false',
    BROWSER_PROFILE_DIRECTORY ? `--profile-directory=${BROWSER_PROFILE_DIRECTORY}` : null,
    Number.isFinite(BROWSER_DEBUG_PORT) && BROWSER_DEBUG_PORT > 0 ? `--remote-debugging-port=${BROWSER_DEBUG_PORT}` : null,
  ].filter(Boolean);
}

function usesExternalBrowserProfile() {
  // 外部 profile 才可能和用户正在使用的 Edge 冲突；插件私有 profile 不需要这层保护。
  return path.resolve(BROWSER_USER_DATA_DIR) !== path.resolve(PROFILE_DIR);
}

function browserProfileLooksLocked() {
  // Edge/Chrome 在 user data dir 下放 lockfile/SingletonLock；存在时说明普通浏览器大概率正占用此 profile。
  // 若它已经带 DevTools 端口启动，上面的 connect 会先成功，不会走到这里。
  return ['lockfile', 'SingletonLock'].some(name => fs.existsSync(path.join(BROWSER_USER_DATA_DIR, name)));
}

async function ensureDevtoolsEndpointReachable(browserURL) {
  // browserURL 模式下先做 TCP 探测；Puppeteer.connect 在 Windows 防火墙/无监听端口时可能拖到外层超时。
  const url = new URL(browserURL);
  await tcpConnect(url.hostname || '127.0.0.1', Number(url.port || 80));
}

function withTimeout(promise, timeout, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); }),
  ]).finally(() => clearTimeout(timer));
}

// voice 转写的客户端断开检测:轮询 shouldCancel,断开时 reject 让 Promise.race 中止转写。
// 必须通过返回的 .stop() 在 finally 中清除定时器,否则成功路径会永久轮询泄漏。
function cancelSignal(shouldCancel, pollMs) {
  let timer;
  const promise = new Promise((_, reject) => {
    const check = () => {
      if (shouldCancel()) reject(new Error('Voice transcription cancelled: client disconnected'));
      else timer = setTimeout(check, pollMs);
    };
    timer = setTimeout(check, pollMs);
  });
  promise.stop = () => clearTimeout(timer);
  return promise;
}

function tcpConnect(host, port) {
  // 连接成功就立即断开；真正的 DevTools 协议握手仍交给 Puppeteer，避免这里复制协议细节。
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`DevTools endpoint is not reachable: ${host}:${port}`));
    }, BROWSER_CONNECT_TIMEOUT_MS);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('error', err => { clearTimeout(timer); reject(err); });
  });
}

function positiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultBrowserPath() {
  // 和 CLI 使用同一套发现顺序；Mac/Linux 不应因为 Windows 默认路径而必须额外写 MCP env。
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : process.platform === 'win32'
      ? [
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : [
          '/usr/bin/microsoft-edge',
          '/usr/bin/microsoft-edge-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
        ];
  return candidates.find(file => file && fs.existsSync(file)) || candidates.find(Boolean);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Windows chmod 不是完整 ACL 管理，但仍尽力压低 POSIX/WSL/类 Unix 环境下的目录权限。
  fs.chmodSync(dir, 0o700);
  lockDownWindowsAcl(dir, true);
}

function ensureWorkspaceCacheDir(workspaceDir, dir) {
  // workspaceDir 通过 realpath 校验还不够：.opencode/cache 中途若是 symlink/junction，写入会逃出 workspace。
  // 因此 cache 目录逐级创建并逐级 realpath 复核，发现既有链接越界就拒绝本次保存。
  const root = resolveWorkspaceDir(workspaceDir);
  const rootReal = fs.realpathSync.native(root);
  const target = path.resolve(dir);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`cache directory is outside workspace: ${dir}`);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      // cache 路径必须是真目录；即使链接目标仍在 workspace 内，也会让生成产物出现在文档承诺之外的位置。
      if (stat.isSymbolicLink()) throw new Error(`cache path must not be a symlink or junction: ${current}`);
      if (!stat.isDirectory()) throw new Error(`cache path is not a directory: ${current}`);
    } else {
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const real = fs.realpathSync.native(current);
    if (!pathInside(rootReal, real)) throw new Error(`cache path escapes workspace through symlink or junction: ${current}`);
  }
  fs.chmodSync(target, 0o700);
}

function uploadRoots() {
  const value = process.env.CHATGPT_UPLOAD_ROOTS || '';
  return value.split(path.delimiter).map(item => item.trim()).filter(Boolean).map(item => path.resolve(item));
}

function defaultUploadRoot(workspaceDir) {
  return path.join(resolveWorkspaceDir(workspaceDir), '.opencode', 'cache', 'chatgpt', 'uploads');
}

function workspaceRoots() {
  // OpenCode 本体 daemon 会按 instance directory 启动 MCP；ChatGPT browser daemon 却是全局共享的。
  // 因此 workspace allowlist 只能是显式部署策略，不能默认锁死到“第一个启动 daemon 的项目”。
  const value = process.env.CHATGPT_WORKSPACE_ROOTS || '';
  return value.split(path.delimiter).map(item => item.trim()).filter(Boolean).map(item => path.resolve(item));
}

function voiceFileRoots() {
  // voice route 只服务 OpenCode TUI 录音临时文件；默认 root 与 opencode Global.Path.tmp/voice 对齐。
  // 额外 root 必须显式配置，避免 bearer token 持有者把任意 WAV 路径发给 ChatGPT 听写。
  const explicit = (process.env.CHATGPT_VOICE_FILE_ROOTS || '').split(path.delimiter).map(item => item.trim()).filter(Boolean).map(item => path.resolve(item));
  return [path.join(os.tmpdir(), 'opencode', 'voice'), ...explicit].map(root => path.resolve(root));
}

function realWorkspaceRoots() {
  // 每次请求时 realpath，而不是启动时缓存：用户移动/挂载盘符时能给出当前准确错误。
  return WORKSPACE_ROOTS.map(root => {
    try { return fs.realpathSync.native(root); }
    catch { throw new Error(`workspace root does not exist: ${root}`); }
  });
}

function validateWorkspaceDir(value) {
  // workspaceDir 来自 OpenCode MCP wrapper 的当前 cwd；全局 browser daemon 不能把它锁死到 daemon 启动目录。
  // 只有显式配置 CHATGPT_WORKSPACE_ROOTS 时才收窄范围；默认策略交给 OpenCode 本体的权限层决定。
  const requested = path.resolve(value || process.cwd());
  const requestedReal = fs.realpathSync.native(requested);
  const configuredRoots = realWorkspaceRoots();
  if (configuredRoots.length === 0) return resolveWorkspaceDir(requested);
  const allowedRoots = configuredRoots;
  if (!allowedRoots.some(allowed => pathInside(allowed, requestedReal))) throw new Error(`workspaceDir is outside allowed roots: ${value}`);
  const root = resolveWorkspaceDir(requested);
  const real = fs.realpathSync.native(root);
  if (!allowedRoots.some(allowed => pathInside(allowed, real))) throw new Error(`workspaceDir is outside allowed roots: ${value}`);
  return root;
}

function realUploadRoots(workspaceDir) {
  // root 每次上传时再 realpath，避免启动时因为 staging 目录短暂缺失导致整个 MCP server 不可用。
  return [...EXPLICIT_UPLOAD_ROOTS, defaultUploadRoot(workspaceDir)].map(root => {
    try { return fs.realpathSync.native(root); }
    catch { throw new Error(`upload root does not exist: ${root}`); }
  });
}

function assertUploadFileSafe(file, workspaceDir) {
  // daemon 是最后一道外发边界：即使调用者拿到了 bearer token 直接 POST /ask，
  // 也必须重新执行 root、realpath、regular file 和大小校验，不能只相信 MCP wrapper。
  const real = fs.realpathSync.native(path.resolve(file));
  if (!realUploadRoots(workspaceDir).some(root => pathInside(root, real))) throw new Error(`upload file is outside allowed roots: ${file}`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`upload path is not a regular file: ${file}`);
  // daemon 也不检查扩展名；否则直连 /ask 与 MCP wrapper 会在“无扩展文件”上给出不一致行为。
  if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`upload file is too large: ${file}; limit is ${MAX_UPLOAD_BYTES} bytes`);
  return real;
}

function defaultUserDataDir() {
  // 会话索引用用户级目录而不是项目目录，这样从任意 OpenCode 工作区都能用同一个 #id 恢复远端会话。
  // OPENCODE_DATA_DIR 若被配置到项目内，会把全局 session registry 变成可误提交文件；默认路径要 fail-safe。
  if (process.env.OPENCODE_DATA_DIR && !runtimeUnsafeRoots().some(root => pathInside(root, process.env.OPENCODE_DATA_DIR))) return path.join(process.env.OPENCODE_DATA_DIR, 'chatgpt-browser-agent');
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'opencode', 'chatgpt-browser-agent');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'chatgpt-browser-agent');
}

function defaultStateDir() {
  return path.join(defaultUserDataDir(), 'state');
}

function runtimeUnsafeRoots() {
  // daemon 可能由 MCP host 从任意 cwd 启动；workspace env 比 process.cwd() 更接近真实项目边界。
  return [process.cwd(), __dirname, process.env.CHATGPT_WORKSPACE_DIR, ...(process.env.CHATGPT_WORKSPACE_ROOTS || '').split(path.delimiter)].filter(Boolean).map(item => path.resolve(item));
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeProjectKey(value) {
  // Project 名可能来自 URL、缓存、侧边栏文本或中文项目名；统一成宽松 key，减少显示名差异导致的找不到项目。
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readJSON(file, fallback) {
  // 缓存文件损坏时回退默认结构，而不是让 daemon 启动失败；Project cache 可再生，session index 也能重新创建。
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, value) {
  // 先写同目录临时文件再 rename；Windows 同卷 rename 原子，能避免进程被杀时留下半截 JSON。
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  // rename 后再 chmod 一次，覆盖已有文件继承到的宽权限；Windows 会尽力映射，POSIX 则严格落到 0600。
  fs.chmodSync(file, 0o600);
  lockDownWindowsAcl(file, false);
}

function lockDownWindowsAcl(target, directory) {
  // Windows 下 chmod 可能保留额外组 ACL；icacls best-effort 收窄到当前用户和系统管理员。
  if (process.platform !== 'win32') return;
  const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) return;
  const grants = directory ? [`${user}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F'] : [`${user}:(F)`, 'SYSTEM:(F)', 'Administrators:(F)'];
  try { execFileSync('icacls', [target, '/inheritance:r', ...grants.map(grant => `/grant:r ${grant}`)], { stdio: 'ignore', windowsHide: true }); }
  catch {}
}

function withJSONFileLock(file, task) {
  const lock = `${file}.lock`;
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + JSON_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeFileSync(fd, token, 'utf8');
      try { return task(); }
      finally {
        try { fs.closeSync(fd); } catch {}
        try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch {}
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try { if (isStaleLock(lock, 10_000)) fs.unlinkSync(lock); } catch {}
      // 只兜底异常多进程/误双开 daemon；同一进程内 registry 写入本来就是短同步临界区。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  throw new Error(`Timed out waiting for JSON lock: ${lock}`);
}

function isStaleLock(file, maxAge) {
  // registry lock 保护 pending/lost 语义；活进程持有的旧锁不能被第二进程按时间强拆。
  if (Date.now() - fs.statSync(file).mtimeMs <= maxAge) return false;
  const pid = Number((fs.readFileSync(file, 'utf8').split(':')[0] || '').trim());
  return !pid || !isProcessAlive(pid);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

function readSessionJSON(file) {
  if (!fs.existsSync(file)) return { sessions: {} };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    const backup = `${file}.broken-${Date.now()}`;
    // 损坏索引可能仍包含 conversation URL；备份用于诊断，但权限和生命周期必须按敏感元数据处理。
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600);
    lockDownWindowsAcl(backup, false);
    return { sessions: {}, corruptBackup: backup, recoveredFromCorrupt: backup, parseError: err.message };
  }
}

// ─── Project Registry ─────────────────────────────────────────────────────────

function normalizeSessionID(value) {
  // 对模型只暴露短句柄，避免把 ChatGPT 的真实 conversation URL 泄漏进 schema。
  if (!value) return null;
  const body = String(value).trim().toLowerCase().replace(/^#/, '');
  if (/^[a-f0-9]{6}$/.test(body)) return `#${body}0000`;
  if (/^[a-f0-9]{10}$/.test(body)) return `#${body}`;
  throw new Error('sessionID must be a short handle like #4fa92c9d10');
}

function legacySessionID(id) {
  const body = String(id || '').trim().toLowerCase().replace(/^#/, '');
  return /^[a-f0-9]{6}$/.test(body) ? `#${body}0000` : null;
}

function migrateSessionIndexFile() {
  // 早期版本生成 6 位 #id；直接拒绝会让 pending recovery 失效。迁移采用 deterministic 后缀，
  // 让旧输入 #abcdef 归一到 #abcdef0000，同时新会话继续使用高熵 10 位随机句柄。
  if (!fs.existsSync(SESSION_INDEX_FILE)) return;
  const index = readSessionJSON(SESSION_INDEX_FILE);
  if (index.recoveredFromCorrupt) writeJSON(SESSION_INDEX_FILE, { sessions: {}, corruptBackup: index.recoveredFromCorrupt, corruptAt: new Date().toISOString() });
  if (!index?.sessions) return;
  let changed = false;
  for (const [id, entry] of Object.entries(index.sessions)) {
    const next = legacySessionID(id);
    if (!next) continue;
    if (!index.sessions[next]) index.sessions[next] = { ...entry, legacySessionID: id };
    delete index.sessions[id];
    changed = true;
  }
  if (changed) writeJSON(SESSION_INDEX_FILE, index);
}

function compactSessionIndexFile() {
  // registry 是全局便利索引，不是永久审计日志；定期压掉 stale pending 和最旧的普通会话，降低隐私残留。
  if (!fs.existsSync(SESSION_INDEX_FILE)) return;
  withJSONFileLock(SESSION_INDEX_FILE, () => {
    const index = readSessionJSON(SESSION_INDEX_FILE);
    if (!index?.sessions) return;
    let changed = false;
    const now = Date.now();
    for (const [id, entry] of Object.entries(index.sessions)) {
      const savedAt = Date.parse(entry.pending?.savedAt || '');
      if (entry.pending && (!savedAt || now - savedAt > SESSION_MAX_AGE_MS)) {
        // pending TTL 用于 live 恢复策略；registry 只在超过全局会话保留期后删除陈旧条目。
        delete index.sessions[id];
        changed = true;
      }
      const lostAt = Date.parse(entry.lost?.savedAt || '');
      if (entry.lost && (!lostAt || now - lostAt > SESSION_MAX_AGE_MS)) {
        // lost 墓碑阻止静默重发，但不是永久审计记录；过期后删除，避免失败 URL 无限堆积。
        delete index.sessions[id];
        changed = true;
      }
    }
    const removable = Object.entries(index.sessions)
      .filter(([, entry]) => !entry.pending && !entry.lost)
      .sort((a, b) => sessionSortTime(a[1]) - sessionSortTime(b[1]));
    for (const [id, entry] of removable) {
      if (now - sessionSortTime(entry) > SESSION_MAX_AGE_MS) {
        delete index.sessions[id];
        changed = true;
      }
    }
    // pending 比普通历史更有安全含义；数量上限先删普通条目，再删最旧 lost 墓碑，避免无限增长。
    const capRemovable = Object.entries(index.sessions).filter(([, entry]) => !entry.pending).sort((a, b) => sessionSortTime(a[1]) - sessionSortTime(b[1]));
    while (Object.keys(index.sessions).length > MAX_SESSION_ENTRIES && capRemovable.length > 0) {
      delete index.sessions[capRemovable.shift()[0]];
      changed = true;
    }
    if (changed) writeJSON(SESSION_INDEX_FILE, index);
  });
  pruneBrokenSessionBackups();
}

function pruneBrokenSessionBackups() {
  // readSessionJSON 无锁也可能生成备份；压缩阶段顺手清理同目录旧备份，避免另建后台任务。
  if (!fs.existsSync(SESSION_DIR)) return;
  const prefix = `${path.basename(SESSION_INDEX_FILE)}.broken-`;
  for (const name of fs.readdirSync(SESSION_DIR).filter(item => item.startsWith(prefix))) {
    const file = path.join(SESSION_DIR, name);
    try { if (Date.now() - fs.statSync(file).mtimeMs > SESSION_MAX_AGE_MS) fs.rmSync(file, { force: true }); }
    catch {}
  }
}

function sessionSortTime(entry) {
  return Date.parse(entry.updatedAt || entry.createdAt || '') || 0;
}

function parseProjectRef(value, name) {
  // 支持完整 URL、g-p-id、g-p-id-slug 三种输入；解析结果只描述固定 Project，不表示某个 conversation。
  const input = String(value || '').trim();
  const token = input.match(/\/g\/(g-p-[^/]+)(?:\/|$)/)?.[1]
    || input.match(/^(g-p-[a-z0-9]+(?:-[a-z0-9-]+)?)$/i)?.[1];
  if (!token) return;
  const id = token.match(/^(g-p-[a-z0-9]+)/i)?.[1];
  if (!id) return;
  // ChatGPT 改版后 /project 是设置页,/c/new 会被 SPA 重定向到 /project;
  // 用 chatgpt.com/ 主页(有干净聊天 composer,不重定向)作为新会话入口。
  // 项目上下文通过登录态 cookie 隐式传递;如需显式项目,用户可配置 CHATGPT_PROJECT 指向特定对话 URL。
  const url = CHATGPT_URL;
  const title = name || token.replace(id, '').replace(/^-/, '') || id;
  return { id, token, key: normalizeProjectKey(title || id), name: title, url };
}

function projectIdFromUrl(url) {
  return parseProjectRef(url)?.id;
}

function isChatSessionUrlForProject(url, project, options = {}) {
  // /c/new 是项目内新建对话的 transient URL,ChatGPT 尚未将其改为 /c/{convId};
  // 如果允许它通过,rememberCurrentSessionUrl 会在提交后立即记录 /c/new 而非真实会话 URL,
  // 导致后续 restoreSessionPage 导航到 /c/new 创建新对话而非恢复已有对话。
  if (/\/c\/new(?:[?#]|$)/.test(url)) return false;
  // 当前页面必须严格带 Project id；已登记条目可接受普通 /c/...，因为 projectID 已单独保存在 registry。
  if (!/\/c\//.test(url)) return false;
  const id = projectIdFromUrl(url);
  return id ? id === project.id : options.allowPlain === true;
}

function readProjectCache() {
  // projects.json 只是加速固定 Project 解析；结构不对时丢弃缓存，重新通过 DOM adapter 发现。
  const cache = readJSON(PROJECTS_FILE, { projects: {} });
  return cache && typeof cache === 'object' && cache.projects ? cache : { projects: {} };
}

function cacheProject(project) {
  // 同一个 Project 同时按 id、token、显示名 key 缓存，兼容用户传 URL、短名或完整 token。
  withJSONFileLock(PROJECTS_FILE, () => {
    const cache = readProjectCache();
    const keys = new Set([project.id, project.token, project.key, normalizeProjectKey(project.name)]);
    for (const key of keys) {
      if (key) cache.projects[key] = project;
    }
    writeJSON(PROJECTS_FILE, cache);
  });
}

// ─── Session Registry and Project Cache ──────────────────────────────────────

function readSessionIndex() {
  // sessions.json 是用户级 registry；只保存短句柄到远端 URL 的映射和 pending 元数据，不保存回答正文。
  const index = readSessionJSON(SESSION_INDEX_FILE);
  return index && typeof index === 'object' && index.sessions ? index : { sessions: {} };
}

function createSessionID() {
  // 10 位 hex 仍然短，但避免 24-bit 句柄被轻易枚举；生成时做碰撞检查。
  compactSessionIndexFile();
  const index = readSessionIndex();
  for (let i = 0; i < 20; i++) {
    const id = `#${crypto.randomBytes(5).toString('hex')}`;
    if (!index.sessions[id]) return id;
  }
  throw new Error('Could not allocate a unique ChatGPT sessionID');
}

function readSessionEntry(sessionID, project) {
  // 读取时再次校验 Project，避免相同 #id 在不同固定 Project 下误恢复到错误页面。
  // daemon 可以运行很久；读路径也触发轻量压缩，避免过期 pending 只在重启时消失。
  compactSessionIndexFile();
  const entry = readSessionIndex().sessions[sessionID];
  if (entry?.projectID && entry.projectID !== project.id) throw new Error(`Session ${sessionID} belongs to another ChatGPT project; start a new sessionID for ${project.name}.`);
  if (entry?.lost && entry.projectID === project.id) return entry;
  return entry && isChatSessionUrlForProject(entry.url, project, { allowPlain: true }) ? entry : null;
}

function writeSessionEntry(sessionID, project, url, updates = {}) {
  // URL 更新不能默认清掉 pending；只有显式传 pending:null 才表示 recovery 已确认完成。
  withJSONFileLock(SESSION_INDEX_FILE, () => {
    const index = readSessionIndex();
    const now = new Date().toISOString();
    const previous = index.sessions[sessionID];
    index.sessions[sessionID] = {
      url,
      project: project.name,
      projectID: project.id,
      projectURL: project.url,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    if (updates.pending === undefined && previous?.pending) index.sessions[sessionID].pending = previous.pending;
    if (updates.pending) index.sessions[sessionID].pending = updates.pending;
    if (updates.pending === null) delete index.sessions[sessionID].pending;
    if (updates.completed === undefined && previous?.completed) index.sessions[sessionID].completed = previous.completed;
    if (updates.completed) index.sessions[sessionID].completed = updates.completed;
    if (updates.completed === null) delete index.sessions[sessionID].completed;
    if (updates.lost) index.sessions[sessionID].lost = updates.lost;
    // 一旦拿到可信 conversation URL，旧 lost 墓碑必须消失；否则成功发送后的会话也无法续聊。
    if (updates.lost === null || (url && previous?.lost && updates.lost === undefined)) delete index.sessions[sessionID].lost;
    writeJSON(SESSION_INDEX_FILE, index);
  });
  compactSessionIndexFile();
}

// ─── Project Artifact Paths ──────────────────────────────────────────────────

function markSessionPending(sessionID, project, url, savedResponse, options = {}) {
  // pending 是“下一次同 session 先恢复”的保护标记，即使没有文本快照也要记录远端仍可能在生成。
  // 原生图片需要发送前 URL 快照；否则恢复 image-only 回答时会把同会话旧图重新收集一遍。
  writeSessionEntry(sessionID, project, url, {
    lost: null,
    completed: options.preserveCompleted ? undefined : null,
    pending: {
      status: 'generating',
      savedAt: new Date().toISOString(),
      savedResponse: savedResponse || null,
      nativeImageURLs: Array.isArray(options.nativeImageURLs) ? options.nativeImageURLs : undefined,
    },
  });
}

function clearSessionPending(sessionID, project, url) {
  writeSessionEntry(sessionID, project, url, { pending: null });
}

function markSessionCompleted(sessionID, project, url, requestHash, savedResponse, downloads) {
  if (!requestHash) return clearSessionPending(sessionID, project, url);
  // completed 只记录可恢复的本地 snapshot 指针和 requestHash；registry 仍不承载正文内容。
  // 这样同 prompt 丢包重试可以避免重复发送，普通历史清理也不会变成回答归档系统。
  writeSessionEntry(sessionID, project, url, {
    pending: null,
    completed: {
      requestHash,
      savedAt: new Date().toISOString(),
      savedResponse,
      downloads,
    },
  });
}

function markSessionLost(sessionID, project, reason) {
  // lost 是“禁止静默复用”的墓碑：如果 prompt 已可能发出但没有 /c/... URL，重启后同 ID 不能新建会话。
  // live daemon 仍可在 page.url() 变成 conversation 后补回映射；离开当前浏览器进程则只能让用户新开 session。
  const previous = readSessionIndex().sessions[sessionID];
  // 已知 URL 的旧会话不能被 send-start 覆盖成 lost；pending recovery 才是正确的“不重发”语义。
  if (previous?.url && isChatSessionUrlForProject(previous.url, project, { allowPlain: true })) {
    markSessionPending(sessionID, project, previous.url, null);
    return;
  }
  writeSessionEntry(sessionID, project, previous?.url || null, {
    pending: null,
    completed: null,
    lost: { savedAt: new Date().toISOString(), reason },
  });
}

function isPendingFresh(pending) {
  const savedAt = Date.parse(pending?.savedAt || '');
  return Number.isFinite(savedAt) && Date.now() - savedAt <= PENDING_TTL_MS;
}

function isCompletedFresh(completed, requestHash) {
  // completed 是短期幂等缓存，不是“同样的问题永远不准再问”。TTL 过后完全按普通续聊处理。
  // requestHash 不匹配时立即放行，确保用户改一个字或换附件都会成为新的 ChatGPT turn。
  const savedAt = Date.parse(completed?.savedAt || '');
  return completed?.requestHash === requestHash && Number.isFinite(savedAt) && Date.now() - savedAt <= COMPLETED_RETRY_TTL_MS;
}

function validateAskInput(input) {
  // /ask 是本地 HTTP API，不只是 mcp-server 的内部函数。所有 schema/路径/保存目录约束
  // 都在 daemon 侧再做一遍，防止 token 持有者绕过 CLI/MCP 的参数校验直接驱动浏览器上传。
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('/ask body must be an object');
  if (typeof input.fullPrompt !== 'string' || !input.fullPrompt.trim()) throw new Error('fullPrompt must be a non-empty string');
  if (input.fullPrompt.length > MAX_FULL_PROMPT_CHARS) throw new Error(`fullPrompt is too large; limit is ${MAX_FULL_PROMPT_CHARS} characters`);
  const rawUploads = input.uploadPaths || input.uploadPath;
  const uploads = rawUploads ? (Array.isArray(rawUploads) ? rawUploads : [rawUploads]) : [];
  // uploadPaths 不做 String() 宽松转换；对象/数字变成伪路径会让安全日志和用户预期都失真。
  if (uploads.some(item => typeof item !== 'string' || !item.trim())) throw new Error('uploadPaths entries must be non-empty strings');
  if (uploads.length > MAX_UPLOAD_FILES) throw new Error(`uploadPaths accepts at most ${MAX_UPLOAD_FILES} files`);
  if (input.workspaceDir != null && typeof input.workspaceDir !== 'string') throw new Error('workspaceDir must be a string');
  if (input.newSession != null && typeof input.newSession !== 'boolean') throw new Error('newSession must be a boolean');
  if (input.mode != null && (typeof input.mode !== 'string' || !ASK_MODES.has(input.mode))) throw new Error(`mode must be one of: ${[...ASK_MODES].join(', ')}`);
  if (input.imageAspectRatio != null && (typeof input.imageAspectRatio !== 'string' || !IMAGE_ASPECT_RATIOS.has(input.imageAspectRatio))) throw new Error(`imageAspectRatio must be one of: ${[...IMAGE_ASPECT_RATIOS].join(', ')}`);
  // 只给 imageAspectRatio 一个“隐式打开 image mode”的捷径；显式 auto+ratio 必须报错，避免文本模式隐藏切图。
  const mode = input.mode || (input.imageAspectRatio ? 'image' : 'auto');
  if (input.imageAspectRatio && mode !== 'image') throw new Error('imageAspectRatio requires mode=image or omitted mode');
  const workspaceDir = input.workspaceDir ? path.resolve(input.workspaceDir) : process.cwd();
  if (!path.isAbsolute(workspaceDir)) throw new Error(`workspaceDir must be absolute: ${workspaceDir}`);
  const safeWorkspaceDir = validateWorkspaceDir(workspaceDir);
  // saveToFile 只接受严格 true；其它 truthy 值不会改变返回形态，保持 MCP schema 和 daemon API 一致。
  return {
    ...input,
    fullPrompt: input.fullPrompt,
    uploadPaths: safeUploadPaths(uploads, safeWorkspaceDir),
    workspaceDir: safeWorkspaceDir,
    saveToFile: input.saveToFile === true,
    newSession: input.newSession === true || !input.sessionID,
    mode,
    imageAspectRatio: input.imageAspectRatio || null,
  };
}

function validateVoiceInput(input) {
  // /voice/transcribe-file 是 TUI 私有 side-channel，不经过 MCP schema；daemon 仍要当作本地 HTTP API 校验。
  // 这里只接受一个已存在的 WAV 文件，避免 bearer token 持有者把任意路径当作 prompt 或附件读取。
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('/voice/transcribe-file body must be an object');
  if (typeof input.file !== 'string' || !input.file.trim()) throw new Error('file must be a non-empty string');
  const abs = path.resolve(input.file);
  let real;
  try { real = fs.realpathSync.native(abs); }
  catch { throw new Error(`Voice file does not exist: ${input.file}`); }
  if (!VOICE_FILE_ROOTS.some(root => {
    // macOS 上 os.tmpdir() 返回 /var/...，但 realpathSync 返回 /private/var/...；
    // root 不做 realpath 会导致 pathInside 比较失败，误报 "outside allowed roots"。
    let realRoot = root;
    try { realRoot = fs.realpathSync.native(root); } catch {}
    return pathInside(realRoot, real);
  })) throw new Error(`Voice file is outside allowed roots: ${input.file}`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`Voice path is not a regular file: ${input.file}`);
  if (stat.size > MAX_VOICE_FILE_BYTES) throw new Error(`Voice file is too large: ${real}; limit is ${MAX_VOICE_FILE_BYTES} bytes`);
  const fd = fs.openSync(real, 'r');
  const header = Buffer.alloc(12);
  try { fs.readSync(fd, header, 0, header.length, 0); }
  finally { fs.closeSync(fd); }
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`Voice file must be a WAV file: ${real}`);
  return { file: real };
}

function safeUploadPaths(uploads, workspaceDir) {
  const safe = uploads.map(file => assertUploadFileSafe(file, workspaceDir));
  assertUniqueBasenames(safe);
  const uploadBytes = safe.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  // daemon 侧重复总量校验，防止直连 bearer token 绕过 MCP wrapper 后一次塞入多份大文件。
  // 这里和 per-file cap 互补：前者防单个巨物，后者防批量资源耗尽。
  if (uploadBytes > MAX_TOTAL_UPLOAD_BYTES) throw new Error(`total upload size is too large; limit is ${MAX_TOTAL_UPLOAD_BYTES} bytes`);
  return safe;
}

function assertUniqueBasenames(files) {
  const names = files.map(file => path.basename(file).toLowerCase());
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error(`upload files must have distinct basenames because ChatGPT composer identifies attachments by filename: ${duplicate}`);
}

function sameUrl(a, b) {
  return String(a || '').replace(/[#?].*$/, '').replace(/\/$/, '') === String(b || '').replace(/[#?].*$/, '').replace(/\/$/, '');
}

function resolveWorkspaceDir(value) {
  // 优先把产物写到 git 根目录的 .opencode/cache；非 git 项目也允许使用，退回传入目录。
  const cwd = path.resolve(value || process.cwd());
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || cwd; }
  catch { return cwd; }
}

function sessionCacheDirs(workspaceDir, sessionID) {
  // ChatGPT 相关输入/输出都归到同一个项目 cache 根：uploads、responses、downloads 分目录隔离。
  const root = path.join(resolveWorkspaceDir(workspaceDir), '.opencode', 'cache', 'chatgpt');
  return {
    uploads: path.join(root, 'uploads'),
    responses: path.join(root, 'responses', sessionID),
    downloads: path.join(root, 'downloads', sessionID),
  };
}

function timestampName(ext) {
  // 同一秒内可能发生 pending recovery + 正常保存；毫秒和短随机后缀一起避免静默覆盖。
  return `${new Date().toISOString().replace(/:/g, '-')}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
}

function saveResponseToFile(text, workspaceDir, sessionID) {
  // 保存文件名只用时间戳，不让模型控制路径；这样 saveToFile 是布尔能力，不是任意文件写入能力。
  const dir = sessionCacheDirs(workspaceDir, sessionID).responses;
  ensureWorkspaceCacheDir(workspaceDir, dir);
  const file = path.join(dir, timestampName('md'));
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { path: file, ...textStats(text) };
}

function textStats(text) {
  return {
    chars: text.length,
    lines: text ? text.split(/\r\n|\r|\n/).length : 0,
  };
}

/**
 * 给“刚完成的同一请求”做短期幂等指纹。
 *
 * 这里刻意不引入 MCP request id：JSON-RPC id 只在一次连接内稳定，host 超时重试时
 * 往往会换 id。真正能表达“这是同一条用户意图”的，是展开后的 prompt、composer mode
 * 以及附件的本地路径/大小/mtime。hash 只进 registry，不保存 prompt 和附件内容。
 */
function requestHash(fullPrompt, files, mode = 'auto', imageAspectRatio = null) {
  const hash = crypto.createHash('sha256');
  hash.update(`mode:${mode || 'auto'}\0`);
  // 同一 prompt 生成方图和宽屏图不是同一次意图；ratio 必须进入短期幂等指纹。
  hash.update(`imageAspectRatio:${imageAspectRatio || ''}\0`);
  hash.update(fullPrompt);
  for (const file of files) {
    const stat = fs.statSync(file);
    // 附件内容不进 registry；路径、大小和 mtime 足够区分“同 prompt、同附件”的短期重试。
    hash.update(`\0${path.resolve(file)}\0${stat.size}\0${stat.mtimeMs}`);
  }
  return hash.digest('hex');
}

function readSavedResponse(workspaceDir, sessionID, savedResponse) {
  if (!savedResponse?.path) return null;
  const file = path.resolve(savedResponse.path);
  const root = path.resolve(sessionCacheDirs(workspaceDir, sessionID).responses);
  if (!pathInside(root, file) || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function completedReplayResult(entry, workspaceDir, sessionID, saveToFile) {
  // replay 只读已经落盘的 snapshot；如果文件被用户清理，就退回普通续聊，绝不凭 hash 编造回答。
  const raw = readSavedResponse(workspaceDir, sessionID, entry.completed.savedResponse);
  if (!raw) return null;
  const savedResponse = entry.completed.savedResponse;
  return {
    ok: true,
    response: saveToFile ? '' : raw.length > MAX_RETURN_CHARS
      ? `${previewResponse(raw)}\n\n[Repeated request recovered from the last completed local snapshot. Lines: ${savedResponse.lines}; Characters: ${savedResponse.chars}.]`
      : raw,
    downloads: entry.completed.downloads || [],
    savedResponse,
    sessionID,
    status: 'completed',
    notice: 'Repeated prompt matched the last completed request; recovered locally without sending a duplicate prompt.',
    promptSent: false,
  };
}

function previewResponse(text) {
  // 预览截断前已经保存全文；这里截断是为了避免 OpenCode 工具输出再次走不可控截断路径。
  if (text.length <= RESPONSE_PREVIEW_CHARS) return text;
  return `${text.slice(0, RESPONSE_PREVIEW_CHARS).trimEnd()}\n\n[Preview truncated locally before returning to OpenCode.]`;
}

// ─── Project Resolution ──────────────────────────────────────────────────────

function resolveCachedProject(requested) {
  // 启动热路径先读本地 projects.json；缓存命中时不打开首页、不展开侧边栏，直接进入固定 Project。
  // 这不是安全边界，只是性能缓存；缓存缺失或失效时仍走 resolveProject 的 DOM 发现路径。
  const value = String(requested || DEFAULT_PROJECT).trim();
  const direct = parseProjectRef(value);
  if (direct) return direct;
  const cached = readProjectCache().projects[normalizeProjectKey(value)];
  if (cached) {
    // 缓存中的 URL 可能是旧的 /project(ChatGPT 改版前的设置页);
    // 用 parseProjectRef 修正为 /c/new,确保导航到聊天页而非设置页。
    const fixed = parseProjectRef(cached.url, cached.name);
    if (fixed) return fixed;
  }
  return cached || null;
}

async function resolveProject(page, requested, log) {
  // Project 解析先走显式值和缓存；只有缓存缺失才打开 ChatGPT 首页扫描，减少对易变 DOM 的依赖。
  const value = String(requested || DEFAULT_PROJECT).trim();
  const cached = resolveCachedProject(value);
  if (cached) {
    cacheProject(cached);
    return cached;
  }
  const key = normalizeProjectKey(value);

  log(`Resolving ChatGPT project: ${value}`);
  const discovered = (await CHATGPT_DOM.discoverProjects(page, log))
    .map(project => parseProjectRef(project.href, project.name))
    .filter(Boolean)
    .filter((project, index, all) => all.findIndex(item => item.id === project.id) === index);
  for (const project of discovered) cacheProject(project);
  log(`Resolved ChatGPT project candidates: ${discovered.map(project => `${project.name}=${project.id}`).join(', ') || 'none'}`);
  const match = discovered.find(project =>
    normalizeProjectKey(project.name) === key ||
    project.key === key ||
    project.id === value ||
    project.token === value
  );
  if (match) return match;
  throw new Error(`Could not find ChatGPT project "${value}". Set CHATGPT_PROJECT to a project name or URL.`);
}

// ─── Response Persistence And Recovery ───────────────────────────────────────

async function rememberCurrentSessionUrl(page, project, sessionID, log, timeout = 20_000) {
  // 提交后尽早记录 /c/... URL；即使后续长回答超时，用户仍可用同一个 #id 回到远端生成中的页面。
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const url = page.url();
    if (isChatSessionUrlForProject(url, project)) {
      writeSessionEntry(sessionID, project, url);
      return url;
    }
    await sleep(500);
  }
  log(`Could not record conversation URL for ${sessionID}; current=${page.url()}`);
  return null;
}

/**
 * 构造最终返回给 CLI/MCP 的结构化结果。
 *
 * “保存全文”和“返回预览”是两个独立决策：saveToFile 会隐藏正文但保留路径，长文本
 * 会强制保存并返回短预览，generating 会强制保存当前快照。这个函数只处理文本形态，
 * 不触碰浏览器，也不下载 artifact。
 */
function buildResponseResult(raw, workspaceDir, sessionID, options = {}) {
  const shouldSave = raw && (options.forceSave || options.saveToFile || raw.length > MAX_RETURN_CHARS);
  const savedResponse = shouldSave ? saveResponseToFile(raw, workspaceDir, sessionID) : null;
  const response = options.saveToFile
    ? ''
    : raw && (options.forcePreview || raw.length > MAX_RETURN_CHARS)
      ? `${previewResponse(raw)}\n\n[${options.saveLabel || 'Full response saved locally before returning to OpenCode'}. Lines: ${savedResponse.lines}; Characters: ${savedResponse.chars}.]`
      : raw;
  return {
    ok: true,
    response,
    downloads: options.downloads || [],
    savedResponse,
    sessionID,
    status: options.status || 'completed',
    notice: options.notice || null,
    promptSent: options.promptSent !== false,
  };
}

/**
 * 持久化一次 assistant 状态，并同步 session 的 pending 标记。
 *
 * completed 才收集 sandbox/native-image 产物；generating 只保存文本快照。这个分界很重要：
 * 如果在远端工具调用未结束时强行点下载按钮，容易把半成品或旧文件误当成本次结果。
 */
async function persistAssistantResult({ page, project, workspaceDir, sessionID, raw, status, saveToFile, promptSent, requestHash, allowPlainUrl, notice, saveLabel, finalUrl, forceSave, forcePreview, shouldCancel = () => false, beforeState = null, log }) {
  const dirs = sessionCacheDirs(workspaceDir, sessionID);
  ensureWorkspaceCacheDir(workspaceDir, dirs.downloads);

  // artifact 下载会修改浏览器下载目录，因此只在最终态触发；生成中只保留文本和 pending 元数据。
  let artifactNotice = null;
  const artifactSkipped = status === 'completed' && shouldCancel();
  // 已完成但调用方断连时不清 pending：下次 recovery 还应有机会收集 sandbox/native-image 产物。
  const artifactResult = status === 'completed' && !artifactSkipped
    ? await CHATGPT_DOM.collectArtifacts(page, dirs.downloads, log, shouldCancel, beforeState).catch(err => ({ downloads: [], notices: [`Artifact collection failed: ${err.message}`] }))
    : { downloads: [], notices: shouldCancel() ? ['Artifact collection skipped because caller disconnected.'] : [] };
  const downloads = artifactResult.downloads || [];
  artifactNotice = (artifactResult.notices || []).join('\n') || null;
  // 某些 ChatGPT tool/mode 会生成空 assistant turn：页面已无 stop，但没有文本/文件。
  // 这应清掉 pending 并让调用方看到“空完成”，否则同一 #sessionID 会被永久恢复卡住。
  const emptyCompleted = status === 'completed' && !raw && downloads.length === 0 && !shouldCancel();
  const resolvedStatus = artifactSkipped ? 'generating' : raw || downloads.length > 0 || emptyCompleted ? status : 'generating';
  const result = buildResponseResult(raw, workspaceDir, sessionID, {
    saveToFile,
    downloads,
    status: resolvedStatus,
    promptSent,
    forceSave: forceSave || resolvedStatus === 'generating',
    forcePreview: forcePreview || resolvedStatus === 'generating',
    saveLabel,
    notice: [notice, artifactNotice].filter(Boolean).join('\n') || null,
  });

  if (!raw) {
    // 纯图片/文件产物没有 assistant 正文是正常情况；无文本无产物才说明远端仍可能在工具调用中。
    result.response = downloads.length > 0
      ? 'Assistant artifact saved locally.'
      : resolvedStatus === 'completed'
        ? 'Assistant completed without text or downloadable artifacts.'
      : 'No assistant text is available yet. ChatGPT may still be generating or processing a tool request.';
    result.savedResponse = downloads.length > 0 && (saveToFile || forceSave)
      ? saveResponseToFile([result.response, ...downloads.map(file => `- ${file.name}: ${file.path}`)].join('\n'), workspaceDir, sessionID)
      : null;
  }

  if (isChatSessionUrlForProject(finalUrl, project, { allowPlain: promptSent || allowPlainUrl })) {
    if (resolvedStatus === 'generating') markSessionPending(sessionID, project, finalUrl, result.savedResponse, { nativeImageURLs: beforeState?.nativeImageURLs });
    else markSessionCompleted(
      sessionID,
      project,
      finalUrl,
      requestHash,
      result.savedResponse || (raw
        ? saveResponseToFile(raw, workspaceDir, sessionID)
        : downloads.length > 0
          ? saveResponseToFile(['Assistant artifact saved locally.', ...downloads.map(file => `- ${file.name}: ${file.path}`)].join('\n'), workspaceDir, sessionID)
          : null),
      downloads,
    );
  } else if (promptSent) {
    markSessionLost(sessionID, project, 'Prompt may have been submitted, but no conversation URL was recorded.');
  }

  return result;
}

/**
 * 恢复一个可能仍在生成的会话。
 *
 * 这个函数是 pending suppression 的执行点：它只读取当前 DOM，保存可见文本和产物，
 * 明确返回 `promptSent:false`。调用方传进来的新 prompt 在这里不会进入 ChatGPT 页面。
 */
async function recoverCurrentAssistant(page, workspaceDir, sessionID, project, session, reason, log) {
  await CHATGPT_DOM.focus(page);
  const state = await CHATGPT_DOM.state(page);
  const unansweredUserMessage = state.userCount > state.count;
  const completedImageOnlyTurn = state.nativeImageCount > 0 && !state.generating && !state.placeholder;
  const completedEmptyAssistantTurn = state.emptyAssistantTurn && !state.generating && !state.placeholder;
  // 有未回答 user 消息时，lastText 属于上一轮 assistant；不能把旧回答当成本轮 recovery 结果。
  const raw = !unansweredUserMessage && state.lastText
    ? await CHATGPT_DOM.extractAssistant(page).catch(() => state.lastText)
    : '';
  const status = completedImageOnlyTurn || completedEmptyAssistantTurn ? 'completed' : state.generating || state.placeholder || unansweredUserMessage ? 'generating' : 'completed';
  const result = await persistAssistantResult({
    page,
    project,
    workspaceDir,
    sessionID,
    raw,
    status,
    finalUrl: state.url,
    promptSent: false,
    allowPlainUrl: true,
    forceSave: !!raw,
    forcePreview: !!raw,
    beforeState: { nativeImageURLs: Array.isArray(session?.pending?.nativeImageURLs) ? session.pending.nativeImageURLs : [] },
    log,
    saveLabel: status === 'generating'
      ? 'Current partial assistant response saved locally before returning to OpenCode'
      : 'Recovered final assistant response saved locally before returning to OpenCode',
    notice: `Prompt NOT sent: ${reason}`,
  });

  log(`Recovered ${sessionID}: status=${result.status} chars=${raw.length}`);
  return result;
}

// ─── Runtime Concurrency Model ────────────────────────────────────────────────

/**
 * 创建 daemon 运行时对象。
 *
 * runtime 把 page 绑定、同会话锁、新 conversation 创建锁和并发 detach 窗口封在一起，
 * HTTP handler 只需要调用 withSession/runAsk。这样并发规则不会散落到 DOM adapter 或 MCP wrapper。
 */
function createDaemonRuntime({ browser, bootstrapPage, project }) {
  // Runtime 是 daemon 的深模块：外部只看到 pageFor/withSession/waitForResponse/status。
  // 这里集中维护并发不变量，避免 HTTP handler、CLI、等待逻辑各自管理一套锁。
  const sessionPages = new Map();
  const sessionLocks = new Map();
  // voice fallback 活跃时 ask 的 foregroundPulse 跳过,避免抢前台干扰听写 UI;
  // 用对象持有避免闭包变量与 runtime 属性不匹配(flags 对象被两侧闭包共享)。
  const flags = { voiceFallbackActive: false };
  let conversationCreateQueue = Promise.resolve();
  let pageCreateQueue = Promise.resolve();
  let voiceLock = Promise.resolve();
  let sparePage = bootstrapPage;
  // voice 转写页持久化复用：direct path 只需 chatgpt.com 同源 cookie，不需要每次新建 tab + 导航项目页。
  // 持久化后首次转写 ~5s（含 goto），后续转写只需 ~2s（纯 API 调用）。
  let persistentVoicePage = null;
  // 页面创建时间：超过 VOICE_PAGE_MAX_AGE_MS 后主动重建，不等健康检查失败。
  // 主动重建比被动检测更快（跳过 5s 健康检查 + 3s 关闭 = 省 8s），且防止退化累积。
  let voicePageCreatedAt = 0;
  // 标记转写失败过的页面，TTL 5 分钟后允许重新测试（证据：页面自愈约 3 分钟）。
  // 避免坏页面被反复复用导致连续超时；TTL 到期后 fetch 探测会重新验证页面健康度。
  const badVoicePages = new Map();

  // pending 会话仍可能承载远端生成 DOM；registry 防重发，tab 保留则服务后续 artifact/text recovery。
  const pageCanBeClosed = id => !sessionLocks.has(id) && !isPendingFresh(readSessionEntry(id, project)?.pending);

  function assertBrowserConnected() {
    // browser 是 daemon 的核心资源；用户手动关掉窗口后继续复用 page handle 只会得到 Puppeteer 协议错误。
    // 在创建/复用页面前改成结构化错误，让 CLI 能安全丢弃 stale daemon，并只在无远端副作用的边界重试。
    if (browser.isConnected()) return;
    // BROWSER_DISCONNECTED 是 daemon/client 的本地协议码，不暴露给 ChatGPT，也不依赖 Puppeteer 错误文案。
    const error = new Error('Browser was closed; retry the request to start a new daemon.');
    error.code = 'BROWSER_DISCONNECTED';
    throw error;
  }

  const closeIdlePageIfNeeded = async () => {
    // 预留 3 个空位时就开始清理 idle 页面，避免到满负荷才回收导致新会话创建失败。
    // pageCanBeClosed 只允许关闭"无活跃锁且非 pending"的页面，不会影响正在使用或待恢复的会话。
    const proactiveThreshold = Math.max(1, MAX_SESSION_PAGES - 3);
    if (sessionPages.size < proactiveThreshold) return true;
    for (const [id, page] of sessionPages) {
      if (!pageCanBeClosed(id)) continue;
      sessionPages.delete(id);
      await page.close().catch(() => {});
      // 主动清理只关一个就够：不要在单次 pageFor 中批量关页面，避免阻塞新会话创建。
      return true;
    }
    return sessionPages.size < MAX_SESSION_PAGES;
  };

  async function createSessionPage() {
    if (!await closeIdlePageIfNeeded()) throw new Error(`Maximum active ChatGPT session pages reached (${MAX_SESSION_PAGES}); recover or wait for one pending session first: ${[...sessionPages.keys()].filter(id => isPendingFresh(readSessionEntry(id, project)?.pending)).join(', ') || 'none'}`);
    return browser.newPage();
  }

  return {
    project,
    status() {
      const pages = [...sessionPages.keys()];
      const pendingPages = pages.filter(id => isPendingFresh(readSessionEntry(id, project)?.pending));
      // status 默认只给数量，不泄露 #sessionID；调试句柄需要显式打开环境变量。
      return {
        // browserConnected 区分“Node daemon 还活着”和“可继续驱动 ChatGPT 页面”；status 仍只读，不触发重启。
        browserConnected: browser.isConnected(),
        // 下面仍保留原有 session 计数语义，避免 browser health 字段改变 status 的既有诊断输出结构。
        pageCount: pages.length,
        pendingPageCount: pendingPages.length,
        activeLocks: sessionLocks.size,
        maxPages: MAX_SESSION_PAGES,
        ...(process.env.CHATGPT_STATUS_SHOW_SESSIONS === '1' ? { pages, pendingPages } : {}),
      };
    },
    async pageFor(sessionID) {
      assertBrowserConnected();
      const current = sessionPages.get(sessionID);
      if (current && !current.isClosed()) {
        sessionPages.delete(sessionID);
        sessionPages.set(sessionID, current);
        return current;
      }

      const previous = pageCreateQueue;
      let release;
      // newPage 跨 CDP await，多个新会话会并发穿过 page cap；这里用小队列把容量检查和插入合成原子段。
      pageCreateQueue = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        const raced = sessionPages.get(sessionID);
        if (raced && !raced.isClosed()) return raced;
        // 每个 #sessionID 固定绑定一个页面：恢复读取自己的 DOM，不会被其他会话导航覆盖。
        // 启动时已有的 bootstrapPage 只复用一次，随后所有新 session 都拥有独立 page。
        // 新建页面前先主动清理 idle 页面，避免累积到上限才回收。
        if (!sparePage || sparePage.isClosed()) await closeIdlePageIfNeeded();
        const next = sparePage && !sparePage.isClosed()
          ? sparePage
          : await createSessionPage();
        sparePage = null;
        sessionPages.set(sessionID, next);
        return next;
      } finally {
        release();
      }
    },
    async voicePage() {
      // direct path 只需 chatgpt.com 同源 cookie 做 fetch；不需要专用页面、项目页或 composer。
      // 优先复用 daemon 已打开的任意 chatgpt.com 页面，零创建零导航零切换。
      assertBrowserConnected();
      // 主动重建：页面超过年龄限制直接关闭重建，不等健康检查失败。
      // 比被动检测快（省 5s 健康检查 + 3s 关闭 = 8s），且防止退化累积导致转写挂起。
      if (persistentVoicePage && voicePageCreatedAt && Date.now() - voicePageCreatedAt > VOICE_PAGE_MAX_AGE_MS) {
        await withTimeout(persistentVoicePage.close(), 3_000, 'close aged voice page').catch(() => {});
        persistentVoicePage = null;
        voicePageCreatedAt = 0;
      }
      // 清理过期的坏页面标记：页面自愈约 3 分钟，TTL 5 分钟后允许重新测试
      const now = Date.now();
      for (const [page, expiresAt] of badVoicePages) {
        if (now >= expiresAt || page.isClosed()) badVoicePages.delete(page);
      }
      // M2: 限制候选数量防止最坏情况超时；session pages 不检查（ask 可能在用，且 persistentVoicePage 通常可用）
      const candidates = [
        persistentVoicePage,
        sparePage,
      ].filter(page => page && !page.isClosed() && !badVoicePages.has(page) && /^https:\/\/chatgpt\.com/i.test(page.url()));
      // 健康检查：用 fetch 探测替代 evaluate(() => true)。
      // evaluate(() => true) 只验证 JS 上下文存活，无法检测 fetch 被 Service Worker 挂起的退化。
      // fetch 探测直接测试 voice 转写使用的同源网络路径；页面侧 AbortController(4s)
      // 确保即使 SW 卡住也不会在页面侧遗留悬挂请求（M1）。
      // /api/auth/session 在健康页面上 <1s 响应；5s 超时足够覆盖慢网络。
      for (const candidate of candidates) {
        try {
          await withTimeout(
            candidate.evaluate(() => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 4_000);
              return fetch('/api/auth/session', { credentials: 'include', signal: controller.signal })
                .then(r => r.status)
                .finally(() => clearTimeout(timer));
            }),
            5_000,
            'voice page health check'
          );
          return candidate;
        } catch {
          // 健康检查失败：标记为坏页面（5 分钟 TTL），关闭 persistentVoicePage
          badVoicePages.set(candidate, Date.now() + 300_000);
          if (candidate === persistentVoicePage) {
            persistentVoicePage = null;
            await withTimeout(candidate.close(), 3_000, 'close degraded voice page').catch(() => {});
          } else if (candidate === sparePage) {
            // sparePage 不关闭：pageFor() 发现 sparePage=null 会创建新页面；stale cleanup 处理孤儿
            sparePage = null;
          }
        }
      }
      // 没有已在 chatgpt.com 上的可用页面时才新建，并导航到 chatgpt.com 首页（非项目页，加载更快）。
      persistentVoicePage = await browser.newPage();
      await persistentVoicePage.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      voicePageCreatedAt = Date.now();
      return persistentVoicePage;
    },
    withSession(sessionID, task) {
      // 同一会话串行；不同会话可以并发。这个 seam 是 daemon 并发语义的唯一入口。
      const previous = sessionLocks.get(sessionID) || Promise.resolve();
      const run = previous.then(task, task);
      // stored 用于 finally 中“只删除自己创建的锁”，避免后续请求刚写入的新锁被旧请求误删。
      const stored = run.catch(() => {}).finally(() => {
        if (sessionLocks.get(sessionID) === stored) sessionLocks.delete(sessionID);
      });
      sessionLocks.set(sessionID, stored);
      return run;
    },
    withVoice(task) {
      // 同一个 ChatGPT composer 同时只能有一次听写；串行化能避免两段音频互相抢 getUserMedia patch 和输入框文本。
      const previous = voiceLock;
      const run = previous.then(task, task);
      voiceLock = run.catch(() => {});
      return run;
    },
    async withNewConversationLock(task) {
      // 只串行“打开 Project composer -> 提交 -> 记录 /c/... URL”的创建窗口；回答等待阶段仍可并发。
      let release;
      const previous = conversationCreateQueue;
      conversationCreateQueue = new Promise(resolve => { release = resolve; });
      await previous;
      try { return await task(); }
      finally { release(); }
    },
    async waitForResponse(page, beforeState, waitOptions, log) {
      // 不同 sessionID 已经绑定不同 tab；并发不再主动 detach，避免两个 ask 同跑时其中一个只拿到 partial。
      // 后台 tab 偶尔不刷新 DOM，DOM 层会按低频节奏 bringToFront，真正超时仍由 pending/recovery 兜底。
      // foregroundPulse 8s:降低 macOS 前台干扰频率;!state.generating 在生成期防护,pulse 只影响 DOM 刷新频率。
      return CHATGPT_DOM.waitForResponse(page, beforeState, { ...waitOptions, foregroundPulseMs: 8_000, shouldSkipForeground: () => flags.voiceFallbackActive }, log);
    },
    // 返回 daemon 当前管理的所有页面引用（bootstrapPage + sessionPages + voicePage），
    // 供 stale page cleanup 判断哪些页面不该被关闭。
    managedPages() {
      return [...sessionPages.values(), persistentVoicePage].filter(p => p && !p.isClosed());
    },
    // 转写失败时标记页面为坏（5 分钟 TTL），关闭 persistentVoicePage。
    // 健康检查无法检测所有退化模式（如健康检查通过后转写期间才发生的退化），
    // 此方法作为兜底：失败后不再复用该页面，下次 voicePage() 会创建新页面。
    invalidateVoicePage(page) {
      badVoicePages.set(page, Date.now() + 300_000);
      if (page === persistentVoicePage) {
        persistentVoicePage = null;
        withTimeout(page.close(), 3_000, 'close failed voice page').catch(() => {});
      } else if (page === sparePage) {
        sparePage = null;
      }
      // sessionPages 不再作为 voice 候选（fetch 健康检查可能干扰 ask），无需处理
    },
    // voice fallback 开始/结束标志:控制 ask 的 foregroundPulse 是否跳过。
    // fallback 需要独占前台(听写 UI 依赖 rAF);direct path 不调用这些方法(不需要前台)。
    beginVoiceFallback() { flags.voiceFallbackActive = true; },
    endVoiceFallback() { flags.voiceFallbackActive = false; },
  };
}

// ─── Voice Flow ──────────────────────────────────────────────────────────────

async function runVoiceTranscribe(runtime, input, log, shouldCancel = () => false) {
  const page = await runtime.voicePage();
  log(`voice: transcribing ${path.basename(input.file)} bytes=${fs.statSync(input.file).size}`);
  // 传 CHATGPT_URL 而非 project.url:fallback 只需 chatgpt.com 同源页,不需要导航到项目页(避免干扰 ask)。
  // onFallbackStart:direct path 失败进入 fallback 前通知 caller,让 ask 的 foregroundPulse 跳过。
  const transcribePromise = CHATGPT_DOM.transcribeAudioFile(page, input.file, CHATGPT_URL, log, shouldCancel, () => runtime.beginVoiceFallback());
  // cancelSignal 轮询客户端断开;与 withTimeout 竞速,先到者决定结果。
  const cancel = cancelSignal(shouldCancel, 500);
  try {
    const text = await Promise.race([
      withTimeout(transcribePromise, VOICE_TRANSCRIBE_TIMEOUT_MS,
        `Voice transcription timed out after ${VOICE_TRANSCRIBE_TIMEOUT_MS}ms`),
      cancel,
    ]);
    return { ok: true, text };
  } catch (err) {
    // timeout/abort/cancelled/target closed 都需要关闭坏页面,释放 voiceLock。
    // transcribePromise.catch 防止 page.close() 导致的 pending evaluate 产生 unhandled rejection。
    if (/Voice transcription cancelled|timed out|timeout|abort|target closed|protocol error/i.test(err.message)) {
      transcribePromise.catch(() => {});
      runtime.invalidateVoicePage(page);
    }
    throw err;
  } finally {
    // 无论成功/超时/取消,都清除 cancelSignal 定时器并恢复 ask 的 foregroundPulse。
    cancel.stop();
    runtime.endVoiceFallback();
  }
}

// ─── Ask Flow ────────────────────────────────────────────────────────────────

/**
 * 执行一次 ask 请求。
 *
 * happy path 只有五步：拿 page、恢复 URL、检查 pending、提交 prompt、等待并落盘。
 * 所有复杂性都被放进清晰 seam：DOM 操作在 adapter，文本/产物保存走 persist，
 * session 并发由 runtime.withSession 保证。
 */
async function runAsk(runtime, input, sessionID, log, shouldCancel = () => false) {
  const page = await runtime.pageFor(sessionID);
  const files = normalizePathList(input.uploadPaths || input.uploadPath);
  const workspaceDir = input.workspaceDir || process.cwd();
  const hash = requestHash(input.fullPrompt, files, input.mode, input.imageAspectRatio);
  const index = readSessionIndex();
  let session = readSessionEntry(sessionID, runtime.project);
  if (input.newSession && session) throw new Error(`sessionID collision for ${sessionID}; retry the request`);
  // registry 曾损坏时只拒绝“找不到记录的旧 #id”；恢复后新建并已登记的 session 仍可正常续聊。
  if (!session && !input.newSession && index.corruptBackup) throw new Error(`Session registry was recovered from corrupt state at ${index.corruptBackup}; this unknown sessionID cannot be recovered safely. Start a new sessionID.`);
  if (!session && !input.newSession) throw new Error(`Unknown sessionID ${sessionID}; start a new sessionID for a deliberate new conversation.`);
  if (session?.lost && isChatSessionUrlForProject(page.url(), runtime.project)) {
    writeSessionEntry(sessionID, runtime.project, page.url());
    session = readSessionEntry(sessionID, runtime.project);
  }
  if (session?.lost) throw new Error(`Session ${sessionID} previously sent a prompt but lost its conversation URL; cannot safely send another prompt. Start a new sessionID.`);
  log(`ask: sessionID=${sessionID} mode=${input.mode || 'auto'} imageAspectRatio=${input.imageAspectRatio || 'default'} saveToFile=${!!input.saveToFile} uploads=${files.length || 'none'} workspace=${workspaceDir} len=${input.fullPrompt.length}`);

  if (!session) {
    const beforeState = await runtime.withNewConversationLock(async () => {
      await restoreSessionPage(page, runtime.project, null, sessionID, log);
      return submitAsk(page, input.fullPrompt, files, workspaceDir, input.mode, input.imageAspectRatio, sessionID, runtime.project, log, shouldCancel);
    });
    log('Prompt sent, waiting for response...');
    return finishAsk({
      page,
      runtime,
      beforeState,
      sessionID,
      workspaceDir,
      saveToFile: input.saveToFile,
      requestHash: hash,
      slow: files.length > 0 || input.fullPrompt.length > 2_000,
      shouldCancel,
      log,
    });
  }

  const execute = async () => {
    await restoreSessionPage(page, runtime.project, session, sessionID, log);
    const currentState = await CHATGPT_DOM.state(page);
    const unansweredUserMessage = currentState.userCount > currentState.count;
    // pending TTL 不是“直接允许重发”的开关：fresh 一律恢复；stale 只有在页面已经没有可恢复 DOM 时才清理。
    // stale pending 仍是“先检查远端”的信号，但不再长期占用 page-retention 的 fresh 名额。
    const freshPending = session?.pending && isPendingFresh(session.pending);
    if (freshPending || (session?.pending && (currentState.generating || unansweredUserMessage || currentState.lastText)) || (session && (currentState.generating || unansweredUserMessage))) {
      // 已有未完成状态时，本次输入被当作“恢复请求”，不会写入 ChatGPT 页面。
      return recoverCurrentAssistant(page, workspaceDir, sessionID, runtime.project, session, recoveryReason(sessionID, currentState, unansweredUserMessage, session), log);
    }
    if (session?.pending) {
      log(`Clearing stale pending marker for ${sessionID}; no recoverable DOM state is visible`);
      clearSessionPending(sessionID, runtime.project, session.url);
      session = readSessionEntry(sessionID, runtime.project);
    }
    if (isCompletedFresh(session?.completed, hash)) {
      const replay = completedReplayResult(session, workspaceDir, sessionID, input.saveToFile);
      if (replay) return replay;
      log(`Completed replay snapshot for ${sessionID} is missing; accepting the prompt as a deliberate new turn`);
    }

    const beforeState = await submitAsk(page, input.fullPrompt, files, workspaceDir, input.mode, input.imageAspectRatio, sessionID, runtime.project, log, shouldCancel);
    log('Prompt sent, waiting for response...');

    return finishAsk({
      page,
      runtime,
      beforeState,
      sessionID,
      workspaceDir,
      saveToFile: input.saveToFile,
      requestHash: hash,
      slow: files.length > 0 || input.fullPrompt.length > 2_000,
      shouldCancel,
      log,
    });
  };

  return execute();
}

async function restoreSessionPage(page, project, session, sessionID, log) {
  const targetUrl = session?.url || project.url;
  if (sameUrl(page.url(), targetUrl)) return;
  // 新会话:当前页已在本项目(/g/{token}/c/)且无消息(干净对话)——复用,避免创建多余对话。
  // 先 bringToFront+500ms 让虚拟化的消息 hydrate,避免后台 tab count=0 假阳性。
  if (!session && page.url().includes(`/g/${project.token}/c/`)) {
    await page.bringToFront().catch(() => {});
    await sleep(500);
    const reusable = await page.evaluate(() =>
      !!document.querySelector('#prompt-textarea') &&
      document.querySelectorAll('[data-message-author-role]').length === 0
    ).catch(() => false);
    if (reusable) { log(`Reusing current page for new session ${sessionID}`); return; }
  }
  log(session ? `Restoring session ${sessionID}` : `Starting session ${sessionID} in ${project.name}`);
  // ChatGPT 页面会长期保持流式/预取连接；等待 networkidle 容易误判超时，composer 自己再等具体 selector。
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
}

function recoveryReason(sessionID, state, unansweredUserMessage, session) {
  if (state.generating) return `session ${sessionID} is still generating in ChatGPT`;
  if (unansweredUserMessage) return `session ${sessionID} has a submitted prompt without a recoverable assistant response yet`;
  if (session?.pending) return `session ${sessionID} was previously marked pending; recovered it before accepting a new prompt`;
  return `session ${sessionID} is not ready for a new prompt`;
}

async function submitAsk(page, fullPrompt, files, workspaceDir, mode, imageAspectRatio, sessionID, project, log, shouldCancel) {
  let beforeState;
  try {
    beforeState = await CHATGPT_DOM.submit(page, fullPrompt, files, workspaceDir, mode, imageAspectRatio, log, shouldCancel, () => markSessionLost(sessionID, project, 'Prompt send click started but no conversation URL has been recorded yet.'));
  } catch (err) {
    if (err.promptMayHaveBeenSent) markSessionLost(sessionID, project, `Prompt may have been submitted while clickSend failed: ${err.message}`);
    throw err;
  }
  // 先记住 /c/...，再进入长等待；等待超时也能通过 registry 找回远端会话。
  await rememberCurrentSessionUrl(page, project, sessionID, log);
  return beforeState;
}

async function finishAsk({ page, runtime, beforeState, sessionID, workspaceDir, saveToFile, requestHash, slow, shouldCancel, log }) {
  let waitResult;
  try {
    waitResult = await runtime.waitForResponse(page, beforeState, { slow, shouldCancel }, log);
  } catch (err) {
    const failedUrl = isChatSessionUrlForProject(page.url(), runtime.project)
      ? page.url()
      : await rememberCurrentSessionUrl(page, runtime.project, sessionID, log, 3_000);
    await CHATGPT_DOM.focus(page).catch(() => {});
    const state = await CHATGPT_DOM.state(page).catch(() => null);
    const hasNewAssistantText = state?.lastText && state.lastText !== beforeState.lastText;
    // wait failure 不能把上一轮 assistant 当成本轮 partial；只有 DOM 出现新 assistant 证据才保存文本。
    const raw = hasNewAssistantText
      ? await CHATGPT_DOM.extractAssistant(page).catch(() => state.lastText)
      : '';
    return persistAssistantResult({
      page,
      project: runtime.project,
      workspaceDir,
      sessionID,
      raw,
      status: 'generating',
      saveToFile,
      requestHash,
      finalUrl: failedUrl || page.url(),
      promptSent: true,
      forceSave: !!raw,
      forcePreview: !!raw,
      shouldCancel,
      log,
      saveLabel: 'Current assistant snapshot saved after a browser wait failure',
      notice: [`Prompt may have been sent, but browser wait failed: ${err.message}. Reuse the same sessionID to recover before sending another prompt.`, raw ? null : 'No new assistant DOM was visible yet, so previous assistant text was not saved as this prompt response.'].filter(Boolean).join('\n'),
    });
  }
  const currentUrl = page.url();
  // URL 仍属于固定 Project 时才更新 registry；避免登录页或错误页覆盖真实 conversation。
  const finalUrl = isChatSessionUrlForProject(currentUrl, runtime.project, { allowPlain: true })
    ? currentUrl
    : await rememberCurrentSessionUrl(page, runtime.project, sessionID, log, 5_000);
  if (finalUrl) writeSessionEntry(sessionID, runtime.project, finalUrl);

  const stillGenerating = waitResult.status === 'generating';
  let extractionNotice = null;
  await CHATGPT_DOM.focus(page).catch(() => {});
  const fallbackState = await CHATGPT_DOM.state(page).catch(() => null);
  const hasNewAssistantText = fallbackState?.lastText && fallbackState.lastText !== beforeState.lastText;
  // submitted-no-assistant / timeout 场景只落 pending，不拿上一轮 assistant 充当 partial。
  const raw = hasNewAssistantText ? await CHATGPT_DOM.extractAssistant(page).catch(err => {
    extractionNotice = `Markdown extraction failed; saved visible assistant text instead: ${err.message}`;
    log(extractionNotice);
    return fallbackState?.lastText || '';
  }) || '' : '';
  const sessionNotice = finalUrl ? null : 'Conversation URL was not recorded; this session handle may not survive daemon restart.';
  const result = await persistAssistantResult({
    page,
    project: runtime.project,
    workspaceDir,
    sessionID,
    raw,
    status: waitResult.status,
    saveToFile,
    requestHash,
    finalUrl: finalUrl || currentUrl,
    promptSent: true,
    shouldCancel,
    beforeState,
    log,
    saveLabel: stillGenerating
      ? 'Current partial assistant response saved locally before returning to OpenCode'
      : 'Full response saved locally before returning to OpenCode',
    notice: [
      stillGenerating ? 'ChatGPT is still generating. Reuse the same sessionID to recover the latest text before sending another prompt.' : null,
      extractionNotice,
      sessionNotice,
    ].filter(Boolean).join('\n') || null,
  });
  log(`Done: ${raw.length} chars`);
  return result;
}

// ─── Daemon Process ───────────────────────────────────────────────────────────

function readDaemonJsonBody(req, label, log) {
  // voice route 的 body 只有 `{ file }`，但它仍是本地 HTTP 边界：做字节上限和 30s 读超时，
  // 避免 token 持有者用半开连接占住 daemon socket。/ask 继续保留自己的长请求/取消逻辑。
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.setTimeout(0);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      log(`Error: ${label} request body total deadline exceeded`);
      finish(new Error('Request body total deadline exceeded'));
      setImmediate(() => req.destroy());
    }, 30_000);
    req.setTimeout(30_000, () => {
      log(`Error: ${label} request body timed out`);
      finish(new Error('Request body timed out'));
      setImmediate(() => req.destroy());
    });
    req.on('data', chunk => {
      bytes += chunk.length;
      if (done) return;
      if (bytes > MAX_DAEMON_REQUEST_BYTES) {
        finish(new Error(`Request body too large; limit is ${MAX_DAEMON_REQUEST_BYTES} bytes`));
        setImmediate(() => req.destroy());
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', err => finish(err));
    req.on('end', () => {
      if (done) return;
      try { finish(null, JSON.parse(Buffer.concat(chunks, bytes).toString('utf8') || '{}')); }
      catch { finish(new Error('Request body must be JSON')); }
    });
  });
}

/**
 * 启动长期运行的 daemon 进程。
 *
 * 启动阶段必须先解析固定 Project 并确认登录态，成功后再写 daemon.json；否则 CLI 可能拿到
 * 一个尚不可用的端口。HTTP 层只暴露 /status、/stop、/ask 和 TUI 私有 /voice/transcribe-file，业务错误统一回 JSON，
 * 进程级错误写入 daemon.log 供本地诊断。
 */
async function startDaemonProcess() {
  // daemon 是唯一持有 Puppeteer browser 的进程；CLI/MCP 都只通过本地 HTTP 找它。
  const logStream = fs.createWriteStream(DAEMON_LOG, { flags: 'a' });
  const log = msg => logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
  // process.exit 不等待 async writeStream 刷盘；登录等待阶段的断连/超时错误必须先落盘再退出，
  // 否则 client 的 daemonStartupErrorSince 读不到错误，只能等满 DAEMON_START_TIMEOUT。
  const flushAndExit = code => { logStream.end(() => process.exit(code)); };

  log('Daemon starting...');

  let browser, bootstrapPage, project;
  try {
    browser = await launchBrowser(log);
    // Edge 用 user-data-dir 启动时会恢复上次会话的标签页；Puppeteer 也会创建初始 about:blank。
    // 这些无关页面拖慢启动、占用内存、可能干扰 DOM 检测。启动后立即清理，只保留一个页面做 bootstrap。
    const initialPages = await browser.pages();
    // 优先复用已有 chatgpt.com 页面（spawn 时打开），避免 newPage 在 cookie 加载前
    // 导航到 project URL 被重定向到 /auth/login，导致 chatgpt.com 清除 persistent session-token cookie。
    bootstrapPage = initialPages.find(p => /chatgpt\.com/.test(p.url())) || initialPages[0] || await browser.newPage();
    for (const page of initialPages) {
      if (page !== bootstrapPage) await page.close().catch(() => {});
    }
    // 只导航到 chatgpt.com 首页（不导航到 project URL），避免未登录时触发 /auth/login 清除 cookie。
    if (!/chatgpt\.com/.test(bootstrapPage.url())) {
      await bootstrapPage.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    // chatgpt.com 用 JS 渲染登录态；domcontentloaded 时 #prompt-textarea 可能还没出现，
    // 导致 isLoggedOut 在页面完全渲染前误判为未登录。等待 composer 或登录按钮出现后再检查。
    await Promise.race([
      bootstrapPage.waitForSelector('#prompt-textarea', { timeout: 15_000 }).catch(() => {}),
      bootstrapPage.waitForFunction(() => [...document.querySelectorAll('button, a')].some(el => /\b(log in|sign in)\b|登录|登入/i.test((el.textContent || '').trim())), { timeout: 15_000 }).catch(() => {}),
    ]);

    if (await CHATGPT_DOM.isLoggedOut(bootstrapPage)) {
      // 保持浏览器窗口打开让用户手动登录；Puppeteer 控制的浏览器可能被 Google OAuth 拒绝，
      // 邮箱/密码登录通常可用。Google 账户用户可关闭此窗口后运行 node chatgpt.js --login。
      log('Login required; waiting for manual login in browser window...');
      let loginConfirmed = false;
      const loginDeadline = Date.now() + LOGIN_WAIT_TIMEOUT_MS;
      while (Date.now() < loginDeadline) {
        await sleep(3_000);
        // browser.on('disconnected') 尚未注册（在 startup try 块之后才挂载），
        // 这里手动检测断连，避免用户关闭窗口后空转至超时。
        if (!browser.isConnected()) {
          log('Startup error: Browser closed during login wait. Run: node chatgpt.js --login');
          return flushAndExit(1);
        }
        try {
          // 被动检测：只读 URL 和 DOM，不调用 page.goto，避免打断用户正在填写的登录表单。
          // ChatGPT 登录成功后会自然重定向到 chatgpt.com，isLoggedOut 会返回 false。
          if (!await CHATGPT_DOM.isLoggedOut(bootstrapPage)) {
            // 二次确认：OAuth 重定向中途可能短暂出现非登录页 URL，单次检测可能误判。
            await sleep(2_000);
            if (browser.isConnected() && !await CHATGPT_DOM.isLoggedOut(bootstrapPage)) {
              loginConfirmed = true;
              break;
            }
          }
        } catch {
          // 页面导航中 evaluate 失败是正常的（OAuth 重定向会销毁 execution context）；
          // 只有 browser 真正断开才退出，其余异常继续等待下一轮检测。
          if (!browser.isConnected()) {
            log('Startup error: Browser closed during login wait. Run: node chatgpt.js --login');
            return flushAndExit(1);
          }
        }
      }
      if (!loginConfirmed) {
        log('Startup error: Login wait timed out after ' + LOGIN_WAIT_TIMEOUT_MS + 'ms. Log in to chatgpt.com in the browser window, or run: node chatgpt.js --login');
        // CDP 连接模式下 disconnect 而非 close，避免杀掉用户已登录的浏览器窗口。
        if (BROWSER_WS_ENDPOINT || BROWSER_CDP_URL) browser.disconnect();
        else await browser.close();
        return flushAndExit(1);
      }
      log('Login detected; continuing startup.');
    }

    // 已登录后才导航到 project URL，避免未登录时 /auth/login 重定向清除 persistent cookie。
    project = resolveCachedProject(DEFAULT_PROJECT);
    project = project || await resolveProject(bootstrapPage, DEFAULT_PROJECT, log);

    if (!sameUrl(bootstrapPage.url(), project.url)) {
      log(`Navigating to fixed project: ${project.name} (${project.id})`);
      await bootstrapPage.goto(project.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } else {
      log(`Using fixed project from cache: ${project.name} (${project.id})`);
    }

    log('Browser ready and logged in.');
  } catch (err) {
    log(`Startup error: ${err.message}`);
    if (browser) {
      // CDP 连接模式下 disconnect 而非 close，避免杀掉用户已登录的浏览器。
      if (BROWSER_WS_ENDPOINT || BROWSER_CDP_URL) browser.disconnect();
      else await browser.close().catch(() => {});
    }
    // 外层 catch 同样需要刷盘后退出，否则启动期异常的日志可能丢失。
    return flushAndExit(1);
  }

  const runtime = createDaemonRuntime({ browser, bootstrapPage, project });
  const daemonToken = crypto.randomBytes(18).toString('hex');
  const daemonID = crypto.randomBytes(12).toString('hex');
  let server;
  let shuttingDown = false;

  // 定期清理不属于任何 session 的游离页面（Edge 恢复的旧标签、用户手动打开的标签等）。
  // bootstrapPage 和 sessionPages 中的页面是 daemon 管理的，不清理。
  const STALE_PAGE_CLEANUP_INTERVAL_MS = 60_000;
  const stalePageTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      const managedPages = new Set([bootstrapPage, ...runtime.managedPages()].filter(Boolean));
      const allPages = await browser.pages();
      for (const page of allPages) {
        if (!managedPages.has(page) && !page.isClosed()) {
          await page.close().catch(() => {});
          log('Closed stale page not tracked by daemon');
        }
      }
    } catch {}
  }, STALE_PAGE_CLEANUP_INTERVAL_MS);

  const shutdownOnce = async (message, options = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(message);
    // daemon.json/daemon.run.json 都是客户端发现入口；browser 已断开时必须删除，避免后续 CLI 复用假活 daemon。
    // 只清理索引文件，不碰 profile、sessions、downloads；用户关闭浏览器不应丢失登录态或会话恢复资料。
    for (const file of [DAEMON_FILE, path.join(STATE_DIR, 'daemon.run.json')]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    }
    if (server) server.close();
    clearInterval(stalePageTimer);
    // browser disconnected 回调里不再 close browser：连接已断开，重复 close 只会制造无意义的协议错误。
    if (options.closeBrowser !== false) {
      // CDP 连接模式下 disconnect 而非 close，避免 daemon 退出时杀掉用户已登录的浏览器，
      // 导致 session cookie 丢失、下次启动需要重新登录。
      if (BROWSER_WS_ENDPOINT || BROWSER_CDP_URL) browser.disconnect();
      else await browser.close().catch(() => {});
    }
    process.exit(options.exitCode ?? 0);
  };

  browser.on('disconnected', () => {
    // 用户手动关闭浏览器代表当前 daemon 不再可服务页面请求；不自动重开，下一次 ask/voice 再按需启动。
    // 这里退出 daemon 而不是内部重启 browser，避免用户刚关闭窗口又被后台进程立即重新弹出。
    shutdownOnce('Browser disconnected; shutting down daemon.', { closeBrowser: false }).catch(err => {
      log(`Shutdown error after browser disconnect: ${err.message}`);
      process.exit(1);
    });
  });

  server = http.createServer(async (req, res) => {
    // send 必须在 res 已关闭时静默返回:voice cancel 后客户端断开,catch 调 send(500)
    // 会在已关闭的 res 上 writeHead 抛异常,导致 daemon 崩溃且 voiceLock 永不释放。
    const send = (status, obj) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url?.startsWith('/ping')) {
      const probe = new URL(req.url, 'http://127.0.0.1');
      return probe.searchParams.get('daemonID') === daemonID ? send(200, { ok: true }) : send(404, { ok: false, error: 'Not found' });
    }

    if (req.headers.authorization !== `Bearer ${daemonToken}`) {
      return send(401, { ok: false, error: 'Unauthorized daemon request' });
    }

    if (req.method === 'GET' && req.url === '/status') {
      return send(200, {
        ok: true,
        pid: process.pid,
        daemonID,
        project: project.name,
        ...runtime.status(),
      });
    }

    if (req.method === 'POST' && req.url === '/stop') {
      send(200, { ok: true });
      await shutdownOnce('Shutting down...', { closeBrowser: true });
    }

    if (req.method === 'POST' && req.url === '/voice/transcribe-file') {
      // 检测客户端断开:TUI cancel 后 daemon 仍持有 voiceLock 直到超时(60s);
      // shouldCancel 让 cancelSignal 在 500ms 内检测断开,关闭页面释放 voiceLock。
      let voiceClientClosed = false;
      res.on('close', () => { if (!res.writableEnded) voiceClientClosed = true; });
      try {
        res.setTimeout(RESPONSE_TIMEOUT + 60_000);
        const parsed = validateVoiceInput(await readDaemonJsonBody(req, '/voice/transcribe-file', log));
        const result = await runtime.withVoice(() => runVoiceTranscribe(runtime, parsed, log, () => voiceClientClosed));
        send(200, result);
      } catch (err) {
        log(`Error: ${err.message}`);
        // 503 表示本地 browser 生命周期失效而非用户输入错误；CLI 只对这个结构化 code 做一次安全重试。
        send(err.code === 'BROWSER_DISCONNECTED' ? 503 : /body|file|WAV|regular|large|exist/i.test(err.message) ? 400 : 500, { ok: false, ...(err.code ? { code: err.code } : {}), error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/ask') {
      const chunks = [];
      let bytes = 0;
      let replied = false;
      let clientClosed = false;
      const bodyDeadline = setTimeout(() => {
        log('Error: /ask request body total deadline exceeded');
        reply(408, { ok: false, error: 'Request body total deadline exceeded' });
        setImmediate(() => req.destroy());
      }, 30_000);
      const reply = (status, obj) => {
        if (replied || clientClosed || res.destroyed || res.writableEnded) return;
        replied = true;
        clearTimeout(bodyDeadline);
        send(status, obj);
      };
      // 本地 HTTP 也要防 slowloris：token 持有者不能用半开 body 长期占住 daemon socket。
      req.setTimeout(30_000, () => {
        log('Error: /ask request body timed out');
        reply(408, { ok: false, error: 'Request body timed out' });
        setImmediate(() => req.destroy());
      });
      res.on('close', () => { if (!replied) clientClosed = true; });
      req.on('data', chunk => {
        bytes += chunk.length;
        if (replied) return;
        if (bytes > MAX_DAEMON_REQUEST_BYTES) {
          log(`Error: /ask request body exceeded ${MAX_DAEMON_REQUEST_BYTES} bytes`);
          reply(413, { ok: false, error: `Request body too large; limit is ${MAX_DAEMON_REQUEST_BYTES} bytes` });
          setImmediate(() => req.destroy());
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', err => {
        if (!replied) {
          log(`Request stream error: ${err.message}`);
          reply(500, { ok: false, error: err.message });
        }
      });
      req.on('end', async () => {
        clearTimeout(bodyDeadline);
        // body 已完整进入内存后，slowloris 风险结束；不能让 30 秒 request timeout 截断上传解析/长回答。
        // 后续业务等待由 RESPONSE_TIMEOUT 和 CLI/MCP 外层 timeout 管，不再复用“读请求体”的短超时。
        req.setTimeout(0);
        res.setTimeout(RESPONSE_TIMEOUT + 60_000);
        if (replied) return;
        let parsed, sessionID;
        try {
          // body 用 Buffer chunks 聚合，避免大请求反复字符串拼接造成额外内存峰值。
          parsed = validateAskInput(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
          sessionID = normalizeSessionID(parsed.sessionID) || createSessionID();
          if (parsed.newSession && readSessionIndex().sessions[sessionID]) throw new Error(`sessionID collision for ${sessionID}; retry the request`);
        } catch (err) {
          log(`Error: ${err.message}`);
          reply(/collision/i.test(err.message) ? 409 : 400, { ok: false, error: err.message });
          return;
        }

        // /ask 的业务生命周期必须完整处在 session lock 内：导航、恢复、提交、等待、落盘都不能并发踩同一个 page。
        runtime.withSession(sessionID, async () => {
          try {
            if (clientClosed) {
              log(`Ask client disconnected before session ${sessionID} started`);
              return;
            }
            const result = await runAsk(runtime, parsed, sessionID, log, () => clientClosed);
            if (clientClosed && result?.status === 'completed') {
              // 回答已完成但 HTTP client 已走：此时不能把 pending 清掉，否则调用方既收不到答案，也不会触发恢复。
              const entry = readSessionEntry(sessionID, runtime.project);
              const saved = result.savedResponse || (result.response ? saveResponseToFile(result.response, parsed.workspaceDir, sessionID) : null);
              if (entry?.url) markSessionPending(sessionID, runtime.project, entry.url, saved, { preserveCompleted: true });
              log(`Ask client disconnected after completion; saved response and marked ${sessionID} pending for recovery`);
              return;
            }
            reply(200, result);
          } catch (err) {
            log(`Error: ${err.message}`);
            // /ask 只有在 runAsk 创建 page 前才会带 BROWSER_DISCONNECTED；提交后的异常不能自动重发。
            reply(err.code === 'BROWSER_DISCONNECTED' ? 503 : 500, { ok: false, ...(err.code ? { code: err.code } : {}), error: err.message });
          }
        }).catch(err => {
          log(`Error: ${err.message}`);
          reply(err.code === 'BROWSER_DISCONNECTED' ? 503 : 500, { ok: false, ...(err.code ? { code: err.code } : {}), error: err.message });
        });
      });
      return;
    }

    send(404, { ok: false, error: 'Not found' });
  });

  server.on('error', err => {
    log(`HTTP server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    log(`HTTP server listening on 127.0.0.1:${port}`);
    const daemonState = JSON.stringify({ port, pid: process.pid, token: daemonToken, daemonID, version: DAEMON_VERSION });
    // daemon.json 是唯一 bearer-token 索引；少写一个备份文件，就少一个本地进程可滥用的入口。
    fs.writeFileSync(DAEMON_FILE, daemonState, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(DAEMON_FILE, 0o600);
    log('Daemon ready.');
  });

  const shutdown = async signal => {
    // 信号退出和 browser 断开共用同一清理边界，保证 daemon.json 不会在任意退出路径遗留 stale bearer token。
    await shutdownOnce(`${signal} received, shutting down`, { closeBrowser: true });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  // 这里不返回：daemon 作为 HTTP server 常驻，直到收到 /stop 或进程信号。
}

module.exports = { startDaemonProcess };

if (require.main === module) {
  startDaemonProcess().catch(err => {
    console.error('[ERROR]', err.message);
    process.exit(1);
  });
}
