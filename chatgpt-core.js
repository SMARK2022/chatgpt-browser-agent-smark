
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
const { execSync }        = require('child_process');
const { createChatGPTDom } = require('./chatgpt-dom');

// ─── Constants and Directories ────────────────────────────────────────────────

// 常量集中在 core，是因为 daemon/browser/profile/cache 必须由同一层统一决定；
// CLI 和 MCP 只传入请求，不重新推导这些路径，避免多个入口算出不同目录。

const CHROME_PATH      = process.env.CHATGPT_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const STATE_DIR        = path.resolve(process.env.CHATGPT_STATE_DIR || defaultStateDir());
const USER_DATA_DIR    = path.resolve(process.env.CHATGPT_SESSION_DIR || defaultUserDataDir());
const SESSION_DIR      = USER_DATA_DIR;
const PROFILE_DIR      = path.join(STATE_DIR, 'profile');
const BROWSER_USER_DATA_DIR = path.resolve(process.env.CHATGPT_BROWSER_USER_DATA_DIR || PROFILE_DIR);
const BROWSER_PROFILE_DIRECTORY = process.env.CHATGPT_BROWSER_PROFILE_DIRECTORY || '';
const BROWSER_WS_ENDPOINT = process.env.CHATGPT_BROWSER_WS_ENDPOINT || '';
const BROWSER_DEBUG_PORT = Number.parseInt(process.env.CHATGPT_BROWSER_DEBUG_PORT || '', 10);
const BROWSER_CDP_URL_ENV = process.env.CHATGPT_BROWSER_CDP_URL || '';
const BROWSER_CDP_URL = BROWSER_CDP_URL_ENV || (Number.isFinite(BROWSER_DEBUG_PORT) && BROWSER_DEBUG_PORT > 0 ? `http://127.0.0.1:${BROWSER_DEBUG_PORT}` : '');
const BROWSER_CONNECT_TIMEOUT_MS = positiveIntEnv('CHATGPT_BROWSER_CONNECT_TIMEOUT_MS', 3_000);
const PROJECTS_FILE    = path.join(STATE_DIR, 'projects.json');
const SESSION_INDEX_FILE = path.join(USER_DATA_DIR, 'sessions.json');
const DAEMON_FILE      = path.join(STATE_DIR, 'daemon.json');
const DAEMON_LOG       = path.join(STATE_DIR, 'daemon.log');
const CHATGPT_URL      = 'https://chatgpt.com';
const DEFAULT_PROJECT  = process.env.CHATGPT_PROJECT || process.env.CHATGPT_PROJECT_NAME || process.env.CHATGPT_PROJECT_URL || 'MCP';
const DAEMON_VERSION   = 16;
const RESPONSE_TIMEOUT = positiveIntEnv('CHATGPT_RESPONSE_TIMEOUT_MS', 540_000); // 大文件分析会很慢，默认给 9 分钟。
const MAX_RETURN_CHARS = positiveIntEnv('CHATGPT_MAX_RETURN_CHARS', 6_000);
const RESPONSE_PREVIEW_CHARS = positiveIntEnv('CHATGPT_RESPONSE_PREVIEW_CHARS', 4_000);
const ASYNC_DETACH_MS = positiveIntEnv('CHATGPT_ASYNC_DETACH_MS', 12_000);
const MAX_SESSION_PAGES = positiveIntEnv('CHATGPT_MAX_SESSION_PAGES', 8);
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
const MAX_FULL_PROMPT_CHARS = positiveIntEnv('CHATGPT_MAX_FULL_PROMPT_CHARS', 500_000);
const ASK_MODES = new Set(['auto', 'image']);
// 图片比例来自实测的 ChatGPT image popover；保存语义枚举，DOM 本地化标签留给 adapter 翻译。
const IMAGE_ASPECT_RATIOS = new Set(['auto', 'square', 'portrait', 'story', 'landscape', 'wide']);
const EXPLICIT_UPLOAD_ROOTS = uploadRoots();
const WORKSPACE_ROOTS = workspaceRoots();
const CHATGPT_DOM = createChatGPTDom({
  responseTimeout: RESPONSE_TIMEOUT,
  asyncDetachMs: ASYNC_DETACH_MS,
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
    }
  }
  if (usesExternalBrowserProfile() && browserProfileLooksLocked()) {
    throw new Error(`Configured browser profile is already open without a reachable DevTools endpoint. Start Edge with --remote-debugging-port=${BROWSER_DEBUG_PORT || 9222}, set CHATGPT_BROWSER_CDP_URL/CHATGPT_BROWSER_WS_ENDPOINT, or close Edge before launching this daemon. Profile: ${BROWSER_USER_DATA_DIR}`);
  }
  // 没有 CDP 端口时只能复用同一个 user data dir 的登录态；若该 profile 正被普通 Edge 锁住，Chromium 会拒绝启动。
  // 这仍比插件私有空 profile 更符合用户预期：登录 cookie 来自指定 Edge profile，而不是重新登录。
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: BROWSER_USER_DATA_DIR,
    headless: false,
    args: browserLaunchArgs(),
    defaultViewport: null,
    protocolTimeout: RESPONSE_TIMEOUT,
  });
}

