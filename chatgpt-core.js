
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
const projectPolicy       = require('./chatgpt-project');
const {
  normalizeProjectKey,
  parse: parseProjectRef,
  projectIdFromUrl,
  isOfficialURL: isOfficialChatGPTURL,
  conversation: conversationFromUrl,
  acceptsHome: isProjectHomeUrlForProject,
  acceptsConversation: isChatSessionUrlForProject,
  sameConversation: isSameConversationUrl,
  forSession: projectForSessionEntry,
  select: selectDiscoveredProject,
} = projectPolicy;

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
const BROWSER_OWNER_FILE = path.join(STATE_DIR, 'browser-owner.json');
// private-marker browser的定点恢复记录：只存CDP读到的主进程PID，marker失效时据此验证/清理残留锁。
const PRIVATE_BROWSER_PID_FILE = path.join(STATE_DIR, 'browser-pid.json');
const CHATGPT_URL      = 'https://chatgpt.com';
const DEFAULT_PROJECT  = process.env.CHATGPT_PROJECT || process.env.CHATGPT_PROJECT_NAME || process.env.CHATGPT_PROJECT_URL || 'MCP';
const DAEMON_VERSION   = 24;
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
// voice总预算从入队开始；80秒覆盖真实cold FIFO，并仍早于TUI 90秒和CLI 120秒外层终止。
// 总预算覆盖页面准备和唯一direct请求；超时后voiceLock必须在settle或隔离后释放。
const VOICE_TRANSCRIBE_TIMEOUT_MS = positiveIntEnv('CHATGPT_VOICE_TRANSCRIBE_TIMEOUT_MS', 80_000);
// 长期复用页即使仍能 evaluate，也可能累积失效的 Service Worker/fetch 状态；到期主动换页作为健康维持上限。
const VOICE_PAGE_MAX_AGE_MS = positiveIntEnv('CHATGPT_VOICE_PAGE_MAX_AGE_MS', 600_000);
// startup与fresh voice page共享真实React hydrate预算；不能用更短snapshot误杀正常加载。
const SESSION_PAGE_READY_TIMEOUT_MS = 15_000;
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
  if (BROWSER_WS_ENDPOINT || BROWSER_CDP_URL_ENV) {
    // 显式endpoint代表用户提供的连接边界；profile路径相同也不能反推daemon拥有browser进程。
    // shared连接只创建自己的bootstrap tab并disconnect，禁止关闭既有browser或清理用户tab。
    const endpoint = BROWSER_WS_ENDPOINT || BROWSER_CDP_URL_ENV;
    log(`Connecting to shared browser: ${endpoint}`);
    return { browser: await connectBrowser(BROWSER_WS_ENDPOINT ? { browserWSEndpoint: endpoint } : { browserURL: endpoint }), ownedByDaemon: false, owner: null };
  }
  if (!usesExternalBrowserProfile() && !BROWSER_CDP_URL) {
    // 默认profile本身就是private ownership事实；marker是跨daemon恢复入口，无需扫描Edge PID。
    // 先重连再spawn修复“browser仍活着但daemon已死”造成的profile lock根因。
    const marker = readPrivateDevtoolsMarker();
    if (marker) {
      try {
        log('Reconnecting to daemon-owned browser from DevToolsActivePort');
        const browser = await connectBrowser({ browserWSEndpoint: marker });
        await rememberPrivateBrowserPid(browser);
        return { browser, ownedByDaemon: true, owner: null };
      } catch (error) {
        // marker端点不可达已证明该browser无法再被CDP接管；stale lockfile绝不能在此直接报错短路，
        // 否则异常退出browser的残留锁会让所有后续启动永久失败。必须收敛现场后完整走cold spawn。
        await recoverStalePrivateBrowser(error, log);
      }
    }
    assertBrowserExecutable();
    // 仅在确认profile未锁定后移除stale marker；活动browser的marker绝不能被覆盖。
    // cold spawn先进入blank等CDP，再由唯一bootstrap owner导航，避免直接URL启动竞态。
    const markerFile = path.join(BROWSER_USER_DATA_DIR, 'DevToolsActivePort');
    try { if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile); } catch {}
    const spawnError = spawnBrowser(0, log);
    const browser = await Promise.race([connectPrivateMarker(), spawnError]);
    await rememberPrivateBrowserPid(browser);
    return { browser, ownedByDaemon: true, owner: null };
  }
  if (BROWSER_CDP_URL) {
    let connected;
    try {
      // fixed port可能是用户预启动，也可能是前一daemon启动；端口可达本身不授予close权限。
      // 当前CDP PID/profile/port三元组不匹配时必须shared fail-safe。
      connected = await connectBrowser({ browserURL: BROWSER_CDP_URL });
    } catch (error) {
      // debug-port-only保留既有“不可达后受控启动”合同；显式CDP URL已在shared分支返回。
      // external profile被普通Edge锁定时禁止spawn，不能借固定端口接管用户browser。
      if (!Number.isFinite(BROWSER_DEBUG_PORT) || BROWSER_DEBUG_PORT <= 0) throw error;
      if (usesExternalBrowserProfile() && browserProfileLooksLocked()) throw Object.assign(new Error(`Configured browser profile is already open without reachable DevTools port ${BROWSER_DEBUG_PORT}`), { code: 'BROWSER_CONFIG' });
      assertBrowserExecutable();
      const spawnError = spawnBrowser(BROWSER_DEBUG_PORT, log);
      await Promise.race([waitForDevtools(BROWSER_CDP_URL), spawnError]);
      const browser = await connectBrowser({ browserURL: BROWSER_CDP_URL });
      // PID来自当前endpoint自身而非系统枚举；只用于验证后继daemon的graceful-close权限。
      // record必须晚于成功connect，失败启动不能留下未来误判owned的事实。
      const owner = { profile: BROWSER_USER_DATA_DIR, debugPort: BROWSER_DEBUG_PORT, browserPid: await withTimeout(browserProcessID(browser), BROWSER_CONNECT_TIMEOUT_MS, 'Timed out reading spawned browser ownership') };
      writeBrowserOwner(owner);
      return { browser, ownedByDaemon: true, owner };
    }
    // 可达browser的provenance读取失败只能失去close权限，不能把健康连接误判成需重复spawn。
    const pid = await withTimeout(browserProcessID(connected), BROWSER_CONNECT_TIMEOUT_MS, 'Timed out reading browser ownership').catch(() => null);
    const owner = pid ? { profile: BROWSER_USER_DATA_DIR, debugPort: BROWSER_DEBUG_PORT, browserPid: pid } : null;
    return { browser: connected, ownedByDaemon: !!owner && browserOwnerMatches(owner), owner };
  }
  if (usesExternalBrowserProfile() && browserProfileLooksLocked()) {
    // unlocked external profile是公开launch合同；只有“锁定且无endpoint”状态明确拒绝。
    // 这是确定性配置错误，1/2/4秒退避不会改变普通Edge仍占用profile。
    throw Object.assign(new Error(`Configured browser profile is already open without a reachable DevTools endpoint. Start Edge with a DevTools endpoint or close Edge before launching this daemon. Profile: ${BROWSER_USER_DATA_DIR}`), { code: 'BROWSER_CONFIG' });
  }
  assertBrowserExecutable();
  // external unlocked profile继续使用既有launch，保持登录兼容与真实process ownership。
  // 它不进入default private marker算法，避免把用户选择目录误当daemon永久私有状态。
  const browser = await withTimeout(puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: BROWSER_USER_DATA_DIR,
    headless: false,
    args: browserLaunchArgs(),
    defaultViewport: null,
    protocolTimeout: RESPONSE_TIMEOUT,
  }), 30_000, 'Browser launch timed out');
  return { browser, ownedByDaemon: true, owner: null };
}

async function connectBrowser(endpoint) {
  // TCP preflight只缩短无监听错误；最终协议健康仍以Puppeteer connect为准。
  // helper不决定shared/owned，ownership只能由acquisition分支和provenance赋值。
  if (endpoint.browserURL) await ensureDevtoolsEndpointReachable(endpoint.browserURL);
  return withTimeout(puppeteer.connect({ ...endpoint, defaultViewport: null, protocolTimeout: RESPONSE_TIMEOUT }), BROWSER_CONNECT_TIMEOUT_MS, 'Timed out connecting to browser DevTools endpoint');
}

function readPrivateDevtoolsMarker() {
  try {
    // marker的随机端口和WS route共同构成原browser endpoint；只读端口无法可靠回连。
    // 解析失败按没有可用marker处理，不猜端口、不扫描Edge、不合成成功。
    const [port, route] = fs.readFileSync(path.join(BROWSER_USER_DATA_DIR, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || !route?.startsWith('/')) return null;
    return `ws://127.0.0.1:${port}${route}`;
  } catch { return null; }
}

function readPrivateBrowserPid() {
  // 只回读自己记录的PID事实；损坏/缺失按无记录处理，不猜端口也不做系统级进程扫描。
  const value = readJSON(PRIVATE_BROWSER_PID_FILE, null);
  return Number.isInteger(value?.pid) && value.pid > 0 ? value.pid : null;
}

async function rememberPrivateBrowserPid(browser) {
  // CDP SystemInfo是browser自身报告的主进程PID；记录失败只损失下次挂起时的定点清理能力，
  // 绝不能让一次成功的acquisition因为sidecar写盘问题而回滚。
  try {
    const pid = await browserProcessID(browser).catch(() => null);
    if (pid) writeJSON(PRIVATE_BROWSER_PID_FILE, { pid });
  } catch {}
}

function forgetPrivateBrowserPid() {
  // verified close后记录已失效；删除失败无害，下次启动按PID不存活路径收敛。
  try { fs.unlinkSync(PRIVATE_BROWSER_PID_FILE); } catch {}
}

function browserProcessCommandLine(pid) {
  // 定点读取单个PID的命令行用于身份验证；读取失败返回null并按“无法证明”fail-safe。
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 5_000, windowsHide: true }).trim();
      return output || null;
    }
    if (process.platform === 'darwin') return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null;
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null;
  } catch { return null; }
}

function terminateProcessTree(pid) {
  // 该browser的CDP已不可达，graceful close不再存在；结束整棵进程树防止renderer/helper残留占用profile。
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000, windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {}
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) await sleep(100);
}