function browserLaunchArgs() {
  return [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-extensions',
    '--disable-extensions-except=',
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
  try { execSync(`icacls ${JSON.stringify(target)} /inheritance:r ${grants.map(grant => `/grant:r ${JSON.stringify(grant)}`).join(' ')}`, { stdio: 'ignore' }); }
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
  const url = `${CHATGPT_URL}/g/${token}/project`;
  const title = name || token.replace(id, '').replace(/^-/, '') || id;
  return { id, token, key: normalizeProjectKey(title || id), name: title, url };
}

function projectIdFromUrl(url) {
  return parseProjectRef(url)?.id;
}

function isChatSessionUrlForProject(url, project, options = {}) {
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
  // 只给 imageAspectRatio 一个“隐式打开 image mode”的捷径；显式 search+ratio 必须报错，避免隐藏切换语义。
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
  try { return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8' }).trim() || cwd; }
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

async function resolveProject(page, requested, log) {
  // Project 解析先走显式值和缓存；只有缓存缺失才打开 ChatGPT 首页扫描，减少对易变 DOM 的依赖。
  const value = String(requested || DEFAULT_PROJECT).trim();
  const direct = parseProjectRef(value);
  if (direct) {
    cacheProject(direct);
    return direct;
  }

  const key = normalizeProjectKey(value);
  const cached = readProjectCache().projects[key];
  if (cached) return cached;

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
  let conversationCreateQueue = Promise.resolve();
  let concurrentDetachUntil = 0;
  let activeGenerations = 0;
  let pageCreateQueue = Promise.resolve();
  let sparePage = bootstrapPage;

  // pending 会话仍可能承载远端生成 DOM；registry 防重发，tab 保留则服务后续 artifact/text recovery。
  const pageCanBeClosed = id => !sessionLocks.has(id) && !isPendingFresh(readSessionEntry(id, project)?.pending);

  const closeIdlePageIfNeeded = async () => {
    if (sessionPages.size < MAX_SESSION_PAGES) return true;
    for (const [id, page] of sessionPages) {
      if (!pageCanBeClosed(id)) continue;
      sessionPages.delete(id);
      await page.close().catch(() => {});
      return true;
    }
    return false;
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
        pageCount: pages.length,
        pendingPageCount: pendingPages.length,
        activeLocks: sessionLocks.size,
        maxPages: MAX_SESSION_PAGES,
        ...(process.env.CHATGPT_STATUS_SHOW_SESSIONS === '1' ? { pages, pendingPages } : {}),
      };
    },
    async pageFor(sessionID) {
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
      // 并发时给 DOM 层一个 detach 窗口：确认 prompt 已提交后可返回 generating，后续靠同 sessionID 恢复。
      activeGenerations++;
      if (activeGenerations > 1) concurrentDetachUntil = Date.now() + RESPONSE_TIMEOUT;
      try {
        return await CHATGPT_DOM.waitForResponse(page, beforeState, {
          ...waitOptions,
          detachWhenBusy: () => activeGenerations > 1 && Date.now() < concurrentDetachUntil,
        }, log);
      } finally {
        activeGenerations--;
        if (activeGenerations === 0) concurrentDetachUntil = 0;
      }
    },
  };
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
  log(session ? `Restoring session ${sessionID}` : `Starting session ${sessionID} in ${project.name}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
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
  const fallbackState = await CHATGPT_DOM.state(page).catch(() => null);
  const hasNewAssistantText = fallbackState?.lastText && fallbackState.lastText !== beforeState.lastText;
  // submitted-no-assistant / concurrent-detach 场景只落 pending，不拿上一轮 assistant 充当 partial。
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

/**
 * 启动长期运行的 daemon 进程。
 *
 * 启动阶段必须先解析固定 Project 并确认登录态，成功后再写 daemon.json；否则 CLI 可能拿到
 * 一个尚不可用的端口。HTTP 层只暴露 /status、/stop、/ask，业务错误统一回 JSON，
 * 进程级错误写入 daemon.log 供本地诊断。
 */
async function startDaemonProcess() {
  // daemon 是唯一持有 Puppeteer browser 的进程；CLI/MCP 都只通过本地 HTTP 找它。
  const logStream = fs.createWriteStream(DAEMON_LOG, { flags: 'a' });
  const log = msg => logStream.write(`[${new Date().toISOString()}] ${msg}\n`);

  log('Daemon starting...');

  let browser, bootstrapPage, project;
  try {
    browser = await launchBrowser(log);
    bootstrapPage = await browser.newPage();
    // 先确认登录，再解析 Project；否则未登录首页没有项目列表，会误报“项目不存在”。
    await bootstrapPage.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });

    if (await CHATGPT_DOM.isLoggedOut(bootstrapPage)) {
      log('Startup error: Not logged in. Run: node chatgpt.js --login');
      await browser.close();
      process.exit(1);
    }

    project = await resolveProject(bootstrapPage, DEFAULT_PROJECT, log);

    log(`Navigating to fixed project: ${project.name} (${project.id})`);
    await bootstrapPage.goto(project.url, { waitUntil: 'networkidle2', timeout: 30_000 });

    log('Browser ready and logged in.');
  } catch (err) {
    log(`Startup error: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }

  const runtime = createDaemonRuntime({ browser, bootstrapPage, project });
  const daemonToken = crypto.randomBytes(18).toString('hex');
  const daemonID = crypto.randomBytes(12).toString('hex');

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
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
      log('Shutting down...');
      server.close();
      await browser.close().catch(() => {});
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      process.exit(0);
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
            reply(500, { ok: false, error: err.message });
          }
        }).catch(err => {
          log(`Error: ${err.message}`);
          reply(500, { ok: false, error: err.message });
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
    // 退出路径尽量清理 daemon.json；下次 CLI 看到无状态文件就会启动新的 daemon。
    log(`${signal} received, shutting down`);
    if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
    await browser.close().catch(() => {});
    process.exit(0);
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