async function recoverStalePrivateBrowser(connectError, log) {
  // marker连接失败只说明原browser不可达（ECONNREFUSED=已死，timeout=挂起）；调用方必须继续cold spawn。
  // 用记录的PID做三态收敛：挂起的自有browser→结束进程树；PID被复用或已退出→锁必为残留；无记录→按stale清理。
  log(`Private browser marker unreachable: ${connectError.message}`);
  const pid = readPrivateBrowserPid();
  if (pid && isProcessAlive(pid)) {
    const commandLine = browserProcessCommandLine(pid);
    // 命令行仍带本daemon的--user-data-dir才认定是自有browser；只看进程名无法排除PID复用撞上用户日常Edge。
    if (commandLine && commandLine.toLowerCase().includes(`--user-data-dir=${BROWSER_USER_DATA_DIR}`.toLowerCase())) {
      log(`Terminating hung private browser PID ${pid} before cold restart.`);
      terminateProcessTree(pid);
      await waitForProcessExit(pid, 15_000);
    } else {
      log(`Recorded PID ${pid} does not run this private profile; treating leftover locks as stale.`);
    }
  } else {
    log(pid ? `Recorded private browser PID ${pid} has exited; clearing stale locks.` : 'No private browser PID record; clearing stale locks.');
  }
  // 三种收敛结果都无法证明仍有活browser持有profile；singleton锁与marker残留若不清除，
  // 下一次spawn仍会被误判为profile占用而永久失败。
  for (const name of ['DevToolsActivePort', 'lockfile', 'SingletonLock']) {
    try { const file = path.join(BROWSER_USER_DATA_DIR, name); if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  }
  forgetPrivateBrowserPid();
}

function assertBrowserExecutable() {
  // executable缺失是确定性部署错误；spawn前失败避免四轮相同无效cold start。
  // Windows没有POSIX X_OK语义，只验证存在，实际拒绝仍由spawn producer给出。
  try { fs.accessSync(CHROME_PATH, fs.constants.F_OK | (process.platform === 'win32' ? 0 : fs.constants.X_OK)); }
  catch { throw Object.assign(new Error(`Browser executable is not available: ${CHROME_PATH}`), { code: 'BROWSER_CONFIG' }); }
}

function spawnBrowser(debugPort, log) {
  // detached让browser寿命独立于daemon，但不授予强杀权限；正常关闭仍走CDP。
  // profile参数与--login一致，避免生命周期修复切到没有登录态的另一profile。
  const child = spawn(CHROME_PATH, [`--user-data-dir=${BROWSER_USER_DATA_DIR}`, BROWSER_PROFILE_DIRECTORY ? `--profile-directory=${BROWSER_PROFILE_DIRECTORY}` : null, `--remote-debugging-port=${debugPort}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', process.env.CHATGPT_TEST_HOOKS === '1' && process.env.CHATGPT_TEST_HEADLESS === '1' ? '--headless=new' : null, 'about:blank'].filter(Boolean), { detached: true, stdio: 'ignore' });
  // error事件必须参与acquisition race；只写日志会把确定性ACL/路径错误拖成四轮startup timeout。
  const failed = new Promise((_, reject) => child.once('error', error => {
    log(`Edge spawn failed: ${error.message}`);
    reject(Object.assign(error, { code: ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? 'BROWSER_CONFIG' : 'BROWSER_STARTUP' }));
  }));
  child.unref();
  return failed;
}

async function connectPrivateMarker() {
  // 只轮询同一private profile写出的marker，不探测任意本地端口或普通用户Edge。
  // 30秒是启动边界，具体producer错误仍由startup日志consumer提前返回。
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const endpoint = readPrivateDevtoolsMarker();
    if (endpoint) {
      try { return await connectBrowser({ browserWSEndpoint: endpoint }); } catch {}
    }
    await sleep(250);
  }
  throw Object.assign(new Error('Daemon-owned browser did not expose DevToolsActivePort within 30s'), { code: 'BROWSER_STARTUP' });
}

async function waitForDevtools(url) {
  // fixed-port分支只探测批准的单一端口，禁止递增端口形成第二发现算法。
  // timeout是可恢复runtime事实，下一attempt仍走同一port/profile合同。
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await ensureDevtoolsEndpointReachable(url); return; } catch { await sleep(250); }
  }
  throw Object.assign(new Error(`Browser did not expose DevTools port ${BROWSER_DEBUG_PORT} within 30s`), { code: 'BROWSER_STARTUP' });
}

async function browserProcessID(browser) {
  // SystemInfo读取当前CDP连接自身；选择type=browser避免renderer/helper PID污染ownership。
  // PID只参与三元组相等验证，不用于系统扫描、kill或未知browser接管。
  const session = await browser.target().createCDPSession();
  try {
    const result = await session.send('SystemInfo.getProcessInfo');
    const pid = result.processInfo.find(item => item.type === 'browser')?.id;
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Browser PID is unavailable from CDP');
    return pid;
  } finally { await session.detach().catch(() => {}); }
}

async function prepareBootstrapPage(browser, sharedBrowser) {
  // 先创建daemon-owned tab而不枚举旧pages；异常退出后的孤儿target可能让browser.pages永久等待。
  // shared连接到此为止，绝不能清理用户已有target；新tab仍共享cookie登录态。
  const bootstrap = await browser.newPage();
  if (sharedBrowser) return bootstrap;
  // owned profile中的旧target全部属于前一daemon；用CDP target清单收敛，避免复用退化about:blank。
  const session = await bootstrap.createCDPSession();
  try {
    const current = await session.send('Target.getTargetInfo');
    const targets = await session.send('Target.getTargets');
    await Promise.all(targets.targetInfos
      .filter(target => target.type === 'page' && target.targetId !== current.targetInfo.targetId)
      .map(target => session.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {})));
  } finally { await session.detach().catch(() => {}); }
  return bootstrap;
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
    process.env.CHATGPT_TEST_HOOKS === '1' && process.env.CHATGPT_TEST_HEADLESS === '1' ? '--headless=new' : null,
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

function browserOwnerValue(value) {
  if (!value || !Number.isInteger(value.debugPort) || value.debugPort <= 0 || !Number.isInteger(value.browserPid) || value.browserPid <= 0) return null;
  // profile可能尚未创建；规范化绝对路径即可稳定比较，不能为验证ownership扫描任意browser进程。
  return { profile: path.resolve(value.profile), debugPort: value.debugPort, browserPid: value.browserPid };
}

function browserOwnerMatches(value) {
  // profile/port不足以排除端口被后来browser复用，PID单独又不足以排除PID重用。
  // record缺失或损坏只失去close权限，不阻断shared连接，优先保护用户browser。
  const expected = browserOwnerValue(value);
  const actual = browserOwnerValue(readJSON(BROWSER_OWNER_FILE, null));
  return !!expected && !!actual && expected.profile === actual.profile && expected.debugPort === actual.debugPort && expected.browserPid === actual.browserPid;
}

function writeBrowserOwner(value) {
  const owner = browserOwnerValue(value);
  if (!owner) throw new Error('Browser owner record is invalid');
  // 此记录不含CDP地址或凭据，并独立于daemon.json，确保daemon崩溃后仍能验证同一browser所有权。
  // 原子writeJSON防止异常退出留下半截三元组，损坏记录绝不能授予close权限。
  writeJSON(BROWSER_OWNER_FILE, owner);
}

function deleteBrowserOwner(value) {
  // compare-delete防止旧daemon关闭时删除后继browser刚写入的新ownership事实。
  // mismatch保留记录供真实owner处理，不能把“删除失败”伪装成安全清理成功。
  if (!browserOwnerMatches(value)) return;
  try { fs.unlinkSync(BROWSER_OWNER_FILE); } catch {}
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

async function closeOwnedBrowser(browser, grace = 15_000) {
  // graceful close保护profile持久状态；超时只断开，禁止child.kill破坏cookie写盘。
  // close超时后保留browser供下一daemon重连，比强制结束后猜cookie是否落盘更安全。
  // disconnect不是成功关闭；只有已验证owned的调用者才可compare-delete owner record。
  const pid = await browserProcessID(browser).catch(() => null);
  try { await withTimeout(browser.close(), grace, 'Browser close timed out'); }
  catch { browser.disconnect(); return false; }
  // PID缺失时无法证明主进程已退出；即使协议close成功也保留owner record并禁止cold respawn。
  if (!pid) return false;
  // Browser.close响应只表示CDP接受命令；必须等主进程和profile lock都释放，才能删除ownership或cold start。
  const deadline = Date.now() + grace;
  let released = 0;
  while (Date.now() < deadline) {
    // Windows会在PID退出后短暂保留profile目录句柄；连续两次可写probe避免过早删除owner record。
    released = !isProcessAlive(pid) && !browserProfileLooksLocked() && browserProfileWritable() ? released + 1 : 0;
    if (released >= 2) { forgetPrivateBrowserPid(); return true; }
    await sleep(100);
  }
  return false;
}

function browserProfileWritable() {
  const probe = path.join(BROWSER_USER_DATA_DIR, `.opencode-close-${process.pid}`);
  try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); return true; }
  catch { try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch {} return false; }
}

// voice 转写的客户端断开检测:轮询 shouldCancel,断开时 reject 让 Promise.race 中止转写。
// 必须通过返回的 .stop() 在 finally 中清除定时器,否则成功路径会永久轮询泄漏。
function cancelSignal(shouldCancel, pollMs) {
  let timer;
  const promise = new Promise((_, reject) => {
    const check = () => {
      if (shouldCancel()) reject(Object.assign(new Error('Voice transcription cancelled: client disconnected'), { code: 'VOICE_CANCELLED' }));
      else timer = setTimeout(check, pollMs);
    };
    timer = setTimeout(check, pollMs);
  });
  promise.stop = () => clearTimeout(timer);
  return promise;
}

function makeRequestContext({ deadline, isClientClosed = () => false, runtime, pollMs = 500 }) {
  let timer, notify, stopped = false; // 每个HTTP请求独占timer，禁止voice期限泄漏到ask。
  const currentError = () => {
    if (runtime?.fatalError) return runtime.fatalError; // fatal优先，不能被普通client-close降级为可继续状态。
    if (isClientClosed()) return Object.assign(new Error('Voice transcription cancelled: client disconnected'), { code: 'VOICE_CANCELLED' }); // 保留用户取消语义。
    if (Date.now() >= deadline) return Object.assign(new Error('Voice transcription timed out'), { code: 'VOICE_TIMEOUT' }); // absolute deadline从入队前起算。
    return null;
  };
  // notification只resolve，排队期间尚未建立race也不会产生unhandled rejection。
  const cancelled = new Promise(resolve => { notify = resolve; }); // 只resolve，尚未建立race时也不会产生未处理拒绝。
  const check = () => {
    const error = currentError();
    if (error) notify(error); else if (!stopped) timer = setTimeout(check, pollMs);
  };
  timer = setTimeout(check, pollMs);
  return {
    cancelled, shouldCancel: Object.assign(() => !!currentError(), { remaining: () => Math.max(1, deadline - Date.now()) }), // gate与timeout共享同一时钟事实。
    assertUsable() { const error = currentError(); if (error) throw error; },
    stop() { stopped = true; clearTimeout(timer); },
  };
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

function realUploadRoots() {
  // 默认不限制用户明确传入的附件路径；显式 roots 仍在每次请求时 realpath，作为可选部署边界。
  return EXPLICIT_UPLOAD_ROOTS.map(root => {
    try { return fs.realpathSync.native(root); }
    catch { throw new Error(`upload root does not exist: ${root}`); }
  });
}

function assertUploadFileSafe(file) {
  // daemon 是最后一道外发边界：即使调用者拿到了 bearer token 直接 POST /ask，
  // 也必须重新执行 realpath、regular file 和大小校验；显式 roots 配置存在时再收窄目录。
  if (!path.isAbsolute(file)) throw new Error(`upload file path must be absolute: ${file}`);
  const real = fs.realpathSync.native(path.resolve(file));
  const roots = realUploadRoots();
  if (roots.length > 0 && !roots.some(root => pathInside(root, real))) throw new Error(`upload file is outside allowed roots: ${file}`);
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

function replaceCachedProject(previous, next) {
  withJSONFileLock(PROJECTS_FILE, () => {
    const cache = readProjectCache();
    // 新身份必须先通过页面验证；随后在一个锁内删旧写新，读者不会看到同名alias短暂消失。
    for (const [key, value] of Object.entries(cache.projects)) if ((value?.id || projectIdFromUrl(value?.url)) === previous.id) delete cache.projects[key];
    for (const key of new Set([next.id, next.token, next.key, normalizeProjectKey(next.name)])) if (key) cache.projects[key] = next;
    writeJSON(PROJECTS_FILE, cache);
  });
}

function removeCachedProject(project) {
  withJSONFileLock(PROJECTS_FILE, () => {
    const cache = readProjectCache(); // 必须读取锁内最新值，不能基于锁外快照删除alias。
    // 锁内按当前值比较ID，不能删除另一个daemon刚更新到同名alias的新Project。
    for (const [key, value] of Object.entries(cache.projects)) if ((value?.id || projectIdFromUrl(value?.url)) === project.id) delete cache.projects[key]; // 只删除仍指向旧ID的项。
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
  const allowPlain = entry?.projectID === project.id;
  return entry && isChatSessionUrlForProject(entry.url, project, { allowPlain }) ? entry : null;
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
  const previousPending = readSessionIndex().sessions[sessionID]?.pending;
  // recovery 可能多次保存 partial；若调用点没有新 baseline，必须延续最初发送前计数而不是向前滚动。
  const beforeState = options.beforeState || previousPending?.beforeState;
  writeSessionEntry(sessionID, project, url, {
    lost: null,
    completed: options.preserveCompleted ? undefined : null,
    pending: {
      status: 'generating',
      savedAt: new Date().toISOString(),
      savedResponse: savedResponse || null,
      nativeImageURLs: Array.isArray(options.nativeImageURLs) ? options.nativeImageURLs : previousPending?.nativeImageURLs,
      // turn 基线用于区分“本轮尚无回答”和“页面里已有旧回答”；后续 partial 保存必须原样继承。
      beforeState: beforeState ? { count: beforeState.count || 0, userCount: beforeState.userCount || 0, turnCount: beforeState.turnCount || 0 } : undefined,
      // completedUndelivered 只在 HTTP 客户端错过已完成结果时出现；它要求下次先本地回放，不能扫描 DOM 覆盖产物。
      completedUndelivered: options.completedUndelivered === true || previousPending?.completedUndelivered === true,
    },
  });
}

function clearSessionPending(sessionID, project, url) {
  writeSessionEntry(sessionID, project, url, { pending: null });
}

function markSessionCompleted(sessionID, project, url, requestHash, savedResponse, downloads, nativeImageURLs = []) {
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
      nativeImageURLs,
    },
  });
}

function markSessionLost(sessionID, project, reason, options = {}) {
  // lost 是“禁止静默复用”的墓碑：如果 prompt 已可能发出但没有 /c/... URL，重启后同 ID 不能新建会话。
  // live daemon 仍可在 page.url() 变成 conversation 后补回映射；离开当前浏览器进程则只能让用户新开 session。
  const previous = readSessionIndex().sessions[sessionID];
  // 已知 URL 的旧会话不能被 send-start 覆盖成 lost；pending recovery 才是正确的“不重发”语义。
  if (previous?.url && isChatSessionUrlForProject(previous.url, project, { allowPlain: previous.projectID === project.id })) {
    markSessionPending(sessionID, project, previous.url, null, { beforeState: options.beforeState });
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
    uploadPaths: safeUploadPaths(uploads),
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
  const allowed = VOICE_FILE_ROOTS.some(root => {
    // macOS 上 os.tmpdir() 返回 /var/...，但 realpathSync 返回 /private/var/...；
    // root 不做 realpath 会导致 pathInside 比较失败，误报 "outside allowed roots"。
    let realRoot = root;
    try { realRoot = fs.realpathSync.native(root); } catch {}
    return pathInside(realRoot, real);
  });
  if (!allowed) throw new Error(`Voice file is outside allowed roots: ${input.file}`);
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

function safeUploadPaths(uploads) {
  const safe = uploads.map(file => assertUploadFileSafe(file));
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
  // 本地生成内容归到项目 cache；上传源文件保持用户原路径，不在这里制造第二份长期副本。
  const root = path.join(resolveWorkspaceDir(workspaceDir), '.opencode', 'cache', 'chatgpt');
  return {
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

function safeCacheFile(workspaceDir, root, candidate) {
  if (!candidate) return null;
  const file = path.resolve(candidate);
  if (!pathInside(path.resolve(root), file)) return null;
  try {
    const link = fs.lstatSync(file);
    if (link.isSymbolicLink() || !link.isFile()) return null;
    const workspaceReal = fs.realpathSync.native(resolveWorkspaceDir(workspaceDir));
    const rootReal = fs.realpathSync.native(root);
    const fileReal = fs.realpathSync.native(file);
    if (!pathInside(workspaceReal, rootReal) || !pathInside(rootReal, fileReal)) return null;
    return fileReal;
  } catch {
    return null;
  }
}

function readSavedResponse(workspaceDir, sessionID, savedResponse) {
  if (!savedResponse?.path) return null;
  const root = path.resolve(sessionCacheDirs(workspaceDir, sessionID).responses);
  const file = safeCacheFile(workspaceDir, root, savedResponse.path);
  return file ? fs.readFileSync(file, 'utf8') : null;
}

function replayDownloads(workspaceDir, sessionID, downloads) {
  const root = sessionCacheDirs(workspaceDir, sessionID).downloads;
  // 单个产物被用户删除或替换不应阻断正文回放；只过滤失效项，其余已验证文件仍可返回。
  return (Array.isArray(downloads) ? downloads : []).flatMap(download => {
    const file = safeCacheFile(workspaceDir, root, download?.path);
    return file ? [{ ...download, name: path.basename(file), path: file }] : [];
  });
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
    downloads: replayDownloads(workspaceDir, sessionID, entry.completed.downloads),
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
  // 缓存只提供免等sidebar的候选；启动层仍用唯一ensure验证身份并负责自修复。
  const value = String(requested || DEFAULT_PROJECT).trim();
  const direct = parseProjectRef(value);
  if (direct) return direct;
  const cached = readProjectCache().projects[normalizeProjectKey(value)];
  if (cached) {
    // 缓存可能来自不同版本的 Project/会话 URL；重新解析可恢复 token 并规范化到当前 Project 首页。
    const cachedName = cached.titleName || (cached.name !== cached.id && cached.name !== cached.token ? cached.name : null);
    const fixed = parseProjectRef(cached.url, cachedName) || parseProjectRef(cached.token, cachedName);
    if (fixed) return fixed;
  }
  return null;
}

async function resolveProject(page, requested, log) {
  // cache只提供待验证候选；先用它避免每次ask都跳root/sidebar，身份仍由ensureProjectHome确认。
  const value = String(requested || DEFAULT_PROJECT).trim();
  const direct = parseProjectRef(value);

  log(`Resolving ChatGPT project: ${value}`);
  const cached = resolveCachedProject(value);
  if (cached) {
    log(`Using cached ChatGPT project candidate: ${cached.name}=${cached.id}`);
    return cached;
  }
  const discoveredRaw = await CHATGPT_DOM.discoverProjects(page, log).catch(err => {
    if (err.code === 'PROJECT_AMBIGUOUS') throw err;
    // localStorage/导航/frame 任一瞬态失败都不能截断侧边栏和缓存两级恢复。
    log(`Live Project data discovery failed: ${err.message}`);
    return [];
  });
  const discovered = discoveredRaw
    .map(project => parseProjectRef(project.href, project.name))
    .filter(Boolean)
    .filter((project, index, all) => all.findIndex(item => item.id === project.id) === index);
  log(`Resolved ChatGPT project candidates: ${discovered.map(project => `${project.name}=${project.id}`).join(', ') || 'none'}`);
  const selected = selectDiscoveredProject(discovered, value, direct);
  if (selected) {
    cacheProject(selected);
    return selected;
  }

  // localStorage/schema 漂移时，用可见侧边栏按项目名打开首页并读取实际 URL，不要求用户复制新链接。
  const openedURL = await CHATGPT_DOM.openProjectHome(page, value, log).catch(err => {
    if (err.code === 'PROJECT_AMBIGUOUS') throw err;
    log(`Live Project sidebar recovery failed: ${err.message}`);
    return null;
  });
  const opened = parseProjectRef(openedURL, value);
  if (opened) {
    cacheProject(opened);
    return opened;
  }

  throw new Error(`Could not find ChatGPT project "${value}". Set CHATGPT_PROJECT to a project name or URL.`);
}

async function ensureProjectHome(page, project, log) {
  // visit 同时验证路由、composer、标题与 Chat 模式；单独一个 h1 或可输入框都不足以证明 Project 归属。
  const visit = async candidate => {
    if (!sameUrl(page.url(), candidate.url)) {
      // cache/currentProject 的冷导航也必须经过 DOM 初始化合同，避免 sidebar 路径修复后 fresh goto 仍提前进入验证。
      await CHATGPT_DOM.navigateProjectHome(page, candidate.url);
    }
    // domcontentloaded 早于 React Project header/composer hydrate；轮询页面事实，不能用一次快照误判 URL 失效。
    const deadline = Date.now() + 15_000;
    let unavailable = null;
    let staleURL = null;
    let staleReads = 0;
    while (Date.now() < deadline) {
      // 显式 URL 没有可信 titleName 时允许读取网页真实 h1，但 Project id 仍必须严格匹配 pathname。
      const observation = await CHATGPT_DOM.projectHomeState(page, candidate.titleName);
      if (observation.kind === 'unavailable') {
        unavailable = observation.error || 'Project page unavailable';
        await sleep(250);
        continue;
      }
      const state = observation.state;
      if (state && isProjectHomeUrlForProject(state.url, candidate) && state.composer && state.title) {
        if (!state.chatActive || state.workActive) {
          await CHATGPT_DOM.ensureChatMode(page, log).catch(() => {});
          await sleep(200);
          continue;
        }
        const name = state.titleName || candidate.titleName || candidate.name;
        return { kind: 'valid', project: { ...candidate, name, titleName: name, key: normalizeProjectKey(name || candidate.id) } };
      }
      const visibleID = projectIdFromUrl(state?.url);
      if (visibleID && visibleID !== candidate.id) return { kind: 'stale' };
      if (state?.url && isOfficialChatGPTURL(state.url) && !visibleID) {
        // root/plain conversation需连续两次相同URL才证明导航已稳定离开Project，避免把React过渡态当stale。
        staleReads = staleURL === state.url ? staleReads + 1 : 1;
        staleURL = state.url;
        if (staleReads >= 2) return { kind: 'stale' };
      } else {
        staleURL = null;
        staleReads = 0;
      }
      await sleep(250);
    }
    return { kind: 'unavailable', error: unavailable || 'Project page did not expose a stable Chat composer' };
  };
  // 返回新对象而非修改入参：调用方可能还有正在生成的会话持有旧 Project 快照。
  const initial = await visit(project);
  if (initial.kind === 'valid') {
    cacheProject(initial.project);
    return initial.project;
  }
  if (initial.kind === 'unavailable') {
    throw new Error(`ChatGPT Project "${project.name}" could not be validated: ${initial.error}`);
  }

  // 只有网页事实证明旧身份stale才进入唯一live discovery；瞬态不可读已经在上面保留cache并返回。
  log(`Project page validation failed for ${project.name}; rediscovering from live sidebar`);
  const openedURL = project.titleName ? await CHATGPT_DOM.openProjectHome(page, project.titleName, log).catch(err => {
    if (err.code === 'PROJECT_AMBIGUOUS') throw err;
    log(`Project page self-recovery failed: ${err.message}`);
    return null;
  }) : null;
  if (openedURL) {
    const refreshed = parseProjectRef(openedURL, project.titleName) || { ...project, url: openedURL };
    const recovered = await visit(refreshed);
    if (recovered.kind === 'valid') {
      replaceCachedProject(project, recovered.project);
      return recovered.project;
    }
    if (recovered.kind === 'unavailable') throw new Error(`ChatGPT Project "${project.name}" replacement could not be validated: ${recovered.error}`);
  }
  // 已证明旧ID失效且live sidebar没有可验证替代时才删除，避免每次ask反复命中永久坏alias。
  removeCachedProject(project);
  throw new Error(`ChatGPT Project "${project.name}" could not be opened in Chat mode after automatic rediscovery.`);
}

// ─── Response Persistence And Recovery ───────────────────────────────────────

async function rememberCurrentSessionUrl(page, project, sessionID, log, timeout = 20_000, allowPlain = false, expectedSessionUrl = null) {
  // 不变量一：新会话只接受首个严格 Project conversation，旧会话只接受原 conversation。
  // 不变量二：检测到“另一条合法 conversation”应立即失败，不能靠等待或重写 registry 自愈。
  // 不变量三：只有 URL 验证通过后才写 session entry，页面标题和 Project 文案都不能代替身份。
  // 提交后尽早记录 /c/... URL；即使后续长回答超时，用户仍可用同一个 #id 回到远端生成中的页面。
  // 一旦出现归属不符的 conversation 就立即返回失败，因为继续轮询不能把已创建的远端会话迁回 Project。
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const url = page.url();
    const valid = expectedSessionUrl
      ? isSameConversationUrl(url, expectedSessionUrl, project, { allowPlain })
      : isChatSessionUrlForProject(url, project, { allowPlain });
    if (valid) {
      writeSessionEntry(sessionID, project, url);
      return url;
    }
    // 已进入某条 conversation 但归属不符时不会再靠等待变正确；立即失败，避免多占 20 秒预算。
    if (conversationFromUrl(url)) return null;
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

function requireCurrentConversation(page, expectedSessionUrl, project, allowPlainUrl, sessionID, phase, promptSent) {
  const url = page.url();
  const valid = expectedSessionUrl
    ? isSameConversationUrl(url, expectedSessionUrl, project, { allowPlain: allowPlainUrl === true })
    : isChatSessionUrlForProject(url, project, { allowPlain: allowPlainUrl === true });
  if (valid) return url;
  if (promptSent) markSessionLost(sessionID, project, `ChatGPT page left the recorded conversation during ${phase}.`);
  throw new Error(`Session ${sessionID} left its recorded ChatGPT conversation during ${phase}; no foreign text or artifacts were collected.`);
}

/**
 * 持久化一次 assistant 状态，并同步 session 的 pending 标记。
 *
 * completed 才收集 sandbox/native-image 产物；generating 只保存文本快照。这个分界很重要：
 * 如果在远端工具调用未结束时强行点下载按钮，容易把半成品或旧文件误当成本次结果。
 */
async function persistAssistantResult({ page, project, workspaceDir, sessionID, raw, status, saveToFile, promptSent, requestHash, allowPlainUrl, expectedSessionUrl = null, notice, saveLabel, finalUrl, forceSave, forcePreview, shouldCancel = () => false, beforeState = null, runForeground = task => task(), log }) {
  // 持久化顺序不可交换：先验证 conversation，再创建 cache、抽取 artifact，最后更新 pending/completed。
  // 这样用户在回答等待期间手动切页时，不会把另一会话的文本、引用或文件写入当前 #sessionID。
  // completed 与 generating 共用同一 URL 边界；“回答已完成”不能绕过身份检查。
  // beforeState 保存发送前图片集合，它既用于本轮去重，也必须随 pending/completed 跨断连保存。
  // 文本抽取和 artifact 点击同样属于会话归属边界；页面被手动切换后不能把另一 conversation 的结果写入本句柄。
  finalUrl = requireCurrentConversation(page, expectedSessionUrl, project, allowPlainUrl, sessionID, 'response persistence', promptSent);
  const dirs = sessionCacheDirs(workspaceDir, sessionID);
  ensureWorkspaceCacheDir(workspaceDir, dirs.downloads);

  // artifact 下载会修改浏览器下载目录，因此只在最终态触发；生成中只保留文本和 pending 元数据。
  let artifactNotice = null;
  const pageChanged = () => expectedSessionUrl
    ? !isSameConversationUrl(page.url(), expectedSessionUrl, project, { allowPlain: allowPlainUrl === true })
    : !isChatSessionUrlForProject(page.url(), project, { allowPlain: allowPlainUrl === true });
  const artifactSkipped = status === 'completed' && shouldCancel();
  // 已完成但调用方断连时不清 pending：下次 recovery 还应有机会收集 sandbox/native-image 产物。
  const artifactResult = status === 'completed' && !artifactSkipped
    ? await runForeground(() => CHATGPT_DOM.collectArtifacts(page, dirs.downloads, log, () => shouldCancel() || pageChanged(), beforeState)).catch(err => ({ downloads: [], notices: [`Artifact collection failed: ${err.message}`] }))
    : { downloads: [], notices: shouldCancel() ? ['Artifact collection skipped because caller disconnected.'] : [] };
  finalUrl = requireCurrentConversation(page, expectedSessionUrl, project, allowPlainUrl, sessionID, 'artifact collection', promptSent);
  const completedNativeImageURLs = status === 'completed'
    ? (await CHATGPT_DOM.state(page).catch(() => null))?.nativeImageURLs || beforeState?.nativeImageURLs || []
    : beforeState?.nativeImageURLs || [];
  requireCurrentConversation(page, expectedSessionUrl, project, allowPlainUrl, sessionID, 'artifact snapshot', promptSent);
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

  // plain /c/... 只服务已持久化的历史会话；新 session 必须保留 Project 路径，不能仅凭 project 字段伪装归属。
  if (resolvedStatus === 'generating') markSessionPending(sessionID, project, finalUrl, result.savedResponse, { nativeImageURLs: beforeState?.nativeImageURLs, beforeState });
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
    completedNativeImageURLs,
  );

  return result;
}

/**
 * 恢复一个可能仍在生成的会话。
 *
 * 这个函数是 pending suppression 的执行点：它只读取当前 DOM，保存可见文本和产物，
 * 明确返回 `promptSent:false`。调用方传进来的新 prompt 在这里不会进入 ChatGPT 页面。
 */
async function recoverCurrentAssistant(page, workspaceDir, sessionID, project, session, reason, log, runForeground) {
  const allowPlainUrl = !projectIdFromUrl(session.url);
  requireCurrentConversation(page, session.url, project, allowPlainUrl, sessionID, 'pending recovery', false);
  await runForeground(() => CHATGPT_DOM.focus(page));
  requireCurrentConversation(page, session.url, project, allowPlainUrl, sessionID, 'pending recovery focus', false);
  const state = await CHATGPT_DOM.state(page);
  const baseline = session?.pending?.beforeState;
  const hasBaseline = Number.isFinite(baseline?.count) && Number.isFinite(baseline?.userCount);
  const userAdvanced = !hasBaseline || state.userCount > baseline.userCount;
  const assistantAdvanced = !hasBaseline || state.count > baseline.count;
  const oldImages = new Set(Array.isArray(session?.pending?.nativeImageURLs) ? session.pending.nativeImageURLs : []);
  const imageAdvanced = (state.nativeImageURLs || []).some(url => !oldImages.has(url));
  const completedImageOnlyTurn = imageAdvanced && !state.generating && !state.placeholder;
  // 空 turn 不增加 assistant role 数量；conversation turn 数量才可区分连续两轮相同的“ChatGPT 说：”。
  const emptyTurnAdvanced = state.emptyAssistantTurn && (Number.isFinite(baseline?.turnCount) ? state.turnCount > baseline.turnCount : assistantAdvanced);
  const completedEmptyAssistantTurn = emptyTurnAdvanced && !state.generating && !state.placeholder;
  const unansweredUserMessage = state.userCount > state.count && !completedImageOnlyTurn && !completedEmptyAssistantTurn;
  // 有基线的 marker 必须同时看到本轮 user turn 和新的 assistant/image/empty turn；旧 DOM 不能完成新 prompt。
  const responseAdvanced = !hasBaseline || userAdvanced && (assistantAdvanced || completedImageOnlyTurn || completedEmptyAssistantTurn);
  // 有未回答 user 消息时，lastText 属于上一轮 assistant；不能把旧回答当成本轮 recovery 结果。
  const raw = responseAdvanced && !unansweredUserMessage && state.lastText
    ? await CHATGPT_DOM.extractAssistant(page).catch(() => state.lastText)
    : '';
  const status = responseAdvanced && (raw || completedImageOnlyTurn || completedEmptyAssistantTurn) && !state.generating && !state.placeholder && !unansweredUserMessage
    ? 'completed'
    : 'generating';
  const result = await persistAssistantResult({
    page,
    project,
    workspaceDir,
    sessionID,
    raw,
    status,
    finalUrl: state.url,
    expectedSessionUrl: session?.url || null,
    promptSent: false,
    allowPlainUrl,
    forceSave: !!raw,
    forcePreview: !!raw,
    beforeState: {
      ...(session?.pending?.beforeState || {}),
      nativeImageURLs: Array.isArray(session?.pending?.nativeImageURLs) ? session.pending.nativeImageURLs : [],
    },
    runForeground,
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
function createDaemonRuntime({ browser, bootstrapPage, project = null, initializeProject = async (page, log) => ensureProjectHome(page, await resolveProject(page, DEFAULT_PROJECT, log), log) }) {
  // 三种锁承担不同职责：sessionLocks 保护单 composer，conversationCreateQueue 保护新路由，pageCreateQueue 保护target创建。
  // 它们不能合并成全局串行锁，否则不同 session 的长回答会互相阻塞，失去并发价值。
  // 锁 promise 无论 fulfilled/rejected 都必须推进后继；一次页面或网络错误不能永久毒化队列。
  // runtime Project 使用引用替换，ask 在入口捕获快照；恢复新 ID 时在途请求仍按旧身份完成。
  // page retention 直接读取 registry pending，不用当前 Project 重新解释旧会话，避免身份更新后误关页面。
  // Runtime 是 daemon 的深模块：外部只看到 pageFor/withSession/waitForResponse/status。
  // 这里集中维护并发不变量，避免 HTTP handler、CLI、等待逻辑各自管理一套锁。
  const sessionPages = new Map();
  const sessionLocks = new Map();
  // Project 更新采用对象替换而不是原地修改；每个 ask 捕获自己的快照，避免自修复污染并发中的旧会话。
  // 对象冻结保护“运行中 ask 的身份不可变”；更新只通过 updateProject 原子替换引用。
  let currentProject = project ? Object.freeze({ ...project }) : null;
  let projectInitialization = null;
  let conversationCreateQueue = Promise.resolve();
  let pageCreateQueue = Promise.resolve();
  let voiceLock = Promise.resolve();
  let submissionQueue = Promise.resolve();
  let voiceQueued = 0;
  let voiceActive = 0;
  let voiceSubmitted = 0;
  let foregroundQueue = Promise.resolve(); // 所有可抢前台动作共享一条非重入队列。
  let fatalError = null; // 一旦无法隔离页面任务，后续请求必须一致失败。
  let sparePage = bootstrapPage;
  // voice 转写页持久化复用，但一旦认领就从 spare pool 移除，永远不会再交给 ask。
  let persistentVoicePage = null;
  let voicePageCreatedAt = 0;

  // pending 会话仍可能承载远端生成 DOM；registry 防重发，tab 保留则服务后续 artifact/text recovery。
  const pageCanBeClosed = id => !sessionLocks.has(id) && !isPendingFresh(readSessionIndex().sessions[id]?.pending);

  function borrowVoicePage() {
    for (const [sessionID, page] of sessionPages) { // 只借runtime管理页，绝不扫描用户自己的标签页。
      if (!pageCanBeClosed(sessionID) || page.isClosed() || !isOfficialChatGPTURL(page.url())) continue;
      let unlock, released = false;
      const hold = new Promise(resolve => { unlock = resolve; }); // reservation复用session lock，ask自然排在direct之后。
      const stored = hold.finally(() => { if (sessionLocks.get(sessionID) === stored) sessionLocks.delete(sessionID); }); // compare-delete保护后继锁。
      // 选择与reservation同一同步段完成，ask不能在二者之间抢到composer。
      sessionLocks.set(sessionID, stored);
      const release = () => { if (!released) { released = true; unlock(); } }; // release幂等，错误分支不会重复推进队列。
      return {
        page, release,
        async discard() {
          if (sessionPages.get(sessionID) === page) sessionPages.delete(sessionID); // 仅退役仍绑定此引用的坏页。
          await withTimeout(page.close(), 3_000, 'close borrowed voice page').catch(() => {});
          release();
        },
      };
    }
    return null;
  }

  function assertBrowserConnected() {
    // browser 是 daemon 的核心资源；用户手动关掉窗口后继续复用 page handle 只会得到 Puppeteer 协议错误。
    // 在创建/复用页面前改成结构化错误，让CLI淘汰stale daemon；当前voice不自动重发。
    if (browser.isConnected()) return;
    // BROWSER_DISCONNECTED 是 daemon/client 的本地协议码，不暴露给 ChatGPT，也不依赖 Puppeteer 错误文案。
    const error = new Error('Browser was closed; start a new invocation to launch another daemon.');
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
    if (!await closeIdlePageIfNeeded()) throw new Error(`Maximum active ChatGPT session pages reached (${MAX_SESSION_PAGES}); recover or wait for one pending session first: ${[...sessionPages.keys()].filter(id => isPendingFresh(readSessionIndex().sessions[id]?.pending)).join(', ') || 'none'}`);
    return browser.newPage();
  }

  async function withPageCreationExclusion(task) {
    const previous = pageCreateQueue;
    let release;
    // 同一排他同时保护spare/page cap，并防止target creation打断cold Project的唯一trusted click。
    pageCreateQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await task(); }
    finally { release(); }
  }

  async function claimVoicePage() {
    // 与pageFor共用排他，保证bootstrap/spare在并发ask与voice之间只会被认领一次。
    return withPageCreationExclusion(async () => {
      // persistent 页只属于 voice，不在 sessionPages 中；健康页可跨多次 Alt+V 复用以避免重复导航。
      if (persistentVoicePage && !persistentVoicePage.isClosed()) return persistentVoicePage;
      const page = sparePage && !sparePage.isClosed() ? sparePage : await browser.newPage();
      // 清空 spare 必须和选择发生在同一临界区，否则 pageFor 会在 await 间隙拿到同一个引用。
      if (page === sparePage) sparePage = null;
      persistentVoicePage = page;
      voicePageCreatedAt = Date.now();
      return page;
    });
  }

  async function stabilizeVoicePage(page, waitForTerminal = false) {
    if (waitForTerminal) {
      const converged = await withTimeout(
        CHATGPT_DOM.sessionPageFact(page, { waitForTerminal: true, timeoutMs: SESSION_PAGE_READY_TIMEOUT_MS }),
        SESSION_PAGE_READY_TIMEOUT_MS + 1_000,
        'fresh voice page convergence',
      );
      // fresh页的正常hydrate不消耗renewal；只有terminal仍非认证才进入既有退役路径。
      if (converged?.origin !== CHATGPT_URL || converged?.readyState !== 'complete' || converged.kind !== 'authenticated') {
        throw new Error(`Fresh voice page did not converge: origin=${converged?.origin || 'unknown'} ready=${converged?.readyState || 'unknown'} kind=${converged?.kind || 'unknown'}`);
      }
    }
    for (let probe = 0; probe < 2; probe++) {
      if (page.isClosed()) throw new Error('Voice page closed during stability check');
      const fact = await withTimeout(CHATGPT_DOM.sessionPageFact(page, { waitForTerminal: false, timeoutMs: 0 }), 5_000, 'voice page stability check');
      // core只消费DOM归一后的kind；bootstrap、selector和token解释不能在此复制。
      if (fact?.origin !== CHATGPT_URL || fact?.readyState !== 'complete' || fact.kind !== 'authenticated') {
        throw new Error(`Voice page is not stable: origin=${fact?.origin || 'unknown'} ready=${fact?.readyState || 'unknown'} kind=${fact?.kind || 'unknown'}`);
      }
      // 两次事实之间只让出一个event-loop turn；不引入固定等待或后台轮询。
      if (probe === 0) await new Promise(resolve => setImmediate(resolve));
    }
  }

  return {
    get project() { return currentProject; },
    get fatalError() { return fatalError; },
    fail(error) {
      fatalError ||= Object.assign(new Error(`Browser runtime could not isolate a cancelled task: ${error.message}`), { code: 'VOICE_RUNTIME_FATAL' }); // sticky fatal阻止新远端副作用。
      return fatalError;
    },
    updateProject(next) {
      // 仅后续 runAsk 会读取新对象，已经捕获旧对象的 finish/recovery 不会跨 Project 落盘。
      currentProject = Object.freeze({ ...next });
      return currentProject;
    },
    async ensureProject(page, log) {
      if (currentProject) return currentProject;
      if (projectInitialization) return projectInitialization;
      // default Project只为需要它的新会话初始化；并发first ask共享同一转换，避免重复sidebar导航。
      // cold Project包含可信导航/click/init等跨页副作用，必须与voice direct共用同一队列；完成后立即释放，不串行回答等待。
      // Project仍由submissionQueue排序远端副作用；额外排他只阻止同时创建target，不串行voice direct。
      // 锁顺序固定为submission后page exclusion；pageFor不会反向持有排他再申请submission，避免形成环。
      const task = this.withSubmission(() => withPageCreationExclusion(() => initializeProject(page, log))).then(next => {
        currentProject = Object.freeze({ ...next });
        return currentProject;
      });
      projectInitialization = task;
      try { return await task; }
      finally {
        // 失败不能永久缓存；compare-delete也避免旧任务清掉后来一次初始化。
        if (projectInitialization === task) projectInitialization = null;
      }
    },
    status() {
      const pages = [...sessionPages.keys()];
      const pendingPages = pages.filter(id => isPendingFresh(readSessionIndex().sessions[id]?.pending));
      // status 默认只给数量，不泄露 #sessionID；调试句柄需要显式打开环境变量。
      return {
        // browserConnected 区分“Node daemon 还活着”和“可继续驱动 ChatGPT 页面”；status 仍只读，不触发重启。
        browserConnected: browser.isConnected(),
        // 下面仍保留原有 session 计数语义，避免 browser health 字段改变 status 的既有诊断输出结构。
        pageCount: pages.length,
        pendingPageCount: pendingPages.length,
        activeLocks: sessionLocks.size,
        voiceActive,
        voiceQueued,
        voicePageCount: persistentVoicePage && !persistentVoicePage.isClosed() ? 1 : 0,
        managedPageCount: new Set([...sessionPages.values(), persistentVoicePage].filter(page => page && !page.isClosed())).size,
        voiceSubmitted,
        maxPages: MAX_SESSION_PAGES,
        ...(process.env.CHATGPT_STATUS_SHOW_SESSIONS === '1' ? { pages, pendingPages } : {}),
      };
    },
    async pageFor(sessionID) {
      assertBrowserConnected();
      const current = sessionPages.get(sessionID);
      if (current && !current.isClosed()) {
        // 已绑定page不创建target，绕过排他才能保持不同existing Session的恢复并发。
        sessionPages.delete(sessionID);
        sessionPages.set(sessionID, current);
        return current;
      }

      return withPageCreationExclusion(async () => {
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
      });
    },
    async voicePage(attempts = 2) {
      // 专属页只用于direct；首次候选失败时允许在音频POST前续租一次。
      assertBrowserConnected();
      if (persistentVoicePage && voicePageCreatedAt && Date.now() - voicePageCreatedAt > VOICE_PAGE_MAX_AGE_MS) {
        await withTimeout(persistentVoicePage.close(), 3_000, 'close aged voice page').catch(() => {});
        persistentVoicePage = null;
        voicePageCreatedAt = 0;
      }
      let lastError;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const candidate = await claimVoicePage();
        try {
          let navigated = false;
          if (!isOfficialChatGPTURL(candidate.url())) {
            await candidate.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
            navigated = true;
          }
          // 只有本次导航的candidate需要等待terminal；复用页继续用快速连续snapshot。
          await stabilizeVoicePage(candidate, navigated);
          return candidate;
        } catch (err) {
          lastError = err;
          if (candidate === persistentVoicePage) persistentVoicePage = null;
          voicePageCreatedAt = 0;
          await withTimeout(candidate.close(), 3_000, 'close degraded voice page').catch(() => {});
        }
      }
      throw lastError || new Error('Could not allocate a healthy ChatGPT voice page');
    },
    async voiceLease() {
      assertBrowserConnected();
      const borrowed = borrowVoicePage();
      if (borrowed) {
        try {
          await stabilizeVoicePage(borrowed.page);
          return borrowed;
        } catch {
          // borrowed页失败发生在POST前；关闭并释放Session reservation后只续租一个专属页。
          await borrowed.discard();
        }
      }
      const page = await this.voicePage(borrowed ? 1 : 2);
      return { page, release() {}, discard: () => this.invalidateVoicePage(page) };
    },
    borrowVoicePage,
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
      // 同一browser runtime串行提交voice，避免复用页、取消和退役生命周期互相覆盖。
      const previous = voiceLock;
      voiceQueued++;
      const run = previous.then(async () => {
        voiceQueued--;
        voiceActive++;
        try { return await task(); }
        finally { voiceActive--; }
      }, async () => {
        voiceQueued--;
        voiceActive++;
        try { return await task(); }
        finally { voiceActive--; }
      });
      voiceLock = run.catch(() => {});
      return run;
    },
    withSubmission(task) {
      // voice与ask只互斥远端提交/接受事务；前项失败必须继续推进，不能毒化daemon后续请求。
      const run = submissionQueue.then(task, task);
      submissionQueue = run.catch(() => {});
      return run;
    },
    noteVoiceSubmitted() { voiceSubmitted++; },
    withForeground(task, context) {
      let started = false;
      const internal = foregroundQueue.then(() => { context.assertUsable(); started = true; return task(); }); // started只在最终gate之后翻转。
      // tail吞掉前项失败只为推进队列；caller仍观察原始internal结果。
      internal.catch(() => {});
      foregroundQueue = internal.catch(() => {}); // 前项失败不能永久毒化后续foreground动作。
      return { internal, hasStarted: () => started };
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
      return CHATGPT_DOM.waitForResponse(page, beforeState, { ...waitOptions, foregroundPulseMs: 8_000, shouldSkipForeground: () => !!waitOptions.shouldCancel?.(), runForeground: task => this.withForeground(() => waitOptions.shouldCancel?.() ? undefined : task(), { assertUsable() { if (fatalError) throw fatalError; } }).internal }, log);
    },
    // 返回 daemon 当前管理的所有页面引用（bootstrapPage + sessionPages + voicePage），
    // 供 stale page cleanup 判断哪些页面不该被关闭。
    managedPages() {
      return [...sessionPages.values(), persistentVoicePage].filter(p => p && !p.isClosed());
    },
    // 转写失败后立即撤销 voice 所有权并关闭页面；下次调用只会认领/创建另一个干净页面。
    // 健康检查无法检测所有退化模式（如健康检查通过后转写期间才发生的退化），
    // 此方法作为兜底：失败后不再复用该页面，下次 voicePage() 会创建新页面。
    async invalidateVoicePage(page) {
      if (page === persistentVoicePage) {
        persistentVoicePage = null; // close前先撤销所有权，下一请求不能再次取得正在退役的页。
        voicePageCreatedAt = 0;
        await withTimeout(page.close(), 3_000, 'close failed voice page').catch(() => {});
      } else if (page === sparePage) {
        sparePage = null;
      }
    },
  };
}

// ─── Voice Flow ──────────────────────────────────────────────────────────────

async function runVoiceTranscribe(runtime, input, log, shouldCancel = () => false) {
  log(`voice: transcribing ${path.basename(input.file)} bytes=${fs.statSync(input.file).size}`);
  const cancel = cancelSignal(shouldCancel, 500);
  let lease;
  let submitted = false;
  let cancelledBeforeSubmission = false;
  let queueStarted = false;
  let requestID;
  // voice lease/preflight与direct必须保持同一队列所有权；否则Project click可与另一页的稳定性evaluate重叠。
  const direct = runtime.withSubmission(async () => {
    queueStarted = true;
    if (cancelledBeforeSubmission || shouldCancel()) throw Object.assign(new Error('Voice transcription cancelled before submission'), { code: 'VOICE_CANCELLED' });
    const acquired = await runtime.voiceLease();
    if (cancelledBeforeSubmission || shouldCancel()) {
      await acquired.discard();
      throw Object.assign(new Error('Voice transcription cancelled during page preparation'), { code: 'VOICE_CANCELLED' });
    }
    lease = acquired;
    const page = lease.page;
    requestID = crypto.randomBytes(8).toString('hex'); // compare-and-delete和abort都绑定本次页面任务。
    submitted = true;
    runtime.noteVoiceSubmitted();
    // 页面AbortController必须消费当前请求剩余预算，不能让内部固定timer早于同一个绝对deadline。
    // optional fallback只服务内部直接调用；真实HTTP请求总会携带request context的remaining。
    return CHATGPT_DOM.transcribeAudioFile(page, input.file, CHATGPT_URL, log, shouldCancel, () => {}, { mode: 'direct', requestID, timeoutMs: shouldCancel.remaining?.() || VOICE_TRANSCRIBE_TIMEOUT_MS });
  });
  // cancelSignal只负责停止当前direct；稳定性与完成均来自page probe和完整HTTP响应。
  try {
    const text = await Promise.race([
      withTimeout(direct, shouldCancel.remaining?.() || VOICE_TRANSCRIBE_TIMEOUT_MS,
      `Voice transcription timed out after ${VOICE_TRANSCRIBE_TIMEOUT_MS}ms`),
      cancel,
    ]);
    lease?.release();
    return { ok: true, text };
  } catch (err) {
    direct.catch(() => {});
    // queue尚未取得所有权时只锁存取消事实；迟到任务进入队列后会在创建page前无副作用退出。
    if (!submitted) {
      cancelledBeforeSubmission = true;
      if (queueStarted) {
        try { await withTimeout(direct.catch(() => {}), 1_000, 'cancelled voice task did not settle'); }
        catch (cleanupError) { throw runtime.fail(cleanupError); }
      }
      throw err;
    }
    let settled = false;
    if (err.code === 'VOICE_CANCELLED') {
      try { await withTimeout(CHATGPT_DOM.cancelDirectVoice(lease.page, requestID), 500, 'abort direct voice'); await withTimeout(direct.catch(() => {}), 500, 'settle direct voice'); settled = true; } catch {}
    }
    // endpoint失败不损坏页面；transport/page/timeout必须隔离，且音频POST后绝不续租或重发。
    if (settled || err.code === 'VOICE_ENDPOINT') lease.release();
    else await lease.discard();
    if (/cancelled|timed out|timeout|abort|target closed|protocol error/i.test(err.message)) {
      try { await withTimeout(direct.catch(() => {}), 1_000, 'cancelled voice task did not settle'); }
      catch (cleanupError) { throw runtime.fail(cleanupError); }
    }
    throw err;
  } finally {
    // 无论成功/超时/取消都清除轮询；direct路径不持有前台状态。
    cancel.stop();
  }
}

async function runVoiceRequest(runtime, input, log, isClientClosed) {
  const context = makeRequestContext({ deadline: Date.now() + VOICE_TRANSCRIBE_TIMEOUT_MS, isClientClosed, runtime }); // deadline包含排队时间。
  try {
    let started = false; const operation = runtime.withVoice(async () => {
      // 取消或排队超时必须先于realpath/stat/read，避免TUI已删除WAV后旧任务仍访问磁盘。
      context.assertUsable(); started = true; const parsed = validateVoiceInput(input); context.assertUsable();
      return runVoiceTranscribe(runtime, parsed, log, context.shouldCancel);
    });
    operation.catch(error => runtime.onFatal?.(error)); // caller先取消后，迟到fatal仍必须触发daemon退出。
    return await Promise.race([operation, context.cancelled.then(error => { if (started) return operation; throw error; })]);
  } finally {
    context.stop();
  }
}

// 凭据导出是 TUI 私有 side-channel（同 /voice/transcribe-file 语义）：
// 复用 voice 页面所有权模型，把 bootstrap token 与 HttpOnly cookie 导出给本机调用方。
// token/cookie 值只进入 HTTP 响应体，永不写入 daemon 日志。
async function runAuthExport(runtime) {
  let lease;
  const operation = runtime.withVoice(async () => {
    // 导出与转写共享 voice 锁和提交队列：不能与 voice/ask 的页面事务并发操作同一页面域。
    return runtime.withSubmission(async () => {
      lease = await runtime.voiceLease();
      const page = lease.page;
      // 页面任务内部检查 origin：Node 侧 url() 与 evaluate 之间存在导航竞态。
      const fact = await page.evaluate(() => {
        const node = document.querySelector('#client-bootstrap');
        const bootstrap = node ? JSON.parse(node.textContent || 'null') : null;
        return {
          origin: location.origin,
          authStatus: bootstrap ? bootstrap.authStatus : null,
          accessToken: (bootstrap && bootstrap.session && bootstrap.session.accessToken) || null,
        };
      });
      if (fact.origin !== CHATGPT_URL || fact.authStatus !== 'logged_in' || typeof fact.accessToken !== 'string' || !fact.accessToken) {
        // 登录介入是确定性错误：不能借 HTTP 500 外壳进入 CLI 的可重试集合（同 VOICE_AUTH 语义）。
        throw Object.assign(new Error('ChatGPT page is not logged in'), { code: 'AUTH_EXPORT_LOGIN_REQUIRED' });
      }
      const cdp = await page.createCDPSession();
      // CDP 可读 HttpOnly 会话 cookie；这是导出存在的唯一理由（页面 JS 拿不到它们）。
      const result = await cdp.send('Network.getCookies', { urls: [CHATGPT_URL] });
      await cdp.detach();
      // CDP 协议返回 { cookies: [...] }；形状漂移 fail-closed，不猜第二种结构。
      if (!result || typeof result !== 'object' || !Array.isArray(result.cookies)) {
        throw Object.assign(new Error('CDP cookie export returned an unexpected shape'), { code: 'AUTH_EXPORT_CDP_SHAPE' });
      }
      // slim 形状与 opencode 侧 authFromHarvest 一一对应；expires 保留 CDP 原值（-1 会话 cookie 由 opencode 归零）。
      const slim = result.cookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        expires: typeof c.expires === 'number' ? c.expires : 0,
        httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || undefined,
      }));
      return { ok: true, authStatus: fact.authStatus, accessToken: fact.accessToken, cookies: slim, fetchedAt: new Date().toISOString() };
    });
  });
  try {
    const result = await operation;
    lease.release();
    return result;
  } catch (err) {
    // 读取类失败后页面健康度未知：退役页面，下次导出/转写只认领新页；导出绝不重试第二算法。
    if (lease) await lease.discard().catch(() => {});
    throw err;
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
  // 新会话与续聊在这里分叉：前者允许建立一个 conversation ID，后者从一开始就固定已有 ID。
  // pending/completed 检查发生在任何新 prompt 填充之前，保证恢复调用绝不会偷偷追加 user turn。
  // 本函数只持有本轮 Project 快照；runtime 后续更新不应改变 finishAsk 的验证与落盘参数。
  // 所有可能发送的路径都经过 submitAsk，避免某个 mode/upload 分支漏掉发送前身份复核。
  const files = normalizePathList(input.uploadPaths || input.uploadPath);
  const workspaceDir = input.workspaceDir || process.cwd();
  const hash = requestHash(input.fullPrompt, files, input.mode, input.imageAspectRatio);
  const index = readSessionIndex();
  const stored = index.sessions[sessionID];
  // existing Session必须先按registry判断归属；当前default Project失效不能阻断pending/replay/续聊恢复。
  if (!stored && !input.newSession && index.corruptBackup) throw new Error(`Session registry was recovered from corrupt state at ${index.corruptBackup}; this unknown sessionID cannot be recovered safely. Start a new sessionID.`);
  if (!stored && !input.newSession) throw new Error(`Unknown sessionID ${sessionID}; start a new sessionID for a deliberate new conversation.`);
  const page = await runtime.pageFor(sessionID);
  const runForeground = task => runtime.withForeground(task, { assertUsable() { if (runtime.fatalError) throw runtime.fatalError; if (shouldCancel()) throw new Error('Ask cancelled before foreground action'); } }).internal; // send后路径只调用允许的动作。
  // 续聊绑定 registry 中的 Project 快照；daemon 自修复到同名新 ID 时也不能改写已存在会话的归属。
  // 新会话或缺少有效历史身份的兼容记录才进入single-flight；有效旧会话不依赖当前默认Project。
  let project = input.newSession ? await runtime.ensureProject(page, log) : projectForSessionEntry(stored, null) || await runtime.ensureProject(page, log);
  let session = readSessionEntry(sessionID, project);
  if (input.newSession && session) throw new Error(`sessionID collision for ${sessionID}; retry the request`);
  // registry条目与其Project快照不一致时仍拒绝，不能退回当前tab或default Project猜测会话。
  if (!session && !input.newSession) throw new Error(`Unknown sessionID ${sessionID}; start a new sessionID for a deliberate new conversation.`);
  // lost 没有可信 conversation ID，不能用当前 tab 的任意同 Project 会话“复活”；这会静默串到历史对话。
  if (session?.lost) throw new Error(`Session ${sessionID} previously sent a prompt but lost its conversation URL; cannot safely send another prompt. Start a new sessionID.`);
  log(`ask: sessionID=${sessionID} mode=${input.mode || 'auto'} imageAspectRatio=${input.imageAspectRatio || 'default'} saveToFile=${!!input.saveToFile} uploads=${files.length || 'none'} workspace=${workspaceDir} len=${input.fullPrompt.length}`);

  if (!session) {
    const submission = await runtime.withNewConversationLock(async () => {
      project = await runForeground(() => restoreSessionPage(page, project, null, sessionID, log)); // 新会话Project DOM仍由ask前台owner独占。
      runtime.updateProject(project);
      return runtime.withSubmission(() => submitAsk(page, input.fullPrompt, files, workspaceDir, input.mode, input.imageAspectRatio, sessionID, project, false, null, log, shouldCancel, runtime));
    });
    log('Prompt sent, waiting for response...');
    return finishAsk({
      page,
      runtime,
      project,
      beforeState: submission.beforeState,
      expectedSessionUrl: submission.conversationUrl,
      sessionID,
      workspaceDir,
      saveToFile: input.saveToFile,
      requestHash: hash,
      allowPlainUrl: false,
      slow: files.length > 0 || input.fullPrompt.length > 2_000,
      shouldCancel,
      log,
      runForeground,
    });
  }

  const execute = async () => {
    await restoreSessionPage(page, project, session, sessionID, log);
    if (session?.pending?.completedUndelivered && session.completed) {
      // HTTP 已断开但 runAsk 已完整落盘时，直接重放原 snapshot/产物；重新扫 DOM 会过滤图片并覆盖下载元数据。
      const replay = completedReplayResult(session, workspaceDir, sessionID, input.saveToFile);
      if (replay) {
        clearSessionPending(sessionID, project, session.url);
        replay.notice = 'Previous request completed after its client disconnected; recovered the saved result without sending this prompt.';
        return replay;
      }
    }
    const currentState = await CHATGPT_DOM.state(page);
    const unansweredUserMessage = currentState.userCount > currentState.count;
    // pending TTL 不是“直接允许重发”的开关：fresh 一律恢复；stale 只有在页面已经没有可恢复 DOM 时才清理。
    // stale pending 仍是“先检查远端”的信号，但不再长期占用 page-retention 的 fresh 名额。
    const freshPending = session?.pending && isPendingFresh(session.pending);
    if (freshPending || (session?.pending && (currentState.generating || unansweredUserMessage || currentState.lastText)) || (session && (currentState.generating || unansweredUserMessage))) {
      // 已有未完成状态时，本次输入被当作“恢复请求”，不会写入 ChatGPT 页面。
      return recoverCurrentAssistant(page, workspaceDir, sessionID, project, session, recoveryReason(sessionID, currentState, unansweredUserMessage, session), log, runForeground);
    }
    if (session?.pending) {
      log(`Clearing stale pending marker for ${sessionID}; no recoverable DOM state is visible`);
      clearSessionPending(sessionID, project, session.url);
      session = readSessionEntry(sessionID, project);
    }
    if (isCompletedFresh(session?.completed, hash)) {
      const replay = completedReplayResult(session, workspaceDir, sessionID, input.saveToFile);
      if (replay) return replay;
      log(`Completed replay snapshot for ${sessionID} is missing; accepting the prompt as a deliberate new turn`);
    }

    const allowPlainUrl = !projectIdFromUrl(session.url);
    // URL记入registry前仍属于远端接受事务；生成等待从下一行开始，不占submission queue。
    const submission = await runtime.withSubmission(() => submitAsk(page, input.fullPrompt, files, workspaceDir, input.mode, input.imageAspectRatio, sessionID, project, allowPlainUrl, session.url, log, shouldCancel, runtime));
    log('Prompt sent, waiting for response...');

    return finishAsk({
      page,
      runtime,
      project,
      beforeState: submission.beforeState,
      expectedSessionUrl: submission.conversationUrl,
      sessionID,
      workspaceDir,
      saveToFile: input.saveToFile,
      requestHash: hash,
      // 仅持久化 URL 本来就是 plain 的历史记录继续兼容；Project-scoped 会话不能在后续 turn 逃逸。
      allowPlainUrl,
      slow: files.length > 0 || input.fullPrompt.length > 2_000,
      shouldCancel,
      log,
      runForeground,
    });
  };

  return execute();
}

async function restoreSessionPage(page, project, session, sessionID, log) {
  // 新会话恢复的是 Project 首页；已有会话恢复的是 registry 记录的精确 conversation，两者不能互换。
  // 目标 URL 在 goto 前先过 origin/Project policy，防止损坏 registry 产生一次危险的跨域导航。
  // goto 后再验证一次是为了捕获删除、权限变化、登录漂移造成的服务器或 SPA 重定向。
  // slug 可以变化，但 conversation ID 与 Project ID 必须保持；plain 历史会话也必须保持同一个 ID。
  if (!session) {
    log(`Starting session ${sessionID} in ${project.name}`);
    return ensureProjectHome(page, project, log);
  }
  const targetUrl = session.url;
  const allowPlain = !projectIdFromUrl(targetUrl);
  // 先验证 registry 目标再导航，阻止损坏状态把受控浏览器带到伪造 ChatGPT DOM 的第三方 origin。
  if (!isChatSessionUrlForProject(targetUrl, project, { allowPlain })) {
    throw new Error(`Session ${sessionID} has an invalid or foreign conversation URL; no navigation or prompt was attempted.`);
  }
  if (isSameConversationUrl(page.url(), targetUrl, project, { allowPlain })) return project;
  log(`Restoring session ${sessionID}`);
  // ChatGPT 页面会长期保持流式/预取连接；等待 networkidle 容易误判超时，composer 自己再等具体 selector。
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  // 被删会话、权限变化和登录漂移都会重定向；恢复失败必须在 composer 填充之前终止。
  await sleep(500);
  if (!isSameConversationUrl(page.url(), targetUrl, project, { allowPlain })) {
    throw new Error(`Session ${sessionID} was redirected away from its registered ChatGPT conversation; no prompt was sent.`);
  }
  return project;
}

function recoveryReason(sessionID, state, unansweredUserMessage, session) {
  if (state.generating) return `session ${sessionID} is still generating in ChatGPT`;
  if (unansweredUserMessage) return `session ${sessionID} has a submitted prompt without a recoverable assistant response yet`;
  if (session?.pending) return `session ${sessionID} was previously marked pending; recovered it before accepting a new prompt`;
  return `session ${sessionID} is not ready for a new prompt`;
}

async function submitAsk(page, fullPrompt, files, workspaceDir, mode, imageAspectRatio, sessionID, project, allowPlainUrl, expectedSessionUrl, log, shouldCancel, runtime) {
  // beforeSend 是远端副作用的最后门：它在可信点击前同步验证当前页，失败时不会触发 click。
  // 点击开始先写 lost/pending 防重发标记；取得可信 conversation URL 后再把句柄升级为可恢复状态。
  // 新会话没有 expectedSessionUrl，因此允许记录首个 Project conversation；续聊必须精确匹配旧 URL。
  // URL 记录失败代表 prompt 可能已发出，只能显式失败并阻止复用，不能向上层伪装 completed。
  const beforeState = await runtime.withForeground(() => CHATGPT_DOM.submit(page, fullPrompt, files, mode, imageAspectRatio, log, shouldCancel, baseline => { // 整个composer事务持有同一foreground lease。
    // 最后一刻再次验证页面归属；等待上传期间发生重定向时，可信点击绝不能落到错误页面。
    const valid = expectedSessionUrl
      ? isSameConversationUrl(page.url(), expectedSessionUrl, project, { allowPlain: allowPlainUrl })
      : isProjectHomeUrlForProject(page.url(), project);
    if (!valid) throw new Error(`ChatGPT page left the expected ${expectedSessionUrl ? 'conversation' : 'Project home'} before send; no prompt was sent.`);
    markSessionLost(sessionID, project, 'Prompt send click started but no conversation URL has been recorded yet.', { beforeState: baseline });
  }), { assertUsable() { if (runtime.fatalError) throw runtime.fatalError; if (shouldCancel()) throw new Error('Ask cancelled before foreground submit'); } }).internal;
  // 先记住 /c/...，再进入长等待；等待超时也能通过 registry 找回远端会话。
  const recorded = await rememberCurrentSessionUrl(page, project, sessionID, log, 20_000, allowPlainUrl, expectedSessionUrl);
  if (!recorded) {
    // click 已发生但严格 URL 未出现：保留 lost 墓碑并显式失败，不能把 Project 外回答包装成 completed。
    const error = new Error(`Prompt was submitted, but ChatGPT did not expose the expected ${allowPlainUrl ? 'conversation' : 'Project conversation'} URL; reuse is blocked to prevent duplicate sending.`);
    error.promptMayHaveBeenSent = true;
    throw error;
  }
  return { beforeState, conversationUrl: recorded };
}

function assistantTextAdvanced(state, before) {
  // 文本可与上一轮完全相同；assistant turn 数量增长同样能证明它属于本轮，而不是旧文本重排。
  return !!state?.lastText && (state.count > before.count || state.lastText !== before.lastText);
}

async function finishAsk({ page, runtime, project, beforeState, expectedSessionUrl, sessionID, workspaceDir, saveToFile, requestHash, allowPlainUrl, slow, shouldCancel, runForeground, log }) {
  // 回答等待前已经固定 expectedSessionUrl；等待异常、正常完成和 artifact 收集都必须沿用同一身份。
  // 页面离开原 conversation 时不读取 lastText，因为那可能是用户刚打开的另一条历史回答。
  // wait failure 只在 URL 仍正确时保存 partial；身份错误优先级高于“尽量返回已有文本”。
  // 最终持久化会再次验证 URL，形成发送前、等待后、落盘前三道独立防线。
  let waitResult;
  try {
    waitResult = await runtime.waitForResponse(page, beforeState, { slow, shouldCancel }, log);
  } catch (err) {
    const failedUrl = isSameConversationUrl(page.url(), expectedSessionUrl, project, { allowPlain: allowPlainUrl === true })
      ? page.url()
      : await rememberCurrentSessionUrl(page, project, sessionID, log, 3_000, allowPlainUrl, expectedSessionUrl);
    if (!failedUrl) {
      markSessionLost(sessionID, project, 'ChatGPT page left the recorded conversation while waiting for a response.');
      throw new Error(`Session ${sessionID} left its recorded ChatGPT conversation while waiting; no response was collected.`);
    }
    await runForeground(() => CHATGPT_DOM.focus(page)).catch(() => {});
    requireCurrentConversation(page, expectedSessionUrl, project, allowPlainUrl, sessionID, 'wait-failure focus', true);
    const state = await CHATGPT_DOM.state(page).catch(() => null);
    const hasNewAssistantText = assistantTextAdvanced(state, beforeState);
    // wait failure 不能把上一轮 assistant 当成本轮 partial；只有 DOM 出现新 assistant 证据才保存文本。
    let raw = '';
    if (hasNewAssistantText) {
      requireCurrentConversation(page, expectedSessionUrl, project, allowPlainUrl, sessionID, 'wait-failure extraction', true);
      raw = await CHATGPT_DOM.extractAssistant(page).catch(() => state.lastText);
    }
    return persistAssistantResult({
      page,
      project,
      workspaceDir,
      sessionID,
      raw,
      status: 'generating',
      saveToFile,
      requestHash,
      allowPlainUrl,
      expectedSessionUrl,
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
  const finalUrl = isSameConversationUrl(currentUrl, expectedSessionUrl, project, { allowPlain: allowPlainUrl === true })
    ? currentUrl
    : await rememberCurrentSessionUrl(page, project, sessionID, log, 5_000, allowPlainUrl, expectedSessionUrl);
  if (!finalUrl) {
    markSessionLost(sessionID, project, 'ChatGPT page left the recorded conversation before response collection.');
    throw new Error(`Session ${sessionID} left its recorded ChatGPT conversation before response collection; no text or artifacts were collected.`);
  }
  writeSessionEntry(sessionID, project, finalUrl);

  const stillGenerating = waitResult.status === 'generating';
  let extractionNotice = null;
  // send后断连只跳过前台动作，URL校验、状态快照和pending防重发仍必须完成。
  if (waitResult.reason !== 'client-disconnected') await runForeground(() => CHATGPT_DOM.focus(page)).catch(() => {});
  requireCurrentConversation(page, expectedSessionUrl, project, allowPlainUrl, sessionID, 'response focus', true);
  const fallbackState = await CHATGPT_DOM.state(page).catch(() => null);
  const hasNewAssistantText = assistantTextAdvanced(fallbackState, beforeState);
  // submitted-no-assistant / timeout 场景只落 pending，不拿上一轮 assistant 充当 partial。
  let raw = '';
  if (hasNewAssistantText) {
    requireCurrentConversation(page, expectedSessionUrl, project, allowPlainUrl, sessionID, 'response extraction', true);
    raw = await CHATGPT_DOM.extractAssistant(page).catch(err => {
      extractionNotice = `Markdown extraction failed; saved visible assistant text instead: ${err.message}`;
      log(extractionNotice);
      return fallbackState?.lastText || '';
    }) || '';
  }
  const result = await persistAssistantResult({
    page,
    project,
    workspaceDir,
    sessionID,
    raw,
    status: waitResult.status,
    saveToFile,
    requestHash,
    allowPlainUrl,
    expectedSessionUrl,
    finalUrl: finalUrl || currentUrl,
    promptSent: true,
    shouldCancel,
    beforeState,
    runForeground,
    log,
    saveLabel: stillGenerating
      ? 'Current partial assistant response saved locally before returning to OpenCode'
      : 'Full response saved locally before returning to OpenCode',
    notice: [
      stillGenerating ? 'ChatGPT is still generating. Reuse the same sessionID to recover the latest text before sending another prompt.' : null,
      extractionNotice,
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

function sendJSON(res, status, value) {
  // 返回布尔值让离线测试同时验证“关闭时不写”和“正常时确实发送”，而不是复制 handler 逻辑。
  // destroyed 与 writableEnded 任一成立都表示 response 所有权已经结束，此时任何写入都是进程级风险。
  // client cancel 后 response 可能先于业务 promise 关闭；迟到结果必须被丢弃，不能让 writeHead 异常杀死共享 daemon。
  if (res.destroyed || res.writableEnded) return false;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
  return true;
}

function installBrowserDisconnectHandler(browser, shutdownOnce, log) {
  browser.on('disconnected', () => {
    // 用户关闭窗口后不在daemon内部重开；当前请求失败，下一次独立调用由CLI启动新生命周期。
    shutdownOnce('Browser disconnected; shutting down daemon.', { closeBrowser: false }).catch(err => {
      log(`Shutdown error after browser disconnect: ${err.message}`);
      process.exit(1);
    });
  });
}

async function convergeBootstrapPage(page, timeoutMs = SESSION_PAGE_READY_TIMEOUT_MS, reloadBudget = { remaining: 1 }) {
  const observe = () => withTimeout(
    CHATGPT_DOM.sessionPageFact(page, { waitForTerminal: true, timeoutMs }),
    timeoutMs + 1_000,
    'ChatGPT session page convergence',
  );
  const first = await observe();
  if (first.kind === 'authenticated' || first.kind === 'logged-out') return first;
  if (reloadBudget.remaining <= 0) {
    throw Object.assign(new Error(`ChatGPT session page did not converge: ${first.kind}`), { code: 'SESSION_PAGE_DID_NOT_CONVERGE' });
  }
  // 只有持续nonterminal才消费一次startup恢复；正常hydrate和登录页都不刷新。
  reloadBudget.remaining--;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const second = await observe();
  if (second.kind === 'authenticated' || second.kind === 'logged-out') return second;
  // 第二次仍混合时停止启动，避免页面反复跳转并在错误状态写daemon ready。
  throw Object.assign(new Error(`ChatGPT session page did not converge after one reload: ${second.kind}`), { code: 'SESSION_PAGE_DID_NOT_CONVERGE' });
}

async function acquireBootstrapBrowser(log) {
  for (let coldRecovery = 0; coldRecovery < 2; coldRecovery++) {
    log(`Acquiring browser lifecycle${coldRecovery ? ' after cold recovery' : ''}.`);
    const acquired = await launchBrowser(log);
    try {
      log(`Browser acquired as ${acquired.ownedByDaemon ? 'owned' : 'shared'}; preparing bootstrap page.`);
      const bootstrapPage = await withTimeout(prepareBootstrapPage(acquired.browser, !acquired.ownedByDaemon), SESSION_PAGE_READY_TIMEOUT_MS, 'Browser bootstrap page preparation timed out');
      // cold spawn的blank在CDP ready后才进入网页bootstrap，避免直接URL启动的订阅首屏竞态。
      if (!isOfficialChatGPTURL(bootstrapPage.url())) await bootstrapPage.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      log('Bootstrap page reached ChatGPT; checking session state.');
      const startupReload = { remaining: 1 };
      const initialFact = await convergeBootstrapPage(bootstrapPage, SESSION_PAGE_READY_TIMEOUT_MS, startupReload);
      return { ...acquired, bootstrapPage, startupReload, initialFact };
    } catch (error) {
      const canRecoverCold = error.code === 'SESSION_PAGE_DID_NOT_CONVERGE' && acquired.ownedByDaemon && coldRecovery === 0;
      // helper仍持有完整provenance；任意pre-ready失败都必须在这里收敛，不能等外层拿到成功结果后补偿。
      if (!acquired.ownedByDaemon) acquired.browser.disconnect();
      else {
        const closed = await closeOwnedBrowser(acquired.browser);
        // close未证明PID/profile释放时保留marker供后继daemon恢复；同进程cold会重新争用仍锁定profile。
        if (!closed) throw error;
        if (acquired.owner) deleteBrowserOwner(acquired.owner);
      }
      // 同一owner内只允许持续不收敛触发一次cold；其它错误关闭资源后仍原样失败。
      if (!canRecoverCold) throw error;
      log('Owned browser bootstrap did not converge; starting one cold recovery lifecycle.');
    }
  }
}

/**
 * 启动长期运行的 daemon 进程。
 *
 * 启动阶段只确认browser与登录态，default Project由需要新会话的ask延迟初始化；voice不能被ask身份阻断。
 * HTTP 层只暴露 /status、/stop、/ask 和 TUI 私有 /voice/transcribe-file，业务错误统一回 JSON，
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

  let browser, bootstrapPage, browserOwner;
  let ownedByDaemon = false;
  try {
    const acquired = await acquireBootstrapBrowser(log);
    browser = acquired.browser;
    browserOwner = acquired.owner;
    ownedByDaemon = acquired.ownedByDaemon;
    bootstrapPage = acquired.bootstrapPage;
    const initialFact = acquired.initialFact;
    const startupReload = acquired.startupReload;
    if (initialFact.kind === 'logged-out') {
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
          log('Startup error [LOGIN_REQUIRED]: Browser closed during login wait. Run: node chatgpt.js --login');
          return flushAndExit(1);
        }
        try {
          // 明确logged-out只等待；OAuth完成后若落入持续混合页，才允许消费尚未使用的一次reload。
          const fact = await convergeBootstrapPage(bootstrapPage, Math.min(SESSION_PAGE_READY_TIMEOUT_MS, Math.max(1, loginDeadline - Date.now())), startupReload);
          if (fact.kind === 'authenticated') {
            // 二次确认：OAuth 重定向中途可能短暂出现非登录页 URL，单次检测可能误判。
            await sleep(2_000);
            const confirmed = browser.isConnected()
              ? await CHATGPT_DOM.sessionPageFact(bootstrapPage, { waitForTerminal: false, timeoutMs: 0 })
              : null;
            if (confirmed?.kind === 'authenticated') {
              loginConfirmed = true;
              break;
            }
          }
        } catch (error) {
          // 页面导航中 evaluate 失败是正常的（OAuth 重定向会销毁 execution context）；
          // 只有 browser 真正断开才退出，其余异常继续等待下一轮检测。
          if (!browser.isConnected()) {
            log('Startup error [LOGIN_REQUIRED]: Browser closed during login wait. Run: node chatgpt.js --login');
            return flushAndExit(1);
          }
          // 有界恢复已经证明页面持续不一致；继续循环只会违反一次reload不变量。
          if (error.code === 'SESSION_PAGE_DID_NOT_CONVERGE') throw error;
        }
      }
      if (!loginConfirmed) {
        log('Startup error [LOGIN_REQUIRED]: Login wait timed out after ' + LOGIN_WAIT_TIMEOUT_MS + 'ms. Log in to chatgpt.com in the browser window, or run: node chatgpt.js --login');
        if (!ownedByDaemon) browser.disconnect();
        else {
          const closed = await closeOwnedBrowser(browser);
          if (closed && browserOwner) deleteBrowserOwner(browserOwner);
        }
        return flushAndExit(1);
      }
      log('Login detected; continuing startup.');
    }

    log('Browser ready and logged in.');
  } catch (err) {
    log(`Startup error [${err.code === 'BROWSER_CONFIG' ? 'BROWSER_CONFIG' : 'BROWSER_STARTUP'}]: ${err.message}`);
    if (browser) {
      if (!ownedByDaemon) browser.disconnect();
      else {
        const closed = await closeOwnedBrowser(browser);
        if (closed && browserOwner) deleteBrowserOwner(browserOwner);
      }
    }
    // 外层 catch 同样需要刷盘后退出，否则启动期异常的日志可能丢失。
    return flushAndExit(1);
  }

  const runtime = createDaemonRuntime({ browser, bootstrapPage });
  const daemonToken = crypto.randomBytes(18).toString('hex');
  const daemonID = crypto.randomBytes(12).toString('hex');
  let server;
  let shuttingDown = false;

  // 只有独占 launch profile 才能把未登记 tab 判为游离页；共享 CDP 下未登记恰恰代表用户所有。
  const STALE_PAGE_CLEANUP_INTERVAL_MS = 60_000;
  const stalePageTimer = !ownedByDaemon ? null : setInterval(async () => {
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
    if (stalePageTimer) clearInterval(stalePageTimer);
    // browser disconnected 回调里不再 close browser：连接已断开，重复 close 只会制造无意义的协议错误。
    if (options.closeBrowser !== false) {
      // 关闭语义消费本次acquisition provenance，不能按配置URL猜测debug-port browser归属。
      if (!ownedByDaemon) browser.disconnect();
      else {
        const closed = await closeOwnedBrowser(browser);
        if (closed && browserOwner) deleteBrowserOwner(browserOwner);
      }
    }
    process.exit(options.exitCode ?? 0);
  };
  runtime.onFatal = error => { if (error.code === 'VOICE_RUNTIME_FATAL') setImmediate(() => shutdownOnce(error.message, { closeBrowser: true, exitCode: 1 })); }; // 后台迟到失败也走同一幂等退出边界。

  installBrowserDisconnectHandler(browser, shutdownOnce, log);

  server = http.createServer(async (req, res) => {
    // send 必须在 res 已关闭时静默返回:voice cancel 后客户端断开,catch 调 send(500)
    // 会在已关闭的 res 上 writeHead 抛异常,导致 daemon 崩溃且 voiceLock 永不释放。
    const send = (status, obj) => sendJSON(res, status, obj);

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
        project: runtime.project?.name || null,
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
        const parsed = await readDaemonJsonBody(req, '/voice/transcribe-file', log);
        const result = await runVoiceRequest(runtime, parsed, log, () => voiceClientClosed);
        send(200, result);
      } catch (err) {
        log(`Error: ${err.message}`);
        // 503表示本地browser生命周期失效；CLI淘汰索引但当前录音不得自动重发。
        send(err.code === 'BROWSER_DISCONNECTED' ? 503 : /body|file|WAV|regular|large|exist/i.test(err.message) ? 400 : 500, { ok: false, ...(err.code ? { code: err.code } : {}), error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/auth/export') {
      // 无请求体：导出只读取当前登录会话，不接受任何调用方提供的路径或凭据。
      try {
        const result = await runAuthExport(runtime);
        send(200, result);
      } catch (err) {
        log(`Error: ${err.message}`);
        // 400 登录介入不进 CLI 重试集合；browser 生命周期错误走 503 让 CLI 淘汰 stale daemon。
        send(err.code === 'AUTH_EXPORT_LOGIN_REQUIRED' ? 400 : err.code === 'BROWSER_DISCONNECTED' ? 503 : 500, { ok: false, ...(err.code ? { code: err.code } : {}), error: err.message });
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
              const stored = readSessionIndex().sessions[sessionID];
              const sessionProject = projectForSessionEntry(stored, runtime.project);
              const entry = readSessionEntry(sessionID, sessionProject);
              const saved = result.savedResponse || (result.response ? saveResponseToFile(result.response, parsed.workspaceDir, sessionID) : null);
              if (entry?.url) markSessionPending(sessionID, sessionProject, entry.url, saved, {
                preserveCompleted: true,
                completedUndelivered: true,
                nativeImageURLs: entry.completed?.nativeImageURLs || [],
              });
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

// 正常运行只暴露 daemon 入口；离线测试显式 opt-in 后才能访问无网络状态机 seam。
module.exports = process.env.CHATGPT_TEST_HOOKS === '1'
  ? { startDaemonProcess, testing: Object.freeze({ launchBrowser, acquireBootstrapBrowser, createDaemonRuntime, prepareBootstrapPage, convergeBootstrapPage, closeOwnedBrowser, installBrowserDisconnectHandler, browserOwnerMatches, writeBrowserOwner, deleteBrowserOwner, resolveProject, ensureProjectHome, restoreSessionPage, rememberCurrentSessionUrl, readSessionEntry, markSessionPending, markSessionCompleted, markSessionLost, validateAskInput, validateVoiceInput, sendJSON, assistantTextAdvanced, runAsk, runVoiceRequest, runAuthExport, requestHash, dom: CHATGPT_DOM }) }
  : { startDaemonProcess };

if (require.main === module) {
  startDaemonProcess().catch(err => {
    console.error('[ERROR]', err.message);
    process.exit(1);
  });
}
