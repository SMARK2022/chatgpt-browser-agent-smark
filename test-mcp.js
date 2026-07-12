#!/usr/bin/env node
'use strict';

/**
 * test-mcp.js — MCP 协议烟测 + 真实 daemon 端到端测试
 *
 * 测试分两层：
 *   1. wrapper 协议层（runServer）：JSON-RPC、schema 校验、超限恢复——不依赖浏览器。
 *   2. 真实 E2E 层（runChatgptCLI + 真实 daemon）：ask、文件上传、voice、并发、session 续聊。
 * E2E 只在命令行显式点名 testE2E* 时运行；默认 npm test 仅启动隔离的本地 headless fixture，绝不连接 ChatGPT 或发送 prompt。
 * 每个测试最多 60 秒；全部测试最多 3 分钟。
 */

const assert = require('assert');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const BASE_ENV = {
  ...process.env,
  CHATGPT_PROJECT: 'MCP',
  CHATGPT_WORKSPACE_ROOTS: process.cwd(),
  CHATGPT_WORKSPACE_DIR: process.cwd(),
  CHATGPT_ASK_HTTP_TIMEOUT_MS: '5000',
  CHATGPT_CLI_TIMEOUT_MS: '6000',
  // 测试不连接真实浏览器；显式禁用 CDP 端口，与生产默认值 0 保持一致。
  CHATGPT_BROWSER_DEBUG_PORT: '0',
};

// E2E 测试使用真实 daemon 的环境（不覆盖 STATE_DIR，复用用户登录态）。
const E2E_ENV = {
  ...process.env,
  CHATGPT_PROJECT: 'MCP',
  CHATGPT_WORKSPACE_ROOTS: process.cwd(),
  CHATGPT_WORKSPACE_DIR: process.cwd(),
  // E2E ask 超时给 55s，留 5s margin 给 CLI 启动和 daemon 通信。
  CHATGPT_ASK_HTTP_TIMEOUT_MS: '55000',
  CHATGPT_CLI_TIMEOUT_MS: '58000',
};

let e2eAvailable = null; // null=未检测, true=可用, false=不可用
let e2eSessionID = null; // E2E 测试间共享的 sessionID，避免每次都新建会话（新建需要 ~15s 导航开销）

async function main() {
  const PER_TEST_TIMEOUT = 60_000;
  const suiteStartedAt = Date.now();
  const suiteDeadline = Date.now() + 180_000;
  // 支持按名称运行单个测试：node test-mcp.js testE2EAskWithFileUpload
  const filter = process.argv.slice(2);
  const allTests = [
    ['testBasicProtocol', () => testBasicProtocol(), false],
    ['testLegacyTimeoutEnv', () => testLegacyTimeoutEnv(), false],
    ['testArgumentValidation', () => testArgumentValidation(), false],
    ['testVoiceTranscribeIsPrivate', () => testVoiceTranscribeIsPrivate(), false],
    ['testTranscribeFileCliValidation', () => testTranscribeFileCliValidation(), false],
    // macOS /var→/private/var 符号链接导致 pathInside 误判，验证 realpath 修复正确性。
    ['testVoiceFileSymlinkedDirAccepted', () => testVoiceFileSymlinkedDirAccepted(), false],
    ['testDirectVoiceTranscribeSkipsComposerWait', () => testDirectVoiceTranscribeSkipsComposerWait(), false],
    ['testOversizedLineRecovery', () => testOversizedLineRecovery(), false],
    ['testExistingSessionIndexStartup', () => testExistingSessionIndexStartup(), false],
    ['testStatusReportsDisconnectedBrowser', () => testStatusReportsDisconnectedBrowser(), false],
    ['testVoiceSkipsStaleBrowserDaemon', () => testVoiceSkipsStaleBrowserDaemon(), false],
    ['testAskSkipsStaleBrowserDaemon', () => testAskSkipsStaleBrowserDaemon(), false],
    ['testLoginRequiredMarkerNotTreatedAsStartupError', () => testLoginRequiredMarkerNotTreatedAsStartupError(), false],
    ['testLoginWaitTimeoutErrorDetected', () => testLoginWaitTimeoutErrorDetected(), false],
    ['testSessionIDValidationRejection', () => testSessionIDValidationRejection(), false],
    ['testFileUploadRejectsOutsideAllowlist', () => testFileUploadRejectsOutsideAllowlist(), false],
    ['testFileUploadRejectsDuplicateBasenames', () => testFileUploadRejectsDuplicateBasenames(), false],
    ['testStopWithoutActiveAsk', () => testStopWithoutActiveAsk(), false],
    ['testProjectIdentityPolicy', () => testProjectIdentityPolicy(), false],
    ['testCoreProjectStateMachine', () => testCoreProjectStateMachine(), false],
    ['testProjectDiscoveryRejectsVisibleDuplicates', () => testProjectDiscoveryRejectsVisibleDuplicates(), false],
    ['testProjectHomeDiscoveryUsesLiveSidebar', () => testProjectHomeDiscoveryUsesLiveSidebar(), false],
    ['testSubmitUsesTrustedClick', () => testSubmitUsesTrustedClick(), false],
    ['testFileUploadUsesStableLocalCopy', () => testFileUploadUsesStableLocalCopy(), false],
    ['testImageModeUsesCurrentComposerMenu', () => testImageModeUsesCurrentComposerMenu(), false],
    ['testTableCitationExtraction', () => testTableCitationExtraction(), false],
    ['testSandboxArtifactPreviewDownload', () => testSandboxArtifactPreviewDownload(), false],
    ['testVoicePageHealthCheck', () => testVoicePageHealthCheck(), false],
    // 验证 voice cancel 后 send 不在已关闭 res 上崩溃,daemon 仍存活
    ['testVoiceCancelSendSafeOnClosedRes', () => testVoiceCancelSendSafeOnClosedRes(), false],
    // 验证 shouldCancel=true 时 transcribeAudioFile 不进入 fallback 听写 UI,直接抛出取消错误
    ['testTranscribeShouldCancelBeforeFallback', () => testTranscribeShouldCancelBeforeFallback(), false],
    // 验证 onFallbackStart 回调在 direct path 失败后、fallback 开始前被调用
    ['testTranscribeOnFallbackStartCalled', () => testTranscribeOnFallbackStartCalled(), false],
    ['testEmptyAssistantTurnCompletes', () => testEmptyAssistantTurnCompletes(), false],
    ['testForegroundPulseInterval8s', () => testForegroundPulseInterval8s(), false],
    ['checkE2EAvailability', () => checkE2EAvailability(), true],
    ['testE2EStatus', () => testE2EStatus(), true],
    ['testE2EAskBasic', () => testE2EAskBasic(), true],
    ['testE2EAskWithSession', () => testE2EAskWithSession(), true],
    ['testE2EAskWithFileUpload', () => testE2EAskWithFileUpload(), true],
    ['testE2ESandboxArtifactDownload', () => testE2ESandboxArtifactDownload(), true],
    ['testE2EAskWithSaveToFile', () => testE2EAskWithSaveToFile(), true],
    ['testE2EConcurrentAsks', () => testE2EConcurrentAsks(), true],
    ['testE2EVoiceTranscribe', () => testE2EVoiceTranscribe(), true],
  ];
  // 有 filter 时只跑指定测试；E2E 测试需要先检测 daemon 可用性。
  // 无 filter 的标准测试只跑离线层；真实 E2E 必须显式点名，避免 CI/npm test 消耗账号配额或污染 Project。
  const selected = filter.length > 0 ? allTests.filter(t => filter.includes(t[0])) : allTests.filter(t => !t[2]);
  // 如果选了 E2E 测试但没选 checkE2EAvailability，自动先跑它。
  const needsE2ECheck = selected.some(t => t[2]) && !selected.some(t => t[0] === 'checkE2EAvailability');
  if (needsE2ECheck) await withTestTimeout('checkE2EAvailability', checkE2EAvailability, PER_TEST_TIMEOUT);
  for (const [name, fn] of selected) {
    // 单测试预算不能越过全套 deadline；即使多个慢用例连续出现，总进程也会在三分钟内失败退出。
    await withTestTimeout(name, fn, Math.min(PER_TEST_TIMEOUT, Math.max(1, suiteDeadline - Date.now())));
  }
  console.log(`  SUITE: ${selected.length} test(s) in ${Date.now() - suiteStartedAt}ms`);
}

// 检测真实 daemon 是否可用；不可用时尝试启动（ask 会触发 ensureDaemon）。
// 启动失败（如未登录）则所有 E2E 测试自动跳过，不失败。
async function checkE2EAvailability() {
  // 先试 --status（只读，不启动 daemon）。
  const status = await runChatgptCLI(['--status'], E2E_ENV, 10_000);
  if (status.status === 0 && /Daemon running/.test(status.stdout)) {
    e2eAvailable = true;
    console.log('  E2E daemon detected: ' + status.stdout.split('\n')[0]);
    return;
  }
  // daemon 未运行；用一次简单 ask 触发 ensureDaemon 启动浏览器。
  // 如果登录态有效，daemon 会启动并回答；否则会进入登录等待或超时。
  console.log('  Starting daemon for E2E tests...');
  const probe = await runChatgptCLI(['--raw', '请回复：E2E就绪'], E2E_ENV, 59_000);
  if (probe.status === 0 && /Session:/.test(probe.stdout)) {
    e2eAvailable = true;
    console.log('  E2E daemon started successfully');
    return;
  }
  e2eAvailable = false;
  console.log('  SKIP: E2E tests (daemon could not start or not logged in)');
  console.log('  Detail: ' + (probe.stderr || probe.stdout).slice(0, 200));
}

// E2E 测试统一入口：daemon 不可用时跳过而非失败。
async function e2e(fn) {
  if (e2eAvailable === false) throw new SkipError('daemon not available');
  if (e2eAvailable === null) await checkE2EAvailability();
  if (e2eAvailable === false) throw new SkipError('daemon not available');
  await fn();
}

class SkipError extends Error {
  constructor(reason) { super(`SKIP: ${reason}`); this.name = 'SkipError'; }
}

// 单测试超时保护：超时后打印失败信息并退出，不让整个测试进程卡死。
async function withTestTimeout(name, fn, ms) {
  let timer;
  const startedAt = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms); }),
    ]);
    // 每项显示真实耗时，便于区分“快速失败/成功”和“卡到外层 deadline 才返回”。
    console.log(`  PASS: ${name} (${Date.now() - startedAt}ms)`);
  } catch (err) {
    if (err instanceof SkipError) {
      console.log(`  ${err.message} (${Date.now() - startedAt}ms)`);
      return;
    }
    console.error(`FAIL: ${name}: ${err.message}`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

async function testLoginRequiredMarkerNotTreatedAsStartupError() {
  // 当 daemon 日志包含 "Login required;" 但不包含 "Startup error:" 时，
  // CLI 必须继续轮询等待而不是立即报启动失败。这验证 "Login required;" 标记
  // 和 "Startup error:" 标记是两个独立的检测路径，不会互相误判。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-login-wait-'));
  try {
    // 用 stub daemon 脚本模拟"检测到未登录、写 Login required 标记后保持存活"的行为。
    const stubScript = path.join(dir, 'stub-daemon.js');
    fs.writeFileSync(stubScript, [
      "const fs = require('fs');",
      "const path = require('path');",
      "const log = path.join(process.env.CHATGPT_STATE_DIR, 'daemon.log');",
      "fs.appendFileSync(log, '[' + new Date().toISOString() + '] Daemon starting...\\n');",
      "fs.appendFileSync(log, '[' + new Date().toISOString() + '] Login required; waiting for manual login in browser window...\\n');",
      // stub 存活到 CLI 超时退出，让测试验证 "Login required" 不被当作 Startup error。
      "setTimeout(() => process.exit(1), 5000);",
    ].join('\n'));
    const result = await runChatgptCLI(['--raw', 'test prompt'], {
      CHATGPT_STATE_DIR: dir,
      CHATGPT_SESSION_DIR: path.join(dir, 'sessions'),
      CHATGPT_WORKSPACE_DIR: process.cwd(),
      CHATGPT_WORKSPACE_ROOTS: process.cwd(),
      // 让 ensureDaemon 用 stub 脚本代替真实 daemon 子进程。
      CHATGPT_DAEMON_INTERNAL_SCRIPT: stubScript,
      CHATGPT_DAEMON_START_TIMEOUT_MS: '3000',
    }, 10000);
    assert.notStrictEqual(result.status, 0);
    // 关键断言：CLI 不能把 "Login required;" 当作 "Startup error" 报告；
    // 应该是 "Daemon did not start"（轮询超时），而不是 "Daemon startup failed"。
    assert.ok(!/Daemon startup failed/i.test(result.stderr),
      `"Login required;" must not be treated as Startup error; got: ${result.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testLoginWaitTimeoutErrorDetected() {
  // 登录等待超时后 daemon 写 "Startup error: Login wait timed out"；
  // CLI 必须秒级检测到这个 Startup error 并把超时原因返回给调用方。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-login-timeout-'));
  try {
    // stub daemon 模拟完整登录等待超时流程：先写 Login required，再写 Startup error 并退出。
    const stubScript = path.join(dir, 'stub-daemon.js');
    fs.writeFileSync(stubScript, [
      "const fs = require('fs');",
      "const path = require('path');",
      "const log = path.join(process.env.CHATGPT_STATE_DIR, 'daemon.log');",
      "fs.appendFileSync(log, '[' + new Date().toISOString() + '] Daemon starting...\\n');",
      "fs.appendFileSync(log, '[' + new Date().toISOString() + '] Login required; waiting for manual login in browser window...\\n');",
      "fs.appendFileSync(log, '[' + new Date().toISOString() + '] Startup error: Login wait timed out after 120000ms. Log in to chatgpt.com in the browser window, or run: node chatgpt.js --login\\n');",
      "process.exit(1);",
    ].join('\n'));
    const result = await runChatgptCLI(['--raw', 'test prompt'], {
      CHATGPT_STATE_DIR: dir,
      CHATGPT_SESSION_DIR: path.join(dir, 'sessions'),
      CHATGPT_WORKSPACE_DIR: process.cwd(),
      CHATGPT_WORKSPACE_ROOTS: process.cwd(),
      CHATGPT_DAEMON_INTERNAL_SCRIPT: stubScript,
      CHATGPT_DAEMON_START_TIMEOUT_MS: '5000',
    }, 10000);
    assert.notStrictEqual(result.status, 0);
    // 超时错误必须被 CLI 检测到并包含在输出中，而不是等满 DAEMON_START_TIMEOUT。
    assert.match(result.stderr, /Login wait timed out/i);
    // 错误信息必须包含 --login 建议让用户知道如何恢复。
    assert.match(result.stderr, /--login/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 真实 daemon 端到端测试 ──────────────────────────────────────────────────────
// 以下测试使用真实 daemon（不覆盖 STATE_DIR），需要浏览器已登录 ChatGPT。
// daemon 不可用时通过 e2e() 包装自动跳过。

async function testE2EStatus() {
  await e2e(async () => {
    const result = await runChatgptCLI(['--status'], E2E_ENV, 10_000);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Daemon running/i);
    assert.match(result.stdout, /Browser: connected/i);
  });
}

async function testE2EAskBasic() {
  // 基本 ask：发送简单数学题，验证 ChatGPT 返回正确答案（不是机械复述）。
  // 同时把返回的 sessionID 存入 e2eSessionID 供后续续聊测试复用，避免新建会话的 ~15s 导航开销。
  await e2e(async () => {
    const result = await runChatgptCLI(['--raw', '37+58等于多少？只返回数字。'], E2E_ENV, 59_000);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /\b95\b/);
    const match = result.stdout.match(/Session: (#[a-f0-9]{10})/);
    assert.ok(match, 'ask must return sessionID');
    e2eSessionID = match[1];
    assert.match(result.stdout, /Session: #[a-f0-9]{10}/);

    // Project 名写进 registry 不代表远端真的归属该 Project；必须检查 ChatGPT 返回的实际 URL。
    // 顶层 /c/... 会把 MCP 调用堆到项目外，只有 /g/{project}/c/... 才能证明从项目首页创建。
    // registry 在真实 daemon 完成落盘后读取，避免仅凭 CLI 的 Project 文案形成循环论证。
    // 断言比较 pathname 与 projectID，不依赖当前账号的具体 slug，因此可跨设备复用。
    const sessionDir = process.env.CHATGPT_SESSION_DIR || (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'opencode', 'chatgpt-browser-agent')
      : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'chatgpt-browser-agent'));
    const entry = JSON.parse(fs.readFileSync(path.join(sessionDir, 'sessions.json'), 'utf8')).sessions[e2eSessionID];
    assert.ok(entry?.projectID, 'new session registry entry must include the fixed Project id');
    assert.match(new URL(entry.projectURL).pathname, new RegExp(`^/g/${entry.projectID}(?:-[^/]+)?/project$`), 'new session must start from the fixed Project home');
    assert.match(new URL(entry.url).pathname, new RegExp(`^/g/${entry.projectID}(?:-[^/]+)?/c/`), 'new conversation must be created inside the fixed Project');
  });
}

async function testE2EAskWithSession() {
  // session 续聊验证：复用 testE2EAskBasic 创建的会话（37+58=95），在同一会话中追问。
  // 只有真正续聊同一会话，ChatGPT 才能知道上一轮答案是 95 并计算出 105——这验证了 session 连续性。
  // 不使用"记住"等词避免触发 ChatGPT Memory 功能；不涉及敏感表述。
  // 复用已有 sessionID 只需一次 CLI 调用，避免新建会话的导航开销。
  await e2e(async () => {
    assert.ok(e2eSessionID, 'session test requires e2eSessionID from testE2EAskBasic');
    const second = await runChatgptCLI(['--raw', '--session-id', e2eSessionID, '把你上一个回答的数字加上10，等于多少？只返回数字。'], E2E_ENV, 59_000);
    assert.strictEqual(second.status, 0, second.stderr);
    // 必须返回 105（95+10），证明 ChatGPT 能看到上一轮对话上下文。
    assert.match(second.stdout, /\b105\b/);
    assert.match(second.stdout, new RegExp(e2eSessionID));
  });
}

async function testE2EAskWithFileUpload() {
  // 文件上传：在 upload cache 中创建含唯一标记的文件，上传后让 ChatGPT 读出标记。
  // 只有真正读取了文件内容才能返回唯一标记——这验证了文件上传的完整性。
  // 复用 e2eSessionID 避免新建会话的 ~10s 导航开销，让文件上传在 40s 测试超时内完成。
  const uploadEnv = { ...E2E_ENV, CHATGPT_ASK_HTTP_TIMEOUT_MS: '55000', CHATGPT_CLI_TIMEOUT_MS: '58000' };
  await e2e(async () => {
    assert.ok(e2eSessionID, 'file upload test requires e2eSessionID from testE2EAskBasic');
    const uploadDir = path.join(process.cwd(), '.opencode', 'cache', 'chatgpt', 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const marker = 'ZEBRA-' + Date.now().toString(36).toUpperCase().slice(-5);
    const uploadFile = path.join(uploadDir, `e2e-upload-${marker}.txt`);
    // 文件内容加入随机填充，避免 ChatGPT 对相似内容做"已上传过此文件"去重。
    const padding = crypto.randomBytes(64).toString('hex');
    fs.writeFileSync(uploadFile, `这是一份测试文件。标记码：${marker}\n随机填充：${padding}\n`);
    try {
      const result = await runChatgptCLI(['--raw', '--session-id', e2eSessionID, '--upload', uploadFile, '文件中的标记是什么？只返回标记。'], uploadEnv, 59_000);
      assert.strictEqual(result.status, 0, result.stderr);
      // ChatGPT 必须返回文件中的唯一标记，证明文件被真正上传并读取。
      assert.match(result.stdout, new RegExp(marker), `response must contain the unique marker ${marker} from uploaded file`);
      assert.match(result.stdout, /Session: #[a-f0-9]{10}/);
    } finally {
      try { fs.unlinkSync(uploadFile); } catch {}
    }
  });
}

async function testE2ESandboxArtifactDownload() {
  // 产物测试读取真实落盘文件并核对随机标记，避免把“模型说已生成”或按钮存在误当成下载成功。
  // 复用 basic ask 的会话只减少新建导航，不依赖其回答内容；随机 marker 仍证明本轮 sandbox 真正执行。
  // 解析限定在 Downloaded files 段，防止回答正文里的 Windows/POSIX 路径被误当成本地产物。
  // 路径正则不写盘符假设，同一断言可验证 Windows、macOS 与 Linux 的 wrapper 输出。
  // finally 删除本轮文件，但不删除共享 session/cache 目录，避免测试清理越过自身所有权边界。
  await e2e(async () => {
    assert.ok(e2eSessionID, 'artifact test requires e2eSessionID from testE2EAskBasic');
    const marker = 'ARTIFACT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const result = await runChatgptCLI([
      '--raw',
      '--session-id', e2eSessionID,
      `请使用 Python sandbox 创建 UTF-8 文本文件 e2e-${marker}.txt，文件内容必须包含且仅包含 ${marker}，并把该文件作为可下载附件提供。回复尽量简短。`,
    ], E2E_ENV, 59_000);
    assert.strictEqual(result.status, 0, result.stderr);
    const section = result.stdout.split(/Downloaded files:\s*/i)[1]?.split(/\r?\n\r?\n/)[0] || '';
    const line = section.split(/\r?\n/).find(item => /^- .+?: .+/.test(item));
    assert.ok(line, `artifact response must expose a downloaded file path; got: ${result.stdout.slice(0, 500)}`);
    const file = line.replace(/^- .*?: /, '');
    try {
      assert.ok(fs.existsSync(file), `downloaded artifact must exist: ${file}`);
      assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), marker);
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  });
}

async function testE2EAskWithSaveToFile() {
  // saveToFile：验证回答被保存到磁盘文件，且文件内容包含 ChatGPT 的回答。
  await e2e(async () => {
    const result = await runChatgptCLI(['--raw', '--save-to-file', '请回复：保存验证通过'], E2E_ENV, 59_000);
    assert.strictEqual(result.status, 0, result.stderr);
    // saveToFile 模式下输出应包含保存路径和元信息。
    assert.match(result.stdout, /Response saved to:/i);
    assert.match(result.stdout, /Lines: \d+/);
    assert.match(result.stdout, /Characters: \d+/);
    assert.match(result.stdout, /Session: #[a-f0-9]{10}/);
    // 提取保存路径，验证文件真实存在且包含回答内容。
    const savedPath = result.stdout.match(/Response saved to:\s*(.+)/)?.[1]?.trim();
    assert.ok(savedPath, 'must have saved response path');
    assert.ok(fs.existsSync(savedPath), 'saved response file must exist on disk');
    const savedContent = fs.readFileSync(savedPath, 'utf8');
    assert.match(savedContent, /保存验证通过/);
  });
}

async function testE2EConcurrentAsks() {
  // 并发 ask：同时发送两个不同数学题，验证各自返回正确答案且 sessionID 不同。
  // 这验证了 daemon 能并发处理多个会话，不会串台。
  await e2e(async () => {
    const [a, b] = await Promise.all([
      runChatgptCLI(['--raw', '12*12等于多少？只返回数字。'], E2E_ENV, 59_000),
      runChatgptCLI(['--raw', '99+1等于多少？只返回数字。'], E2E_ENV, 59_000),
    ]);
    assert.strictEqual(a.status, 0, 'concurrent ask A failed: ' + a.stderr);
    assert.strictEqual(b.status, 0, 'concurrent ask B failed: ' + b.stderr);
    // 两个 ask 各自返回正确答案，证明没有串台。
    assert.match(a.stdout, /\b144\b/);
    assert.match(b.stdout, /\b100\b/);
    // 两个 ask 应返回不同的 sessionID。
    const sessionA = a.stdout.match(/Session: (#[a-f0-9]{10})/)?.[1];
    const sessionB = b.stdout.match(/Session: (#[a-f0-9]{10})/)?.[1];
    assert.ok(sessionA && sessionB, 'both asks must return sessionID');
    assert.notStrictEqual(sessionA, sessionB, 'concurrent asks must have different sessionIDs');
  });
}

async function testE2EVoiceTranscribe() {
  // voice 转写：使用 TTS 生成的真实 "hello world" WAV 文件，验证 daemon 能转写出可识别的文本。
  // 空 WAV 无法产生可识别语音；这里用 System.Speech 合成的真实音频验证端到端转写能力。
  await e2e(async () => {
    // TTS 音频预生成在项目目录下；voice file 必须在 daemon 的 VOICE_FILE_ROOTS 内。
    // 默认 root 是 os.tmpdir()/opencode/voice/，把 TTS WAV 复制过去。
    const ttsWav = path.join(__dirname, 'test-voice-hello.wav');
    const hasRealAudio = fs.existsSync(ttsWav);
    const voiceRoot = path.join(os.tmpdir(), 'opencode', 'voice');
    fs.mkdirSync(voiceRoot, { recursive: true });
    const voiceFile = path.join(voiceRoot, `e2e-voice-${Date.now()}.wav`);
    if (hasRealAudio) {
      fs.copyFileSync(ttsWav, voiceFile);
    } else {
      writeTinyWav(voiceFile);
    }
    try {
      const result = await runChatgptCLI(['transcribe-file', '--file', voiceFile, '--json'], E2E_ENV, 59_000);
      if (hasRealAudio) {
        // 真实音频：daemon 应返回包含 "hello" 的转写文本。
        assert.strictEqual(result.status, 0, result.stderr);
        const parsed = JSON.parse(result.stdout.trim());
        assert.ok(parsed.text && parsed.text.trim(), 'voice transcription must return non-empty text');
        // TTS 说的是 "hello world"，转写结果应包含 "hello"（不区分大小写）。
        assert.match(parsed.text.toLowerCase(), /hello/i, 'transcription must contain "hello" from TTS audio');
      } else {
        // 空 WAV：daemon 可能返回空文本或错误；只验证请求被接收处理。
        if (result.status === 0) {
          const parsed = JSON.parse(result.stdout.trim());
          assert.ok('text' in parsed, 'voice result must have text field');
        } else {
          assert.match(result.stderr, /dictation|transcri|empty|voice/i);
        }
      }
    } finally {
      try { fs.unlinkSync(voiceFile); } catch {}
    }
  });
}

// ── wrapper 校验测试（不依赖浏览器）──

async function testFileUploadRejectsOutsideAllowlist() {
  // 文件不在 upload allowlist 内时，MCP wrapper 必须在启动 CLI 前就拒绝。
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-upload-outside-'));
  const allowed = path.join(workspace, 'allowed');
  // 显式根与项目默认 staging 根都必须真实存在，否则会先命中“配置根不存在”，无法证明文件越界。
  fs.mkdirSync(allowed);
  fs.mkdirSync(path.join(workspace, '.opencode', 'cache', 'chatgpt', 'uploads'), { recursive: true });
  const outsideFile = path.join(os.tmpdir(), `outside-allowlist-${crypto.randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(outsideFile, 'should be rejected');
  try {
    const responses = runServer([
      JSON.stringify({ jsonrpc: '2.0', id: 'upload-outside', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'test', file: outsideFile } } }),
    ], { CHATGPT_WORKSPACE_DIR: workspace, CHATGPT_WORKSPACE_ROOTS: workspace, CHATGPT_UPLOAD_ROOTS: allowed });
    const result = responses.find(item => item.id === 'upload-outside');
    assert.ok(result.result?.isError, 'file outside allowlist must return tool error');
    assert.match(result.result.content[0].text, /outside.*root|allowed.*root/i);
  } finally {
    try { fs.unlinkSync(outsideFile); } catch {}
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function testFileUploadRejectsDuplicateBasenames() {
  // ChatGPT composer 按文件名匹配 attachment；同名文件无法区分，必须在上传前拒绝。
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-upload-duplicates-'));
  const uploadDir = path.join(workspace, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  // wrapper 始终同时验证项目默认 staging 根，夹具应完整模拟一个可上传 workspace。
  fs.mkdirSync(path.join(workspace, '.opencode', 'cache', 'chatgpt', 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(uploadDir, 'sub'), { recursive: true });
  const fileA = path.join(uploadDir, 'dup-name.txt');
  const fileB = path.join(uploadDir, 'sub', 'dup-name.txt');
  fs.writeFileSync(fileA, 'A');
  fs.writeFileSync(fileB, 'B');
  try {
    const responses = runServer([
      JSON.stringify({ jsonrpc: '2.0', id: 'dup-basenames', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'test', file: [fileA, fileB] } } }),
    ], { CHATGPT_WORKSPACE_DIR: workspace, CHATGPT_WORKSPACE_ROOTS: workspace, CHATGPT_UPLOAD_ROOTS: uploadDir });
    const result = responses.find(item => item.id === 'dup-basenames');
    assert.ok(result.result?.isError, 'duplicate basenames must return tool error');
    assert.match(result.result.content[0].text, /basename|distinct/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function testSessionIDValidationRejection() {
  // sessionID 格式校验在 MCP wrapper 层完成，不需要启动 daemon 或 CLI。
  // 无效格式必须快速返回 tool error，不触发 CLI spawn。
  // 只测拒绝路径：有效 sessionID 会 spawn CLI 导致挂起，其 normalize 逻辑通过 ask 成功路径隐式覆盖。
  const responses = runServer([
    // 无效 sessionID 应该在 wrapper 层被拒绝，不 spawn CLI。
    JSON.stringify({ jsonrpc: '2.0', id: 'bad-session', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', sessionID: 'not-valid' } } }),
    // 非法字符 sessionID。
    JSON.stringify({ jsonrpc: '2.0', id: 'bad-chars', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', sessionID: '#gggggggggg' } } }),
    // 长度不对的 sessionID。
    JSON.stringify({ jsonrpc: '2.0', id: 'bad-length', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', sessionID: '#abc' } } }),
  ]);
  for (const id of ['bad-session', 'bad-chars', 'bad-length']) {
    const r = responses.find(item => item.id === id);
    assert.ok(r.result?.isError, `${id} must return tool error`);
    assert.match(r.result.content[0].text, /sessionID must be/i, `${id} must mention sessionID format`);
  }
}

async function testStopWithoutActiveAsk() {
  // stop 在没有活跃 ask 时不应被拒绝。
  // 直接用 CLI 测试 --stop，不通过 MCP wrapper（避免 spawnSync 超时）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-stop-test-'));
  try {
    const result = await runChatgptCLI(['--stop'], {
      CHATGPT_STATE_DIR: dir,
      CHATGPT_SESSION_DIR: path.join(dir, 'sessions'),
      CHATGPT_WORKSPACE_DIR: process.cwd(),
      CHATGPT_WORKSPACE_ROOTS: process.cwd(),
    }, 5000);
    // 没有 daemon 时 --stop 应该快速退出且 status=0。
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /No daemon running/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testProjectIdentityPolicy() {
  // 这组断言直接执行生产 Project policy，不复制 URL 解析算法。
  // 覆盖三个身份边界：slug 不是标题、ID 必须精确相等、历史会话保持自己的 Project 快照。
  // 同名测试刻意交换“名称查询”和“显式 ID 查询”，确保结果不依赖 discovery 的数组顺序。
  // query/hash 命中与前缀 ID 都是过去 includes() 会放行的反例，必须作为独立负断言保留。
  // policy seam 不触碰浏览器和 registry，所以该测试不会消耗 ChatGPT 会话或修改用户运行态。
  const projectPolicy = require('./chatgpt-project');
  const explicit = projectPolicy.parse('https://chatgpt.com/g/g-p-abc123-my-project/c/conversation');
  assert.strictEqual(explicit.titleName, null, 'a URL slug must not be treated as a verified Project title');
  assert.strictEqual(explicit.url, 'https://chatgpt.com/g/g-p-abc123-my-project/project');
  const discovered = projectPolicy.parse(explicit.url, 'My Project');
  assert.strictEqual(discovered.titleName, 'My Project');
  assert.strictEqual(projectPolicy.acceptsHome(discovered.url, discovered), true);
  assert.strictEqual(projectPolicy.acceptsHome('https://chatgpt.com/g/g-p-abc1234-my-project/project', discovered), false, 'prefix Project ids must not match');
  assert.strictEqual(projectPolicy.acceptsHome(`https://chatgpt.com/?next=${encodeURIComponent(discovered.url)}`, discovered), false, 'query text must not satisfy Project identity');
  assert.strictEqual(projectPolicy.acceptsHome('https://evil.example/g/g-p-abc123-my-project/project', discovered), false, 'Project home must remain on chatgpt.com');
  assert.strictEqual(projectPolicy.acceptsHome('https://chatgpt.com:444/g/g-p-abc123-my-project/project', discovered), false, 'a non-standard port is a different origin');
  assert.strictEqual(projectPolicy.acceptsHome('https://user@chatgpt.com/g/g-p-abc123-my-project/project', discovered), false, 'userinfo must not be accepted as the official origin');
  assert.strictEqual(projectPolicy.acceptsHome('http://chatgpt.com/g/g-p-abc123-my-project/project', discovered), false, 'HTTP must not be accepted');
  assert.strictEqual(projectPolicy.isOfficialURL('https://chatgpt.com.evil.example/'), false, 'voice/page reuse must reject hostname prefixes');
  assert.strictEqual(projectPolicy.parse('https://evil.example/g/g-p-abc123-my-project/project'), undefined, 'foreign origins must not produce a Project identity');
  assert.strictEqual(projectPolicy.acceptsHome('https://chatgpt.com/g/g-p-abc123-my-project/c/turn', discovered), false, 'a conversation is not a Project home');
  // plain /c 只保留给 registry 已确认归属的历史记录；默认策略必须继续拒绝新会话逃逸。
  assert.strictEqual(projectPolicy.acceptsConversation('https://chatgpt.com/c/legacy', discovered), false);
  assert.strictEqual(projectPolicy.acceptsConversation('https://chatgpt.com/c/legacy', discovered, { allowPlain: true }), true);
  assert.strictEqual(projectPolicy.acceptsConversation('https://evil.example/c/legacy', discovered, { allowPlain: true }), false, 'plain compatibility must not allow foreign origins');
  assert.strictEqual(projectPolicy.sameConversation('https://chatgpt.com/g/g-p-abc123-renamed/c/turn', 'https://chatgpt.com/g/g-p-abc123-my-project/c/turn', discovered), true, 'slug changes may preserve the same Project conversation');
  // 删除或无权限会话常重定向到首页/Project 首页；两种结果都必须在填充 composer 之前被拒绝。
  assert.strictEqual(projectPolicy.sameConversation('https://chatgpt.com/', 'https://chatgpt.com/g/g-p-abc123-my-project/c/turn', discovered), false, 'a root-page redirect must not resume a registered conversation');
  assert.strictEqual(projectPolicy.sameConversation(discovered.url, 'https://chatgpt.com/g/g-p-abc123-my-project/c/turn', discovered), false, 'a Project-home redirect must not become a new turn');
  assert.strictEqual(projectPolicy.sameConversation('https://chatgpt.com/c/other', 'https://chatgpt.com/c/legacy', discovered, { allowPlain: true }), false, 'plain compatibility still requires the same conversation id');

  const replacement = projectPolicy.parse('g-p-def456-new-project', 'My Project');
  const stored = projectPolicy.forSession({ projectID: discovered.id, projectURL: discovered.url, project: discovered.name }, replacement);
  assert.strictEqual(stored.id, discovered.id, 'an existing session must preserve its stored Project snapshot');
  assert.throws(() => projectPolicy.select([discovered, replacement], 'My Project'), /Multiple ChatGPT projects are named/, 'duplicate names must never resolve by list order');
  assert.strictEqual(projectPolicy.select([discovered, replacement], replacement.id, replacement).id, replacement.id, 'an exact id must disambiguate duplicate names');
  const japanese = projectPolicy.parse('g-p-aaa111-japanese', 'プロジェクト');
  const russian = projectPolicy.parse('g-p-bbb222-russian', 'Проект');
  // 这些名称在旧 ASCII/CJK 白名单下都会变为空 key，正好覆盖静默选错 Project 的原始条件。
  assert.strictEqual(projectPolicy.select([japanese, russian], 'プロジェクト').id, japanese.id, 'Unicode project names must retain distinct keys');
  assert.strictEqual(projectPolicy.select([japanese], '한국어'), null, 'a different non-ASCII name must not collapse to an empty-key match');
}

function testCoreProjectStateMachine() {
  // 子进程先设置临时 state/session 根，再加载 core；测试直接调用生产 seam，但不会触碰用户 registry 或浏览器。
  // 同一个脚本覆盖恢复重定向、发送后 conversation 固定、Project 快照和两类队列失败释放。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-core-state-machine-'));
  try {
    const script = String.raw`
      const assert = require('assert');
      const fs = require('fs');
      const path = require('path');
      const policy = require('./chatgpt-project');
      const { testing } = require('./chatgpt-core');
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const project = policy.parse('g-p-abc123-mcp', 'MCP');
      const scoped = 'https://chatgpt.com/g/g-p-abc123-mcp/c/turn-a';
      // fakePage 只替代浏览器导航原语；URL 判定、等待和错误均由 core/project 生产代码执行。
      // redirected 参数模拟 page.goto 成功返回但最终地址被服务器或 SPA 改写的真实时序。
      const fakePage = (start, redirected) => {
        let current = start;
        return { url: () => current, goto: async target => { current = redirected || target; } };
      };

      (async () => {
        // restore 使用生产导航函数：根页重定向必须拒绝，原 conversation 必须保留。
        await assert.rejects(
          () => testing.restoreSessionPage(fakePage('about:blank', 'https://chatgpt.com/'), project, { url: scoped }, '#redirected', () => {}),
          /redirected away/,
        );
        const restored = fakePage('about:blank');
        // 正路径保留完整 registered URL，证明 redirect 防护没有误伤合法恢复。
        await testing.restoreSessionPage(restored, project, { url: scoped }, '#valid', () => {});
        assert.strictEqual(restored.url(), scoped);

        // 发送后若进入同 Project 的另一 conversation，应立即失败而不是等待满 URL 轮询预算。
        const switched = fakePage('https://chatgpt.com/g/g-p-abc123-mcp/c/turn-b');
        // turn-b 与 turn-a 属于同 Project 但不同 conversation；Project 相同绝不能成为续聊放宽条件。
        const startedAt = Date.now();
        assert.strictEqual(await testing.rememberCurrentSessionUrl(switched, project, '#fixed', () => {}, 5_000, false, scoped), null);
        assert.ok(Date.now() - startedAt < 1_000, 'a different conversation must fail without polling the full timeout');
        // 正确 URL 随后写 registry，证明快速拒绝分支不会污染后一次合法记录。
        assert.strictEqual(await testing.rememberCurrentSessionUrl(fakePage(scoped), project, '#fixed', () => {}, 5_000, false, scoped), scoped);
        // 三个 marker 调用真实 JSON registry 路径，覆盖 pending → completed 与 lost 的持久化语义。
        testing.markSessionPending('#fixed', project, scoped, null, { nativeImageURLs: ['https://chatgpt.com/image-old'], beforeState: { count: 1, userCount: 1, turnCount: 2 } });
        // pending 保留发送前图片基线，completed 则保留完成后的全集；两者语义不同不可共用空数组。
        assert.deepStrictEqual(testing.readSessionEntry('#fixed', project).pending.nativeImageURLs, ['https://chatgpt.com/image-old']);
        assert.deepStrictEqual(testing.readSessionEntry('#fixed', project).pending.beforeState, { count: 1, userCount: 1, turnCount: 2 });
        testing.markSessionCompleted('#fixed', project, scoped, 'request-hash', null, [], ['https://chatgpt.com/image-old']);
        assert.strictEqual(testing.readSessionEntry('#fixed', project).completed.requestHash, 'request-hash');
        assert.deepStrictEqual(testing.readSessionEntry('#fixed', project).completed.nativeImageURLs, ['https://chatgpt.com/image-old']);
        testing.markSessionLost('#lost', project, 'fixture may have sent');
        // lost 只保存防重发原因，不提供可猜测 URL；后续 runAsk 会把它当不可恢复墓碑。
        assert.match(testing.readSessionEntry('#lost', project).lost.reason, /fixture may have sent/);
        assert.strictEqual(testing.assistantTextAdvanced({ count: 2, lastText: 'OK' }, { count: 1, lastText: 'OK' }), true, 'an identical reply in a new assistant turn is still new text');
        assert.strictEqual(testing.assistantTextAdvanced({ count: 1, lastText: 'OK' }, { count: 1, lastText: 'OK' }), false, 'an unchanged old turn is not new text');

        // runtime 更新必须替换对象；旧引用代表已在途 ask，不能随新 Project 一起变化。
        const bootstrap = { isClosed: () => false };
        // browser stub 不创建真实 tab；本段只验证 runtime 自身的锁和 Project 引用模型。
        const runtime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => bootstrap }, bootstrapPage: bootstrap, project });
        const oldProject = runtime.project;
        runtime.updateProject(policy.parse('g-p-def456-mcp', 'MCP'));
        // 冻结旧对象也能揭示意外 Object.assign：若生产代码原地更新，oldProject.id 会随之变化。
        assert.strictEqual(oldProject.id, project.id, 'captured Project snapshots must remain immutable after runtime recovery');

        // 同一 session 的两个任务故意重叠启动，顺序断言直接证明 composer 锁串行。
        const order = [];
        await Promise.all([
          // 第二任务在第一任务 resolve 前入队，避免“顺序 await”形成没有意义的串行测试。
          runtime.withSession('#same', async () => { order.push('a:start'); await sleep(20); order.push('a:end'); }),
          runtime.withSession('#same', async () => { order.push('b'); }),
        ]);
        assert.deepStrictEqual(order, ['a:start', 'a:end', 'b']);

        // 不同 session 共享 daemon 但拥有不同 page，maxActive=2 固定其并发契约。
        let active = 0;
        let maxActive = 0;
        await Promise.all(['#one', '#two'].map(id => runtime.withSession(id, async () => {
          // active 计数测量真实重叠区间，而不是只比较回调开始顺序。
          active++;
          maxActive = Math.max(maxActive, active);
          await sleep(20);
          active--;
        })));
        assert.strictEqual(maxActive, 2, 'different sessions must remain concurrent');

        // 创建锁首任务抛错后第二任务仍 fulfilled，证明 rejection 不会毒化后继 promise。
        const createResults = await Promise.allSettled([
          // 两个创建任务同批入队；首个 rejection 后 release 必须位于 finally 才能放行第二个。
          runtime.withNewConversationLock(async () => { throw new Error('fixture failure'); }),
          runtime.withNewConversationLock(async () => 'released'),
        ]);
        assert.deepStrictEqual(createResults.map(result => result.status), ['rejected', 'fulfilled']);
        assert.strictEqual(createResults[1].value, 'released');

        // 连接用户已有 CDP 浏览器时必须新建 daemon 自有 bootstrap，已有 ChatGPT/其它 tab 均不能被关闭。
        const foreign = { url: () => 'https://example.com/', closeCalls: 0, async close() { this.closeCalls++; } };
        const existingChat = { url: () => 'https://chatgpt.com/c/existing', closeCalls: 0, async close() { this.closeCalls++; } };
        const dedicated = { url: () => 'about:blank', closeCalls: 0, async close() { this.closeCalls++; } };
        const sharedBrowser = { pages: async () => [foreign, existingChat], newPage: async () => dedicated };
        assert.strictEqual(await testing.prepareBootstrapPage(sharedBrowser, true), dedicated);
        assert.deepStrictEqual([foreign.closeCalls, existingChat.closeCalls], [0, 0], 'shared-browser startup must not close or adopt user tabs');

        // voice 与 ask 并发争抢同一个 bootstrap 时，page allocation 队列必须把它只交给一方。
        const voiceBootstrap = { url: () => 'https://chatgpt.com/', isClosed: () => false, evaluate: async () => 200 };
        const askCreated = { url: () => 'about:blank', isClosed: () => false };
        const ownershipRuntime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => askCreated }, bootstrapPage: voiceBootstrap, project });
        const [voiceOwned, askOwned] = await Promise.all([ownershipRuntime.voicePage(), ownershipRuntime.pageFor('#ownership')]);
        assert.notStrictEqual(voiceOwned, askOwned, 'voice and ask must never drive the same page');

        // 下面通过同一个生产 runAsk seam 组合验证 marker、DOM、URL 和 replay，而不是分别复制分支条件。
        const askPage = {
          current: scoped,
          isClosed: () => false,
          url() { return this.current; },
          async goto(target) { this.current = target; },
        };
        const askRuntime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => askPage }, bootstrapPage: askPage, project });
        const idle = { count: 1, userCount: 1, turnCount: 2, nativeImageCount: 0, nativeImageURLs: [], lastText: 'old', generating: false, placeholder: false, emptyAssistantTurn: false };
        let state = { ...idle };
        let submitCalls = 0;
        let extractCalls = 0;
        let artifactCalls = 0;
        let artifactBeforeState = null;
        let submitImpl = async (_page, _prompt, _files, _workspace, _mode, _ratio, _log, _cancel, beforeSend) => {
          submitCalls++;
          beforeSend();
          return { ...idle };
        };
        let waitImpl = async () => ({ status: 'completed', reason: 'fixture' });
        Object.assign(testing.dom, {
          // 所有替换都挂到 core 实际持有的 adapter 对象，runAsk 调用的仍是生产状态机而非测试副本。
          state: async () => ({ ...state, url: askPage.url() }),
          focus: async () => {},
          extractAssistant: async () => { extractCalls++; return state.lastText || ''; },
          collectArtifacts: async (_page, _dir, _log, _cancel, beforeState) => { artifactCalls++; artifactBeforeState = beforeState; return { downloads: [], notices: [] }; },
          projectHomeState: async () => ({ url: askPage.url(), composer: true, title: true, titleName: 'MCP', chatActive: true, workActive: false }),
          ensureChatMode: async () => {},
          submit: (...args) => submitImpl(...args),
          // waitImpl 可在“远端等待”边界切换 URL，专门覆盖等待期间的并发手动导航。
          waitForResponse: (...args) => waitImpl(...args),
        });
        const input = (prompt, newSession = false) => ({ fullPrompt: prompt, uploadPaths: [], workspaceDir: process.env.CHATGPT_SESSION_DIR, mode: 'auto', imageAspectRatio: null, saveToFile: false, newSession });
        // workspace 指向临时 session 根，snapshot/cache/registry 均由 finally 一次性删除。

        // fresh pending 必须只恢复；即使调用方带来新 prompt，生产 submit seam 也不能被触发。
        testing.markSessionPending('#pending', project, scoped, null, { beforeState: { count: 1, userCount: 1 } });
        askPage.current = scoped;
        state = { ...idle };
        const pending = await testing.runAsk(askRuntime, input('must not send'), '#pending', () => {});
        // promptSent:false 是外部可观察契约；submitCalls=0 则证明内部也没有尝试 composer 副作用。
        assert.strictEqual(pending.promptSent, false);
        assert.strictEqual(pending.status, 'generating', 'an unchanged historical assistant turn cannot complete a new pending prompt');
        assert.doesNotMatch(pending.response, /old/);
        assert.strictEqual(submitCalls, 0);
        state = { ...idle, count: 2, userCount: 2, lastText: 'recovered-new' };
        const recovered = await testing.runAsk(askRuntime, input('still recover only'), '#pending', () => {});
        assert.strictEqual(recovered.status, 'completed');
        assert.match(recovered.response, /recovered-new/);
        assert.strictEqual(submitCalls, 0);
        assert.strictEqual(artifactBeforeState.count, 1, 'completed recovery must preserve assistant baseline for sandbox ownership');

        // completed 同 hash 从本地 snapshot 回放，不读取 DOM、不提交，也不重复创建远端 turn。
        const replayDir = path.join(process.env.CHATGPT_SESSION_DIR, '.opencode', 'cache', 'chatgpt', 'responses', '#replay');
        fs.mkdirSync(replayDir, { recursive: true });
        const replayFile = path.join(replayDir, 'replay.md');
        fs.writeFileSync(replayFile, 'LOCAL-REPLAY');
        const replayHash = testing.requestHash('replay prompt', [], 'auto', null);
        // hash 直接调用生产函数，mode/ratio 指纹变化时测试会与 runAsk 同步，不复制摘要算法。
        testing.markSessionCompleted('#replay', project, scoped, replayHash, { path: replayFile, lines: 1, chars: 12 }, []);
        askPage.current = scoped;
        state = { ...idle };
        const replay = await testing.runAsk(askRuntime, input('replay prompt'), '#replay', () => {});
        // 本地内容必须原样返回；若 snapshot 路径校验或 completed TTL 回归，会落入远端 submit 并报红。
        assert.match(replay.response, /LOCAL-REPLAY/);
        assert.strictEqual(submitCalls, 0);

        // registry 指向 cache 根外时必须拒绝本地回放；无需制造同用户 syscall race。
        const outsideReplay = path.join(process.env.CHATGPT_SESSION_DIR, 'outside-secret.txt');
        fs.writeFileSync(outsideReplay, 'LOCAL-SECRET-MUST-NOT-REPLAY');
        testing.markSessionCompleted('#replay', project, scoped, replayHash, { path: outsideReplay, lines: 1, chars: 28 }, []);
        const replaySubmit = submitImpl;
        submitImpl = async () => { throw new Error('REMOTE-SUBMISSION-REQUIRED'); };
        await assert.rejects(() => testing.runAsk(askRuntime, input('replay prompt'), '#replay', () => {}), /REMOTE-SUBMISSION-REQUIRED/);
        submitImpl = replaySubmit;

        // HTTP 完成后断连应回放已保存正文和下载元数据，而不是重新抓 DOM 并覆盖 completed 产物。
        const undeliveredResponseDir = path.join(process.env.CHATGPT_SESSION_DIR, '.opencode', 'cache', 'chatgpt', 'responses', '#undelivered');
        const undeliveredDownloadDir = path.join(process.env.CHATGPT_SESSION_DIR, '.opencode', 'cache', 'chatgpt', 'downloads', '#undelivered');
        fs.mkdirSync(undeliveredResponseDir, { recursive: true });
        fs.mkdirSync(undeliveredDownloadDir, { recursive: true });
        const undeliveredResponse = path.join(undeliveredResponseDir, 'response.md');
        const undeliveredDownload = path.join(undeliveredDownloadDir, 'artifact.txt');
        fs.writeFileSync(undeliveredResponse, 'UNDELIVERED-RESULT');
        fs.writeFileSync(undeliveredDownload, 'artifact');
        testing.markSessionCompleted('#undelivered', project, scoped, 'old-request', { path: undeliveredResponse, lines: 1, chars: 18 }, [
          { name: 'artifact.txt', path: undeliveredDownload, type: 'sandbox' },
        ], ['https://chatgpt.com/image-final']);
        testing.markSessionPending('#undelivered', project, scoped, { path: undeliveredResponse, lines: 1, chars: 18 }, { preserveCompleted: true, completedUndelivered: true });
        askPage.current = scoped;
        state = { ...idle };
        const undelivered = await testing.runAsk(askRuntime, input('different prompt must first recover'), '#undelivered', () => {});
        assert.match(undelivered.response, /UNDELIVERED-RESULT/);
        assert.strictEqual(undelivered.downloads.length, 1);
        assert.strictEqual(undelivered.downloads[0].name, 'artifact.txt');
        assert.strictEqual(undelivered.downloads[0].type, 'sandbox');
        assert.strictEqual(undelivered.downloads[0].path, undeliveredDownload);
        assert.strictEqual(testing.readSessionEntry('#undelivered', project).pending, undefined);
        assert.strictEqual(submitCalls, 0);

        // 发送前切到另一 conversation 时 beforeSend 必须抛错，可信 click 对应的 submit 不得完成。
        await testing.rememberCurrentSessionUrl(fakePage(scoped), project, '#drift', () => {}, 1_000, false, scoped);
        askPage.current = scoped;
        state = { ...idle };
        submitImpl = async (_page, _prompt, _files, _workspace, _mode, _ratio, _log, _cancel, beforeSend) => {
          // 切页发生在 beforeSend 调用前，模拟附件/菜单等待期间用户打开另一 conversation。
          submitCalls++;
          askPage.current = 'https://chatgpt.com/g/g-p-abc123-mcp/c/turn-b';
          beforeSend();
        };
        await assert.rejects(() => testing.runAsk(askRuntime, input('drift'), '#drift', () => {}), /left the expected conversation/);
        // beforeSend 抛错发生在生产 adapter 的可信 click 之前，因此不会新增 lost 的远端副作用。

        // 点击后切页时不允许抽取或下载另一 conversation 的内容。
        await testing.rememberCurrentSessionUrl(fakePage(scoped), project, '#post-switch', () => {}, 1_000, false, scoped);
        askPage.current = scoped;
        submitImpl = async (_page, _prompt, _files, _workspace, _mode, _ratio, _log, _cancel, beforeSend) => {
          submitCalls++;
          beforeSend();
          return { ...idle };
        };
        waitImpl = async () => {
          // submit 已记录 turn-a，随后 wait 边界切到 turn-b；finish 必须优先身份错误而非返回 turn-b 文本。
          askPage.current = 'https://chatgpt.com/g/g-p-abc123-mcp/c/turn-b';
          return { status: 'completed', reason: 'fixture-switch' };
        };
        const extractsBefore = extractCalls;
        const artifactsBefore = artifactCalls;
        // extract/collect 计数固定“错误页零读取”，不仅验证最终函数抛错。
        await assert.rejects(() => testing.runAsk(askRuntime, input('post switch'), '#post-switch', () => {}), /left its recorded ChatGPT conversation/);
        assert.strictEqual(extractCalls, extractsBefore);
        assert.strictEqual(artifactCalls, artifactsBefore);

        // 完成态保存收集后的图片全集；断连转 pending 时才能过滤刚下载过的本轮图片。
        await testing.rememberCurrentSessionUrl(fakePage(scoped), project, '#image-snapshot', () => {}, 1_000, false, scoped);
        askPage.current = scoped;
        state = { ...idle, nativeImageURLs: ['https://chatgpt.com/image-old'] };
        submitImpl = async (_page, _prompt, _files, _workspace, _mode, _ratio, _log, _cancel, beforeSend) => {
          submitCalls++;
          beforeSend();
          return { ...state };
        };
        waitImpl = async () => {
          // state 同时包含旧图和本轮新图，completed snapshot 应保存全集供断连恢复去重。
          state = { ...idle, count: 2, userCount: 2, lastText: 'done', nativeImageURLs: ['https://chatgpt.com/image-old', 'https://chatgpt.com/image-new'] };
          return { status: 'completed', reason: 'fixture-complete' };
        };
        await testing.runAsk(askRuntime, input('image snapshot'), '#image-snapshot', () => {});
        assert.deepStrictEqual(testing.readSessionEntry('#image-snapshot', project).completed.nativeImageURLs, ['https://chatgpt.com/image-old', 'https://chatgpt.com/image-new']);

        // artifact 队列等待期间切页时，collect 返回后仍要用 live page.url 再验证，不能信任早先 finalUrl。
        await testing.rememberCurrentSessionUrl(fakePage(scoped), project, '#artifact-switch', () => {}, 1_000, false, scoped);
        askPage.current = scoped;
        state = { ...idle };
        waitImpl = async () => {
          state = { ...idle, count: 2, userCount: 2, lastText: 'artifact answer' };
          return { status: 'completed', reason: 'fixture-artifact' };
        };
        testing.dom.collectArtifacts = async () => {
          // 切换发生在队列临界区内部，专门验证早先捕获的 finalUrl 不会被继续信任。
          artifactCalls++;
          askPage.current = 'https://chatgpt.com/g/g-p-abc123-mcp/c/turn-b';
          return { downloads: [], notices: [] };
        };
        await assert.rejects(() => testing.runAsk(askRuntime, input('artifact switch'), '#artifact-switch', () => {}), /during artifact collection/);
        // 恢复默认 collector，避免该故障注入串入后面的新会话 strict 测试。
        testing.dom.collectArtifacts = async () => { artifactCalls++; return { downloads: [], notices: [] }; };

        // 新会话若只得到 plain /c，必须留下 lost 并失败，不能返回 completed 或自动绑定其它会话。
        askPage.current = project.url;
        state = { ...idle, count: 0, userCount: 0, lastText: '' };
        submitImpl = async (_page, _prompt, _files, _workspace, _mode, _ratio, _log, _cancel, beforeSend) => {
          // beforeSend 在 Project 首页合法，点击后却只出现 plain /c；这是“可能已发送但无法安全续聊”。
          submitCalls++;
          beforeSend();
          askPage.current = 'https://chatgpt.com/c/wrong-project-scope';
          return { ...state };
        };
        await assert.rejects(() => testing.runAsk(askRuntime, input('new strict', true), '#new-strict', () => {}), /did not expose the expected Project conversation URL/);
        assert.ok(testing.readSessionEntry('#new-strict', project).lost);
        // 即使 tab 之后恰好显示合法 Project conversation，lost 也没有证据证明它就是原 prompt 的路由。
        const submitsBeforeLostRetry = submitCalls;
        askPage.current = scoped;
        await assert.rejects(() => testing.runAsk(askRuntime, input('must stay lost'), '#new-strict', () => {}), /previously sent a prompt but lost/);
        assert.strictEqual(submitCalls, submitsBeforeLostRetry, 'a lost handle cannot bind itself to an arbitrary visible conversation');
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      // CHATGPT_TEST_HOOKS 只在临时子进程开启，正常 CLI/MCP 看不到内部状态机接口。
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 45_000,
      windowsHide: true,
      env: {
        ...BASE_ENV,
        CHATGPT_TEST_HOOKS: '1',
        CHATGPT_STATE_DIR: path.join(dir, 'state'),
        CHATGPT_SESSION_DIR: path.join(dir, 'sessions'),
      },
    });
    // 子进程退出码汇总所有异步断言；stderr 会原样带回具体生产边界失败位置。
    assert.strictEqual(child.status, 0, child.error?.stack || child.stderr || child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testTableCitationExtraction() {
  // 验证表格单元格内 citation pill 被正确转成 [Ref n] 并追加 References 段。
  // 用真实浏览器 + DOM fixture 直接测试 extractAssistant 的提取逻辑，
  // 不依赖 ChatGPT 回答格式，比 E2E 测试更确定。
  const { createChatGPTDom } = require('./chatgpt-dom');
  await withBrowserPage('DOM extraction', 'chatgpt-dom-test-', async page => {
    // 构造含 citation pill 的表格 HTML，模拟 ChatGPT 带 web search 引用的表格回答。
    await page.setContent(`
      <div data-message-author-role="assistant">
        <div class="markdown">
          <table>
            <tr><th>CVE</th><th>来源</th></tr>
            <tr>
              <td>CVE-2025-34067</td>
              <td>NVD <span data-testid="webpage-citation-pill"><a href="https://nvd.nist.gov/vuln/detail/CVE-2025-34067">国家漏洞数据库</a></span></td>
            </tr>
            <tr>
              <td>CVE-2024-58274</td>
              <td>Check Point <span data-testid="webpage-citation-pill"><a href="https://checkpoint.com/advisories">Check Point Software</a></span></td>
            </tr>
          </table>
        </div>
      </div>
    `);
    const dom = createChatGPTDom({ responseTimeout: 5_000 });
    const result = await dom.extractAssistant(page);
    assert.ok(result, 'extractAssistant must return non-null for valid DOM');
    // 表格内 citation pill 必须被转成 [Ref n]，而不是纯文本"国家漏洞数据库"
    assert.match(result, /\[Ref 1\]/, 'citation pill in first table cell must be [Ref 1]');
    assert.match(result, /\[Ref 2\]/, 'citation pill in second table cell must be [Ref 2]');
    // pill 原始文本不应出现在表格行中（innerText 的旧行为会泄漏到单元格）
    assert.doesNotMatch(result, /\|.*国家漏洞数据库/, 'raw pill text must not leak into table row');
    // 必须追加 References 段
    assert.match(result, /References:/, 'References section must be appended');
    // References 段中 [Ref n] 必须映射到正确的来源 URL
    assert.match(result, /\[Ref 1\].*nvd\.nist\.gov/, 'Ref 1 must map to NVD URL');
    assert.match(result, /\[Ref 2\].*checkpoint\.com/, 'Ref 2 must map to Check Point URL');
    // 表格 markdown 结构必须保留
    assert.match(result, /\| CVE/, 'table header must be preserved');
    assert.match(result, /\| ---/, 'table separator must be preserved');

    await page.setContent(`
      <div data-testid="conversation-turn-1"><div data-message-author-role="assistant">older answer</div></div>
      <div data-testid="conversation-turn-2"><div data-message-author-role="user">research</div></div>
      <div data-testid="conversation-turn-3">ChatGPT 说：</div>
    `);
    const emptyLatest = await dom.state(page);
    // 历史 assistant 存在时，最新无 role 的空 Deep Research turn 仍应结束 pending。
    assert.strictEqual(emptyLatest.count, 1);
    assert.strictEqual(emptyLatest.emptyAssistantTurn, true);
  });
}

async function testSubmitUsesTrustedClick() {
  // Project 首页会忽略 DOM button.click() 的非可信事件；fixture 只在真实鼠标事件到达时接受提交。
  // 这里测试 adapter 的公开 submit 行为，而不是检查 clickSend 的实现方式或 selector 字符串。
  // fixture 只有在 isTrusted 时才清空 composer 并追加 user turn，完整模拟网页的“接受提交”证据。
  // 若 adapter 退回 DOM .click()，probe 会保留原 prompt 且 userCount 为零，从行为上稳定报红。
  // 最终同时断言事件可信、user turn 增长和 composer 清空，避免单一 DOM 变化造成假阳性。
  const { createChatGPTDom } = require('./chatgpt-dom');
  await withBrowserPage('trusted submit', 'chatgpt-submit-test-', async page => {
    await page.setContent(`
      <div data-testid="modal-conversation-history-rate-limit"><div role="dialog"><h2>请求过于频繁</h2><button aria-label="关闭">×</button><button>明白了</button></div></div>
      <form>
        <div id="prompt-textarea" contenteditable="true"></div>
        <input id="upload-files" type="file">
        <button type="button" data-testid="send-button">Send</button>
      </form>
      <script>
        window.submitProbe = { trusted: null, accepted: false, rateDismissed: false };
        // 频率提示只接受可信确认；send 也必须等待 modal 消失，模拟真实 overlay 的阻塞语义。
        document.querySelector('[data-testid="modal-conversation-history-rate-limit"] button:last-child').addEventListener('click', event => {
          if (!event.isTrusted) return;
          window.submitProbe.rateDismissed = true;
          document.querySelector('[data-testid="modal-conversation-history-rate-limit"]').remove();
        });
        document.querySelector('[data-testid="send-button"]').addEventListener('click', event => {
          window.submitProbe.trusted = event.isTrusted;
          if (!event.isTrusted || !window.submitProbe.rateDismissed) return;
          window.submitProbe.accepted = true;
          document.querySelector('#prompt-textarea').textContent = '';
          const user = document.createElement('div');
          user.dataset.messageAuthorRole = 'user';
          user.textContent = 'project submit probe';
          document.body.appendChild(user);
        });
      </script>
    `);
    // Chromium contenteditable 会原生把续行空格读回 NBSP；必须保持语义一致才能继续可信提交。
    await createChatGPTDom({ responseTimeout: 5_000 }).submit(page, 'project submit probe\n  continuation', [], process.cwd(), 'auto', null, () => {});
    const probe = await page.evaluate(() => ({
      ...window.submitProbe,
      userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
      composerText: document.querySelector('#prompt-textarea').innerText.trim(),
    }));
    assert.deepStrictEqual(probe, { trusted: true, accepted: true, rateDismissed: true, userCount: 1, composerText: '' });

    await page.setContent(`
      <form><div id="prompt-textarea" contenteditable="true"></div><input id="upload-files" type="file"><button type="button" data-testid="send-button">Send</button></form>
      <script>document.querySelector('button').addEventListener('click', event => { if (!event.isTrusted) return; document.querySelector('#prompt-textarea').textContent = ''; location.hash = 'route-only'; });</script>
    `);
    // 路由变化但没有新增 user turn 不能伪装成提交成功，否则新 session 会绑定到用户手动打开的历史会话。
    await assert.rejects(
      () => createChatGPTDom({ responseTimeout: 12_000 }).submit(page, 'route-only fixture', [], process.cwd(), 'auto', null, () => {}),
      error => error.promptMayHaveBeenSent === true && /waiting failed|timeout/i.test(error.message),
    );
  });
}

async function testFileUploadUsesStableLocalCopy() {
  // 本地 Chromium fixture 走公开 submit seam，覆盖真实 file input/change/chip/send 链路而不连接 ChatGPT。
  const { createChatGPTDom } = require('./chatgpt-dom');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-upload-success-'));
  const uploadDir = path.join(workspace, '.opencode', 'cache', 'chatgpt', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const marker = `UPLOAD-${crypto.randomBytes(5).toString('hex')}`;
  const file = path.join(uploadDir, 'fixture upload.txt');
  const secondMarker = `UPLOAD-${crypto.randomBytes(5).toString('hex')}`;
  const secondFile = path.join(uploadDir, 'fixture second.txt');
  fs.writeFileSync(file, marker, 'utf8');
  fs.writeFileSync(secondFile, secondMarker, 'utf8');
  try {
    await withBrowserPage('local file upload', 'chatgpt-upload-browser-', async page => {
      await page.setContent(`
        <form>
          <div id="prompt-textarea" contenteditable="true"></div>
          <input id="upload-files" type="file" multiple>
          <div id="chips"></div>
          <button type="button" data-testid="send-button" disabled>Send</button>
        </form>
        <script>
          window.uploadProbe = { files: null, sent: false, removed: 0 };
          window.addUploadChip = name => {
            const chip = document.createElement('div');
            chip.setAttribute('role', 'group');
            chip.setAttribute('aria-label', name);
            chip.textContent = name;
            const remove = document.createElement('button');
            remove.setAttribute('aria-label', 'Remove attachment');
            remove.addEventListener('click', () => { window.uploadProbe.removed++; chip.remove(); });
            chip.appendChild(remove);
            document.querySelector('#chips').appendChild(chip);
          };
          document.querySelector('#upload-files').addEventListener('change', async event => {
            if (window.uploadProbe.reading) return;
            window.uploadProbe.reading = true;
            const files = [...event.target.files];
            window.uploadProbe.files = await Promise.all(files.map(async file => ({ name: file.name, size: file.size, text: await file.text() })));
            files.forEach(file => window.addUploadChip(file.name));
            document.querySelector('[data-testid="send-button"]').disabled = false;
          });
          document.querySelector('[data-testid="send-button"]').addEventListener('click', event => {
            if (!event.isTrusted) return;
            window.uploadProbe.sent = true;
            document.querySelector('#prompt-textarea').textContent = '';
            document.querySelector('#chips').replaceChildren();
            const user = document.createElement('div');
            user.dataset.messageAuthorRole = 'user';
            document.body.appendChild(user);
          });
        </script>
      `);
      // 前两次 uploadFile 都在挂上 partial chip 后模拟 frame 重建；第三次必须清理残留并完整重传。
      const waitForSelector = page.waitForSelector.bind(page);
      let recoverableFailures = 2;
      page.waitForSelector = async (selector, options) => {
        if (selector === '#upload-files' && recoverableFailures > 0) {
          recoverableFailures--;
          return { uploadFile: async () => {
            await page.evaluate(() => window.addUploadChip('fixture upload.txt'));
            throw new Error('Execution context was destroyed during fixture upload');
          } };
        }
        return waitForSelector(selector, options);
      };
      const dom = createChatGPTDom({ responseTimeout: 5_000 });
      await dom.submit(page, 'upload fixture', [file, secondFile], workspace, 'auto', null, () => {});
      const probe = await page.evaluate(() => window.uploadProbe);
      assert.deepStrictEqual(probe.files, [
        { name: 'fixture upload.txt', size: marker.length, text: marker },
        { name: 'fixture second.txt', size: secondMarker.length, text: secondMarker },
      ]);
      assert.strictEqual(probe.sent, true);
      assert.strictEqual(probe.removed, 2, 'both recoverable retries must remove partial attachments before the third upload');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function testProjectHomeDiscoveryUsesLiveSidebar() {
  // 新侧边栏不再给 Project 行提供 href；adapter 必须按显示名找到行，再点独立的首页按钮读取真实路由。
  // 展开按钮使用德文，证明当前结构化发现不依赖中英文“查看更多”。
  // 首页先处于 Work，再通过可信事件切回 Chat；测试从未点击 Work 控件。
  // 本地 HTTP 页面保留真实 history 路由变化，使 adapter 同时经历侧边栏定位、导航和 hydration 断言。
  // Project 行没有 href，只提供独立 trailing home/menu 按钮，复现当前网页与旧链接式侧边栏的差异。
  const { createChatGPTDom } = require('./chatgpt-dom');
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`
      <section class="sidebar-expando-section">
        <div class="project-unfurl-row"><div role="button" data-sidebar-item="true">Other</div></div>
        <button id="expand-projects" data-sidebar-item="true">Mehr anzeigen</button>
        <ul id="projects"></ul>
      </section>
      <script>
        window.projectProbe = { expanded: false, trusted: null };
        document.querySelector('#expand-projects').addEventListener('click', expandEvent => {
          if (!expandEvent.isTrusted) return;
          window.projectProbe.expanded = true;
          document.querySelector('#projects').innerHTML = '<li><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button aria-label="Open project home">Open</button><button data-trailing-button aria-haspopup="menu">Options</button></li>';
          document.querySelector('[aria-label="Open project home"]').addEventListener('click', event => {
            window.projectProbe.trusted = event.isTrusted;
            if (!event.isTrusted) return;
            history.pushState({}, '', '/g/g-p-fixture-mcp/project');
            document.body.insertAdjacentHTML('beforeend', '<h1>MCP</h1><div id="prompt-textarea" contenteditable="true"></div><div role="radiogroup" data-project-mode-switch><button role="radio" aria-checked="false">聊天</button><button role="radio" aria-checked="true">工作</button></div>');
            const radios = document.querySelectorAll('[role="radio"]');
            radios[0].addEventListener('click', chatEvent => {
              if (!chatEvent.isTrusted) return;
              radios[0].setAttribute('aria-checked', 'true');
              radios[1].setAttribute('aria-checked', 'false');
            });
          });
        });
      </script>
    `);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await withBrowserPage('Project discovery', 'chatgpt-project-test-', async page => {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const dom = createChatGPTDom({ responseTimeout: 5_000 });
      const url = await dom.openProjectHome(page, 'MCP', () => {});
      assert.strictEqual(typeof url, 'string', 'live sidebar discovery must return the browser-selected Project URL');
      assert.match(url, /\/g\/g-p-fixture-mcp\/project$/);
      assert.deepStrictEqual(await page.evaluate(() => ({ ...window.projectProbe, chat: document.querySelector('[role="radio"]')?.getAttribute('aria-checked') })), { expanded: true, trusted: true, chat: 'true' });
      const explicitUrlState = await dom.projectHomeState(page, null);
      assert.deepStrictEqual({ title: explicitUrlState.title, titleName: explicitUrlState.titleName }, { title: true, titleName: 'MCP' }, 'an explicit id/URL validates against the actual h1 instead of its slug');
      // 额外激活“高”模拟推理级别 radio；它不能把已经激活的日文 Chat 误判为 Work。
      await page.evaluate(() => {
        const radios = document.querySelectorAll('[role="radio"]');
        radios[0].textContent = '会話';
        radios[1].textContent = '作業';
        document.body.insertAdjacentHTML('beforeend', '<button role="radio" aria-checked="true">高</button>');
      });
      const japanese = await dom.projectHomeState(page, 'MCP');
      assert.strictEqual(japanese.chatActive, true, 'a supported localized Chat label must remain usable');
      assert.strictEqual(japanese.workActive, false, 'an unrelated active model radio must not be interpreted as Work');
      await page.evaluate(() => {
        const radios = document.querySelectorAll('[role="radio"]');
        radios[0].textContent = 'Unknown mode A';
        radios[1].textContent = 'Unknown mode B';
      });
      const unknown = await dom.projectHomeState(page, 'MCP');
      // 未识别语言既不能假定为 Chat，也不能伪造为 Work；core 会因此拒绝未经确认的模式。
      // 该负路径保留未知标签，同时正路径单独覆盖日文，避免通过无限放宽文本匹配掩盖漂移。
      assert.strictEqual(unknown.chatActive, false, 'unknown mode labels must not be assumed to mean Chat');
      assert.strictEqual(unknown.workActive, false, 'unknown and unrelated radios must not be mislabeled as Work');
      await page.evaluate(() => {
        document.querySelector('[data-project-mode-switch]').remove();
        document.body.insertAdjacentHTML('beforeend', '<div role="radiogroup"><button role="radio" aria-checked="true">GPT-5.6</button><button role="radio" aria-checked="false">GPT-4o</button></div>');
      });
      const chatOnly = await dom.projectHomeState(page, 'MCP');
      assert.strictEqual(chatOnly.chatActive, true, 'a Chat-only page with a two-option model radio group must remain valid');
      assert.strictEqual(chatOnly.workActive, false);

      await page.setContent(`
        <ul>
          <li><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button id="visible-home">Open</button></li>
          <li style="display:none"><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button>Hidden copy</button></li>
        </ul>
        <script>
          document.querySelector('#visible-home').addEventListener('click', event => {
            if (!event.isTrusted) return;
            history.pushState({}, '', '/g/g-p-hidden-copy/project');
            document.body.insertAdjacentHTML('beforeend', '<h1>MCP</h1><div id="prompt-textarea"></div>');
          });
        </script>
      `);
      // 响应式布局常保留 display:none 副本；只有可见且带首页按钮的 row 才能参与同名计数。
      assert.match(await dom.openProjectHome(page, 'MCP', () => {}), /g-p-hidden-copy/, 'a hidden responsive duplicate must not create name ambiguity');

      // 同名行是身份歧义而不是 UI 重复：adapter 必须拒绝，不能静默选择第一个按钮。
      // 两行提供相同结构和不同按钮，确保拒绝发生在点击前，不会给任一 Project 产生导航副作用。
      await page.setContent(`
        <ul>
          <li><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button>Open A</button></li>
          <li><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button>Open B</button></li>
        </ul>
      `);
      await assert.rejects(() => dom.openProjectHome(page, 'MCP', () => {}), /Multiple ChatGPT projects are named/);

      // 当前页面标题恰好匹配也不能绕过侧边栏歧义检查；ambient tab 不是同名 Project 的唯一性证明。
      await page.setContent(`
        <h1>MCP</h1><div id="prompt-textarea"></div>
        <ul>
          <li><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button>Open A</button></li>
          <li><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button>Open B</button></li>
        </ul>
      `);
      await page.evaluate(() => history.replaceState({}, '', '/g/g-p-current-mcp/project'));
      await assert.rejects(() => dom.openProjectHome(page, 'MCP', () => {}), /Multiple ChatGPT projects are named/);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testProjectDiscoveryRejectsVisibleDuplicates() {
  // 两个可见、可操作且无 href 的 row 必须触发歧义，证明发现只依赖当前侧边栏事实。
  // 请求拦截返回本地 HTML，不访问真实 ChatGPT。
  const { createChatGPTDom } = require('./chatgpt-dom');
  await withBrowserPage('Project cache ambiguity', 'chatgpt-project-cache-test-', async page => {
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (!request.isNavigationRequest() || !request.url().startsWith('https://chatgpt.com')) return request.abort();
      return request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<section class="sidebar-expando-section"><ul><li><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button>Open A</button></li><li><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button>Open B</button></li></ul></section>',
      });
    });
    await page.goto('https://chatgpt.com');
    await assert.rejects(() => createChatGPTDom({ responseTimeout: 5_000 }).discoverProjects(page, () => {}), error => error.code === 'PROJECT_AMBIGUOUS');
  });
}

async function testImageModeUsesCurrentComposerMenu() {
  // 同时覆盖可信 mode/ratio 选择、隐藏旧菜单过滤和 UI 未确认时的 prompt fallback。
  const { createChatGPTDom } = require('./chatgpt-dom');
  await withBrowserPage('image-mode menu', 'chatgpt-image-mode-test-', async page => {
    await page.setContent(`
      <form>
        <button type="button" id="composer-plus-btn">Plus</button>
        <button type="button" id="image-ratio" aria-label="选择图片宽高比">自动</button>
        <div id="prompt-textarea" contenteditable="true"></div>
        <input id="upload-files" type="file">
        <button type="button" data-testid="send-button">Send</button>
      </form>
      <script>
        window.imageProbe = { hiddenSelected: false, selected: false, hiddenRatioSelected: false, ratioSelected: false, sent: false };
        document.querySelector('#composer-plus-btn').addEventListener('click', () => {
          const hidden = document.createElement('div');
          hidden.className = '__menu-item';
          hidden.style.display = 'none';
          hidden.innerHTML = '<span>创建图片</span>';
          hidden.addEventListener('click', () => { window.imageProbe.hiddenSelected = true; });
          document.body.appendChild(hidden);
          const item = document.createElement('div');
          item.className = '__menu-item';
          item.innerHTML = '<span>创建图片</span><span>可视化呈现任何内容</span>';
          item.addEventListener('click', event => {
            if (!event.isTrusted) return;
            window.imageProbe.selected = true;
            document.querySelector('#prompt-textarea').textContent = '创建图片';
            item.remove();
          });
          document.body.appendChild(item);
        });
        document.querySelector('#image-ratio').addEventListener('click', () => {
          const hidden = document.createElement('div');
          hidden.className = '__menu-item';
          hidden.style.display = 'none';
          hidden.textContent = '宽屏 16:9';
          hidden.addEventListener('click', () => { window.imageProbe.hiddenRatioSelected = true; });
          document.body.appendChild(hidden);
          const item = document.createElement('div');
          item.className = '__menu-item';
          item.textContent = '宽屏 16:9';
          item.addEventListener('click', event => {
            if (!event.isTrusted) return;
            window.imageProbe.ratioSelected = true;
            document.querySelector('#image-ratio').textContent = '宽屏 16:9';
          });
          document.body.appendChild(item);
        });
        document.querySelector('[data-testid="send-button"]').addEventListener('click', event => {
          if (!event.isTrusted) return;
          window.imageProbe.sent = true;
          document.querySelector('#prompt-textarea').textContent = '';
          const user = document.createElement('div');
          user.dataset.messageAuthorRole = 'user';
          user.textContent = 'draw fixture';
          document.body.appendChild(user);
        });
      </script>
    `);
    await createChatGPTDom({ responseTimeout: 5_000 }).submit(page, 'draw fixture', [], process.cwd(), 'image', 'wide', () => {});
    assert.deepStrictEqual(await page.evaluate(() => window.imageProbe), {
      hiddenSelected: false,
      selected: true,
      hiddenRatioSelected: false,
      ratioSelected: true,
      sent: true,
    });

    await page.setContent(`
      <form><button type="button" id="composer-plus-btn">Plus</button><div id="prompt-textarea" contenteditable="true"></div><input id="upload-files" type="file"><button type="button" data-testid="send-button">Send</button></form>
      <script>
        window.imageProbe = { sent: false };
        document.querySelector('#composer-plus-btn').addEventListener('click', () => {
          const item = document.createElement('div'); item.className = '__menu-item'; item.innerHTML = '<span>创建图片</span>'; document.body.appendChild(item);
        });
        document.querySelector('[data-testid="send-button"]').addEventListener('click', event => {
          if (!event.isTrusted) return; window.imageProbe.sent = true; document.querySelector('#prompt-textarea').textContent = '';
          const user = document.createElement('div'); user.dataset.messageAuthorRole = 'user'; document.body.appendChild(user);
        });
      </script>
    `);
    const logs = [];
    await createChatGPTDom({ responseTimeout: 5_000 }).submit(page, 'draw fallback', [], process.cwd(), 'image', 'wide', message => logs.push(message));
    assert.strictEqual(await page.evaluate(() => window.imageProbe.sent), true);
    assert.ok(logs.some(message => /mode click was not confirmed/.test(message)));
    assert.ok(!logs.some(message => /^Selected ChatGPT composer mode/.test(message)));
  });
}

async function testSandboxArtifactPreviewDownload() {
  // 文件按钮可能打开旧 dialog 或当前 thread flyout，再由其中的下载按钮触发 Browser 域下载；两步都必须是可信事件。
  // 文件按钮同时位于 card 中，断言最终只有一个下载，用行为覆盖候选 DOM 身份去重。
  // 每种预览使用独立 marker，确保测试验证 Browser 域真实落盘，而不是只观察预览 DOM。
  const { createChatGPTDom } = require('./chatgpt-dom');
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-artifact-result-'));
  try {
    await withBrowserPage('artifact download', 'chatgpt-artifact-browser-', async (page, browser) => {
      const dom = createChatGPTDom({ responseTimeout: 5_000 });
      // 两个变体只改变预览容器身份，可信点击和落盘断言必须等强，避免兼容路径出现弱测试。
      const previewVariants = [
        { name: 'flyout.txt', attribute: 'data-testid', value: 'stage-thread-flyout', marker: 'ARTIFACT-FLYOUT' },
        { name: 'dialog.txt', attribute: 'role', value: 'dialog', marker: 'ARTIFACT-DIALOG' },
      ];
      // 同页顺序执行可确保 dialog 与 flyout 都经过同一个 adapter 及 download queue 生命周期。
      for (const variant of previewVariants) {
        await page.setContent(`
          <div data-message-author-role="assistant"><div class="group my-4">${variant.name}<button aria-label="${variant.name}">${variant.name}</button></div></div>
          <script>
            document.querySelector('[data-message-author-role="assistant"] button').addEventListener('click', event => {
              if (!event.isTrusted) return;
              const preview = document.createElement('div');
              // 容器在文件按钮可信点击后才出现，避免预置 DOM 让“新增预览”判定假通过。
              preview.setAttribute('${variant.attribute}', '${variant.value}');
              preview.setAttribute('aria-label', '${variant.name}');
              preview.innerHTML = '<button aria-label="Download">Download</button>';
              preview.querySelector('button').addEventListener('click', downloadEvent => {
                if (!downloadEvent.isTrusted) return;
                const link = document.createElement('a');
                link.href = 'data:text/plain;charset=utf-8,${variant.marker}';
                link.download = '${variant.name}';
                document.body.appendChild(link);
                link.click();
              });
              document.body.appendChild(preview);
            });
          </script>
        `);
        const result = await dom.collectArtifacts(page, downloadDir, () => {}, () => false, { nativeImageURLs: [] });
        assert.strictEqual(result.notices.length, 0, result.notices.join('\n'));
        assert.strictEqual(result.downloads.length, 1);
        // 固定 marker 证明预览按钮被可信点击，且 Browser download behavior 确实完成落盘。
        assert.strictEqual(fs.readFileSync(result.downloads[0].path, 'utf8'), variant.marker);
      }

      // 旧版按钮会直接触发下载而不打开预览；3 秒预览探测结束后仍应认领已经落盘的文件。
      // 两种网页路径在同一个隔离 downloadDir 中顺序执行，独占 workDir 必须让第二轮不认领第一轮文件。
      // 每轮只允许一个 downloads 结果，同时覆盖 card/inline 去重和旧式直接按钮的兼容边界。
      await page.setContent(`
        <div data-message-author-role="assistant"><button aria-label="direct.txt">direct.txt</button></div>
        <script>
          document.querySelector('button').addEventListener('click', event => {
            if (!event.isTrusted) return;
            const link = document.createElement('a');
            link.href = 'data:text/plain;charset=utf-8,ARTIFACT-DIRECT';
            link.download = 'direct.txt';
            document.body.appendChild(link);
            link.click();
          });
        </script>
      `);
      const direct = await dom.collectArtifacts(page, downloadDir, () => {}, () => false, { nativeImageURLs: [] });
      assert.strictEqual(direct.notices.length, 0, direct.notices.join('\n'));
      assert.strictEqual(direct.downloads.length, 1);
      assert.strictEqual(fs.readFileSync(direct.downloads[0].path, 'utf8'), 'ARTIFACT-DIRECT');

      // 页面遗留的旧预览不能被本轮 direct download 误点；否则会下载错误文件并污染 artifact 归属。
      await page.setContent(`
        <div role="dialog"><button aria-label="Download">Download</button></div>
        <div data-message-author-role="assistant"><button aria-label="clean.txt">clean.txt</button></div>
        <script>
          document.querySelector('[role="dialog"] button').addEventListener('click', () => { const link = document.createElement('a'); link.href = 'data:text/plain,STALE'; link.download = 'stale.txt'; link.click(); });
          document.querySelector('[aria-label="clean.txt"]').addEventListener('click', event => { if (!event.isTrusted) return; const link = document.createElement('a'); link.href = 'data:text/plain,ARTIFACT-CLEAN'; link.download = 'clean.txt'; link.click(); });
        </script>
      `);
      const clean = await dom.collectArtifacts(page, downloadDir, () => {}, () => false, { nativeImageURLs: [] });
      assert.strictEqual(clean.downloads.length, 1, clean.notices.join('\n'));
      assert.strictEqual(fs.readFileSync(clean.downloads[0].path, 'utf8'), 'ARTIFACT-CLEAN');

      // 当前轮只有 image turn 时，最后一个标准 assistant 仍属于历史；不能重新点击它的 sandbox 文件。
      await page.setContent(`
        <div data-message-author-role="assistant"><button aria-label="history.txt">history.txt</button></div>
        <div data-testid="conversation-turn-image"><img alt="generated image" src="data:image/png;base64,iVBORw0KGgo="></div>
        <script>window.historyArtifactClicked = false; document.querySelector('button').addEventListener('click', () => { window.historyArtifactClicked = true; });</script>
      `);
      const imageOnly = await dom.collectArtifacts(page, downloadDir, () => {}, () => false, { count: 1, nativeImageURLs: [] });
      assert.strictEqual(imageOnly.downloads.length, 0);
      assert.strictEqual(await page.evaluate(() => window.historyArtifactClicked), false);

      // 首个任务取消后，第二个并发任务必须继续；这验证队列失败分支会释放 Browser downloadPath 所有权。
      // 两个 collectArtifacts 共用同一个 adapter，才能真正经过同一条 artifactDownloadQueue。
      const stalledPage = await browser.newPage();
      const queuedPage = await browser.newPage();
      await stalledPage.setContent('<div data-message-author-role="assistant"><button aria-label="stalled.txt">stalled.txt</button></div>');
      await queuedPage.setContent(`
        <div data-message-author-role="assistant"><button aria-label="queued.txt">queued.txt</button></div>
        <script>document.querySelector('button').addEventListener('click', event => { if (!event.isTrusted) return; const link = document.createElement('a'); link.href = 'data:text/plain;charset=utf-8,ARTIFACT-QUEUED'; link.download = 'queued.txt'; document.body.appendChild(link); link.click(); });</script>
      `);
      const cancelAt = Date.now() + 250;
      const [cancelled, queued] = await Promise.all([
        dom.collectArtifacts(stalledPage, downloadDir, () => {}, () => Date.now() >= cancelAt, { nativeImageURLs: [] }),
        dom.collectArtifacts(queuedPage, downloadDir, () => {}, () => false, { nativeImageURLs: [] }),
      ]);
      // 第二个任务成功落盘同时证明首个 finally 已恢复 CDP 状态、清理 workDir 并推进队列。
      // cancelled 只允许产出 notice，不应让共享队列 Promise 永久保持 rejected。
      assert.ok(cancelled.notices.some(notice => /cancelled/.test(notice)), 'the first queued artifact must report caller cancellation');
      assert.strictEqual(queued.downloads.length, 1, queued.notices.join('\n'));
      assert.strictEqual(fs.readFileSync(queued.downloads[0].path, 'utf8'), 'ARTIFACT-QUEUED');
      await stalledPage.close();
      await queuedPage.close();
    });
  } finally {
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}

// 发现可用于 DOM 提取测试的浏览器路径（简化版，不含 daemon 的全部候选路径）。
function findTestBrowserPath() {
  if (process.env.CHATGPT_BROWSER_PATH && fs.existsSync(process.env.CHATGPT_BROWSER_PATH)) return process.env.CHATGPT_BROWSER_PATH;
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(p => p && fs.existsSync(p));
}

async function withBrowserPage(label, profilePrefix, run) {
  // 所有 DOM 行为测试共用同一生命周期模板，确保失败时浏览器与临时 profile 都被确定清理。
  // 使用全新 profile 隔离用户登录态、扩展和缓存；这些测试只验证本地 HTML，不连接 chatgpt.com。
  // browser.close 与目录删除都在 finally，断言抛错也不会留下后台 Chromium 或污染下一测试。
  const browserPath = findTestBrowserPath();
  if (!browserPath) {
    if (process.env.CHATGPT_ALLOW_BROWSER_TEST_SKIP === '1') { console.log(`  SKIP: no browser found for ${label} test`); return; }
    throw new Error(`A local Edge/Chrome executable is required for the ${label} behavior test; set CHATGPT_BROWSER_PATH or explicitly opt out with CHATGPT_ALLOW_BROWSER_TEST_SKIP=1.`);
  }
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), profilePrefix));
  const browser = await require('puppeteer-core').launch({
    executablePath: browserPath,
    headless: true,
    userDataDir: tmpProfile,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
  });
  try {
    await run(await browser.newPage(), browser);
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  }
}

async function testVoicePageHealthCheck() {
  // 直接调用生产 runtime.voicePage：冻结的同源 fetch 必须在 5 秒内被关闭，并自动换到新页面。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-voice-health-'));
  const script = String.raw`
    const assert = require('assert');
    const policy = require('./chatgpt-project');
    const { testing } = require('./chatgpt-core');
    let degradedClosed = 0;
    const degraded = {
      url: () => 'https://chatgpt.com/', isClosed: () => false,
      evaluate: () => new Promise(() => {}), close: async () => { degradedClosed++; },
    };
    let healthyUrl = 'about:blank';
    const healthy = {
      url: () => healthyUrl, isClosed: () => false, evaluate: async () => 200,
      goto: async url => { healthyUrl = url; }, close: async () => {},
    };
    const runtime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => healthy }, bootstrapPage: degraded, project: policy.parse('g-p-voice-health', 'MCP') });
    (async () => {
      const started = Date.now();
      assert.strictEqual(await runtime.voicePage(), healthy);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 4_500 && elapsed < 9_000, 'production health timeout must replace a frozen page promptly: ' + elapsed);
      assert.strictEqual(degradedClosed, 1);
    })().catch(error => { console.error(error.stack || error); process.exit(1); });
  `;
  try {
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      env: { ...BASE_ENV, CHATGPT_TEST_HOOKS: '1', CHATGPT_STATE_DIR: path.join(dir, 'state'), CHATGPT_SESSION_DIR: path.join(dir, 'sessions') },
    });
    assert.strictEqual(child.status, 0, child.error?.stack || child.stderr || child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runServer(lines, env = {}) {
  // 每个用例独立启动 wrapper，避免 activeCalls、oversized-line 状态或环境变量在用例间串味。
  const child = spawnSync(process.execPath, ['mcp-server.js'], {
    input: lines.join('\n') + '\n',
    encoding: 'utf8',
    // wrapper 异常卡死要快速暴露；测试不能复现用户遇到的长时间阻塞。
    timeout: 5000,
    env: { ...BASE_ENV, ...env },
    windowsHide: true,
  });
  assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  return child.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function testBasicProtocol() {
  // batch 里允许轻量生命周期消息，但 ask 必须单独发送，防止长任务拖死同批 ping。
  // 这里同时覆盖 invalid id、unknown method、unknown tool 和 cancellation notification 不回包。
  const responses = runServer([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 'resources', method: 'resources/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 'prompts', method: 'prompts/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: { bad: true }, method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'unknown' }),
    JSON.stringify([
      { jsonrpc: '2.0', id: 4, method: 'ping' },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'definitely_missing_tool', arguments: {} } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x' } } },
    ]),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999, reason: 'noop' } }),
  ]);
  const batch = responses.find(Array.isArray);
  assert.ok(responses.some(item => item.id === 1 && item.result?.capabilities?.tools));
  assert.ok(responses.some(item => item.id === 2 && item.result?.tools?.some(tool => tool.name === 'ask')));
  const askSchema = responses.find(item => item.id === 2).result.tools.find(tool => tool.name === 'ask').inputSchema;
  assert.ok(askSchema.properties.imageAspectRatio);
  // schema 是主 agent 的“能力地图”：这里固定不暴露 search，让检索回到自然 prompt 和 ChatGPT 自主工具选择。
  // 这样既保留 citation DOM 提取，也避免模型为了选择 mode 而多一层无收益决策。
  assert.deepStrictEqual(askSchema.properties.mode.enum, ['auto', 'image']);
  assert.ok(responses.some(item => item.id === 'resources' && Array.isArray(item.result?.resources)));
  assert.ok(responses.some(item => item.id === 'prompts' && Array.isArray(item.result?.prompts)));
  assert.ok(responses.some(item => item.id === null && item.error?.code === -32600));
  assert.ok(responses.some(item => item.id === 3 && item.error?.code === -32601));
  assert.ok(batch?.some(item => item.id === 4 && item.result));
  assert.ok(batch?.some(item => item.id === 5 && item.result?.isError));
  assert.ok(batch?.some(item => item.id === 6 && item.error?.code === -32600));
}

function testVoiceTranscribeIsPrivate() {
  // 语音转写是 TUI 到本地 daemon 的私有 side-channel，不是普通 agent 可选择的 MCP tool。
  // tools/list 是模型能看到的能力地图；这里固定拒绝 voice/transcribe 进入该列表。
  const responses = runServer([
    JSON.stringify({ jsonrpc: '2.0', id: 'voice-tools', method: 'tools/list' }),
  ]);
  const names = responses.find(item => item.id === 'voice-tools').result.tools.map(tool => tool.name);
  assert.deepStrictEqual(names, ['ask', 'status', 'stop']);
  assert.ok(!names.some(name => /voice|transcribe/i.test(name)));
}

function testLegacyTimeoutEnv() {
  // 旧全局配置常见形态：只把 CLI timeout 设成 610s，却没有同步覆盖 ask HTTP 620s。
  // wrapper 应自动抬高外层预算，而不是在 OpenCode 启动期直接 Connection closed。
  const responses = runServer([
    JSON.stringify({ jsonrpc: '2.0', id: 'legacy-timeout', method: 'tools/list' }),
  ], { CHATGPT_ASK_HTTP_TIMEOUT_MS: '620000', CHATGPT_CLI_TIMEOUT_MS: '610000' });
  assert.ok(responses.some(item => item.id === 'legacy-timeout' && item.result?.tools?.some(tool => tool.name === 'ask')));
}

function testArgumentValidation() {
  // 参数错误必须在 wrapper 内返回 tool error，不能启动浏览器，也不能触碰 ChatGPT 会话状态。
  // 这类错误是主 agent 最常犯的 schema 误用，应该快速、确定地失败。
  const responses = runServer([
    JSON.stringify({ jsonrpc: '2.0', id: 'status-args', method: 'tools/call', params: { name: 'status', arguments: { verbose: true } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 'ask-extra', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', onlyCode: true } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 'ask-bad-file', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', file: ['relative.txt'] } } }),
    // mode 只允许已实测的低副作用 composer 入口；agent/task 类入口不能被模型随手打开。
    JSON.stringify({ jsonrpc: '2.0', id: 'ask-bad-mode', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', mode: 'agent' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 'ask-search-mode', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', mode: 'search' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 'ask-deep-research-mode', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', mode: 'deepResearch' } } }),
    // 比例参数是 image mode 的窄能力，必须既拒绝未知比例，也拒绝和 auto 这类文本模式显式混用。
    JSON.stringify({ jsonrpc: '2.0', id: 'ask-bad-ratio', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', imageAspectRatio: 'cinema' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 'ask-ratio-mode-conflict', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', mode: 'auto', imageAspectRatio: 'wide' } } }),
  ]);
  assert.ok(responses.every(item => item.result?.isError));
  assert.match(responses.find(item => item.id === 'ask-extra').result.content[0].text, /Unknown ask argument/);
  assert.match(responses.find(item => item.id === 'ask-bad-file').result.content[0].text, /absolute path/);
  assert.match(responses.find(item => item.id === 'ask-bad-mode').result.content[0].text, /mode must be one of/);
  assert.match(responses.find(item => item.id === 'ask-search-mode').result.content[0].text, /mode must be one of/);
  assert.match(responses.find(item => item.id === 'ask-deep-research-mode').result.content[0].text, /mode must be one of/);
  assert.match(responses.find(item => item.id === 'ask-bad-ratio').result.content[0].text, /imageAspectRatio must be one of/);
  assert.match(responses.find(item => item.id === 'ask-ratio-mode-conflict').result.content[0].text, /imageAspectRatio requires mode=image/);
}

function testTranscribeFileCliValidation() {
  // CLI 校验必须早于 daemon 启动：缺少 --file 或文件不存在时不能打开浏览器，也不能触碰 MCP tools。
  const missingFlag = spawnSync(process.execPath, ['chatgpt.js', 'transcribe-file', '--json'], {
    encoding: 'utf8',
    timeout: 5000,
    env: BASE_ENV,
    windowsHide: true,
  });
  assert.notStrictEqual(missingFlag.status, 0);
  assert.match(missingFlag.stderr, /--file/);

  const missingFile = spawnSync(process.execPath, ['chatgpt.js', 'transcribe-file', '--file', path.join(os.tmpdir(), 'missing voice.wav'), '--json'], {
    encoding: 'utf8',
    timeout: 5000,
    env: BASE_ENV,
    windowsHide: true,
  });
  assert.notStrictEqual(missingFile.status, 0);
  assert.match(missingFile.stderr, /Voice file does not exist/);
}

function testVoiceFileSymlinkedDirAccepted() {
  // macOS 上 /var 是 /private/var 的符号链接；os.tmpdir() 返回 /var/...，
  // 但 fs.realpathSync.native 返回 /private/var/...。
  // 通过测试专用 seam 直接调用生产 validateVoiceInput；加载 core 不会启动 daemon 或浏览器。
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-real-'));
  // 用目录链接模拟 macOS /var → /private/var；Windows 使用 junction 避免管理员权限要求。
  const linkDir = path.join(path.dirname(realDir), 'chatgpt-symlink-' + path.basename(realDir));
  try {
    fs.symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    const voiceFile = path.join(linkDir, 'voice.wav');
    writeTinyWav(voiceFile);
    const script = `
      const assert = require('assert');
      const { validateVoiceInput } = require('./chatgpt-core').testing;
      const fs = require('fs');
      const result = validateVoiceInput(${JSON.stringify({ file: voiceFile })});
      assert.strictEqual(result.file, fs.realpathSync.native(${JSON.stringify(voiceFile)}));
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      env: { ...BASE_ENV, CHATGPT_TEST_HOOKS: '1', CHATGPT_VOICE_FILE_ROOTS: linkDir, CHATGPT_STATE_DIR: path.join(realDir, 'state'), CHATGPT_SESSION_DIR: path.join(realDir, 'sessions') },
    });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  } finally {
    try { fs.unlinkSync(linkDir); } catch {}
    fs.rmSync(realDir, { recursive: true, force: true });
  }
}

async function testDirectVoiceTranscribeSkipsComposerWait() {
  // direct upload 只需要同源登录态和 /backend-api/transcribe；成功路径不能再等待 composer 或安装 fake mic。
  // 这个测试用 fake page 观察 adapter 的公开行为，不启动浏览器，也不依赖 ChatGPT 真实 DOM。
  const { createChatGPTDom } = require('./chatgpt-dom');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-direct-voice-'));
  const voice = path.join(dir, 'voice with spaces.wav');
  const projectUrl = 'https://chatgpt.com/g/g-p-test-project/project';
  const calls = { goto: [], waitForSelector: 0, evaluateOnNewDocument: 0, evaluate: 0 };
  writeTinyWav(voice);
  try {
    const page = {
      bringToFront: async () => {},
      // goto 仅记录 fallback 导航；direct 成功必须完全不触碰页面路由。
      goto: async url => { calls.goto.push(url); },
      waitForSelector: async () => {
        calls.waitForSelector++;
        throw new Error('direct voice transcription should not wait for composer');
      },
      // direct 成功路径不应安装 getUserMedia patch；一旦调用这里就说明又退回了 fake mic 语义。
      evaluateOnNewDocument: async () => { calls.evaluateOnNewDocument++; },
      evaluate: async (_fn, config) => {
        calls.evaluate++;
        // direct upload 的唯一 page.evaluate 输入应包含音频 bytes 配置；其它 evaluate 代表意外触碰 DOM fallback。
        if (config?.audioBase64) return { text: 'direct transcript', elapsedMs: 7 };
        throw new Error('unexpected page.evaluate before direct upload');
      },
    };
    const text = await createChatGPTDom({ responseTimeout: 1000 }).transcribeAudioFile(page, voice, projectUrl, () => {});
    assert.strictEqual(text, 'direct transcript');
    // direct path 成功时不应触发 goto 导航(直接返回文本,不进入 fallback)
    assert.deepStrictEqual(calls.goto, []);
    // composer wait 和 fake mic 都是 fallback-only 行为；direct 成功时必须保持为零以避免固定 3 秒浪费。
    assert.strictEqual(calls.waitForSelector, 0);
    assert.strictEqual(calls.evaluateOnNewDocument, 0);

    // 外来 origin 必须在页面 evaluate 内拒绝，不能先读取 token 或 POST 音频后再依赖 Node 的旧 page.url 快照。
    await withBrowserPage('voice origin guard', 'chatgpt-voice-origin-', async page => {
      await page.setRequestInterception(true);
      let requests = 0;
      page.on('request', request => { requests++; request.abort(); });
      await page.setContent('<html><body>foreign page</body></html>');
      await assert.rejects(() => createChatGPTDom({ responseTimeout: 1_000 }).transcribeAudioFile(page, voice, 'https://chatgpt.com', () => {}), /official ChatGPT origin/);
      assert.strictEqual(requests, 0, 'origin guard must reject before session fetch or fallback navigation');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testOversizedLineRecovery() {
  // 同一个 stdin chunk 里，超大坏行后面的合法消息仍要继续处理；否则一次坏请求会污染后续 MCP 流。
  // 这个用例直接压低 cap，模拟大 prompt 触达 wrapper 的边界，而不需要真的构造 25 MiB 输入。
  const responses = runServer([
    'x'.repeat(300),
    JSON.stringify({ jsonrpc: '2.0', id: 'after-oversize', method: 'ping' }),
  ], { CHATGPT_MCP_STDIN_LINE_MAX_BYTES: '64' });
  assert.ok(responses.some(item => item.id === null && item.error?.code === -32700));
  assert.ok(responses.some(item => item.id === 'after-oversize' && item.result));
}

function testExistingSessionIndexStartup() {
  // core 模块加载时会迁移/压缩 sessions.json；这里放一个旧索引，覆盖真实用户“已有会话后重启”的路径。
  // 这类 bug 不会经过 MCP stdio，必须单独 require core 才能触发启动期 registry 初始化。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-mcp-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ sessions: { '#abc1230000': { updatedAt: new Date().toISOString() } } }), 'utf8');
    const child = spawnSync(process.execPath, ['-e', "require('./chatgpt-core')"], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...BASE_ENV, CHATGPT_SESSION_DIR: dir, CHATGPT_STATE_DIR: path.join(dir, 'state') },
      windowsHide: true,
    });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testStatusReportsDisconnectedBrowser() {
  // status 是诊断入口：即使 fake daemon 声明 browser 已断开，也只能展示状态，不能触发 stop 或重启。
  const fixture = await withFakeDaemon({ browserConnected: false });
  try {
    // --status 不带 prompt/file，验证它不会因为 browser 断开而改变 daemon 生命周期。
    const result = await runChatgptCLI(['--status'], fixture.env);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Browser: disconnected/);
    assert.strictEqual(fixture.calls.stop, 0, 'status must remain read-only when browser is disconnected');
  } finally {
    await fixture.close();
  }
}

async function testVoiceSkipsStaleBrowserDaemon() {
  // voice 没有 prompt 提交副作用；这里固定它遇到 stale daemon 时先淘汰旧实例，而不是调用旧 /voice endpoint。
  const fixture = await withFakeDaemon({ browserConnected: false });
  // 文件名保留空格、$、&、分号和括号，覆盖 Windows 合法路径里的 shell 特殊字符不会被拼成命令语法。
  const voice = path.join(fixture.dir, 'voice with spaces & symbols $HOME (semi;colon).wav');
  writeTinyWav(voice);
  try {
    // 缺失浏览器路径让替代 daemon 启动确定失败；这样测试只验证“先淘汰旧 daemon”，不依赖真实 Edge。
    const result = await runChatgptCLI(['transcribe-file', '--file', voice, '--json'], {
      ...fixture.env,
      CHATGPT_BROWSER_PATH: path.join(fixture.dir, 'missing browser.exe'),
      CHATGPT_DAEMON_START_TIMEOUT_MS: '1500',
    }, 6000);
    assert.notStrictEqual(result.status, 0);
    // 失败来自“尝试启动替代 daemon 失败”，而不是旧 daemon 执行了转写请求。
    assert.strictEqual(fixture.calls.voice, 0, 'stale browser daemon must not receive the voice request');
    assert.strictEqual(fixture.calls.stop, 1, 'stale browser daemon should be stopped before starting a replacement');
  } finally {
    await fixture.close();
  }
}

async function testAskSkipsStaleBrowserDaemon() {
  // ask 比 voice 风险更高：stale 检查必须发生在发送 prompt 之前，避免把用户输入交给已断开 browser 的旧 daemon。
  const fixture = await withFakeDaemon({ browserConnected: false });
  try {
    // 使用 --raw 避免输出包装影响断言；测试只关心旧 daemon 是否收到 /ask。
    const result = await runChatgptCLI(['--raw', 'hello from stale browser test'], {
      ...fixture.env,
      CHATGPT_BROWSER_PATH: path.join(fixture.dir, 'missing browser.exe'),
      CHATGPT_DAEMON_START_TIMEOUT_MS: '1500',
    }, 6000);
    assert.notStrictEqual(result.status, 0);
    // 失败来自“尝试启动替代 daemon 失败”，而不是旧 daemon 收到了 prompt。
    assert.strictEqual(fixture.calls.ask, 0, 'stale browser daemon must not receive the ask request');
    assert.strictEqual(fixture.calls.stop, 1, 'stale browser daemon should be stopped before starting a replacement');
  } finally {
    await fixture.close();
  }
}

function runChatgptCLI(args, env, timeout = 5000) {
  // 通过真实 CLI 子进程测试行为，而不是 import 私有函数；这样能覆盖 daemon.json、argv 和本地 HTTP 的完整边界。
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['chatgpt.js', ...args], {
      // 子进程继承测试专用 env，确保 daemon.json、sessions 和 workspace root 都落在临时目录。
      encoding: 'utf8',
      env: { ...BASE_ENV, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      // 超时说明 CLI 卡在启动/HTTP 边界；直接 kill child，避免测试进程留下悬挂子进程。
      child.kill();
      reject(new Error(`chatgpt.js timed out: ${args.join(' ')}`));
    }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => {
      // spawn 失败属于本地 CLI 启动问题；测试直接 reject，避免把它误判成 daemon health 行为。
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', status => {
      // 只把 stdout/stderr 交给具体用例断言；helper 不解释业务错误，保持黑盒测试语义。
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function withFakeDaemon(options) {
  // 每个用例独占 state dir 和 HTTP 端口，避免真实用户 daemon 或其它测试进程影响 browser health 判断。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-daemon-health-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const calls = { stop: 0, voice: 0, ask: 0 };
  // token/daemonID 是本地 daemon 协议的两个不同边界：ping 只看 daemonID，其它请求必须带 bearer token。
  const token = 'test-token';
  const daemonID = 'test-daemon';
  const server = http.createServer((req, res) => {
    // fake daemon 只模拟 CLI 可观察 HTTP 行为，不启动浏览器；测试目标是 stale daemon 选择，而不是 Puppeteer。
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url?.startsWith('/ping')) return send(req.url.includes(daemonID) ? 200 : 404, { ok: req.url.includes(daemonID) });
    // 除 /ping 外都要求 bearer token，覆盖 CLI 不会把 token 误发给错误 daemonID 的本地端口。
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, error: 'Unauthorized daemon request' });
    // /status 是唯一带 bearer 的 browser health 来源；fake daemon 用它模拟“HTTP 活着但 browser 已关”的真实故障。
    if (req.method === 'GET' && req.url === '/status') return send(200, { ok: true, pid: process.pid, daemonID, project: 'MCP', pageCount: 0, pendingPageCount: 0, activeLocks: 0, maxPages: 8, browserConnected: options.browserConnected });
    if (req.method === 'POST' && req.url === '/stop') {
      // stop 计数证明 CLI 选择淘汰 stale daemon；fake daemon 不退出，让测试能在同一进程中断言调用次数。
      calls.stop++;
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/voice/transcribe-file') {
      // 如果这里被调用，说明 CLI 复用了 browser 已断开的旧 daemon，测试必须失败。
      calls.voice++;
      return send(500, { ok: false, error: 'stale voice endpoint called' });
    }
    if (req.method === 'POST' && req.url === '/ask') {
      // ask 计数固定防回归：stale browser 不允许拿到用户 prompt，即使 fake daemon 还能 HTTP 响应。
      calls.ask++;
      return send(500, { ok: false, error: 'stale ask endpoint called' });
    }
    send(404, { ok: false, error: 'Not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // 写入真实 daemon.json 形状，黑盒覆盖 chatgpt.js 的 readDaemonState 和 HTTP 调用路径。
  const state = { port: server.address().port, pid: process.pid, token, daemonID, version: currentDaemonVersion() };
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  return {
    dir,
    calls,
    env: {
      // state/session/workspace 全部隔离到临时目录，避免测试触碰用户真实 browser-agent daemon。
      CHATGPT_STATE_DIR: dir,
      CHATGPT_SESSION_DIR: path.join(dir, 'sessions'),
      CHATGPT_WORKSPACE_DIR: process.cwd(),
      CHATGPT_WORKSPACE_ROOTS: process.cwd(),
    },
    close: async () => {
      // 先关 HTTP server 再删目录，避免 Windows 下端口回调还在读 daemon.json 时目录已被移除。
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function currentDaemonVersion() {
  // daemon.json 的 version 必须匹配当前 CLI 协议；否则测试会走版本升级路径，掩盖 browser health 行为。
  // 从源码读取常量比在测试里复制数字更稳，避免 bump 版本后测试夹具忘记同步。
  return Number(fs.readFileSync(path.join(__dirname, 'chatgpt.js'), 'utf8').match(/const DAEMON_VERSION = (\d+)/)?.[1]);
}

function writeTinyWav(file) {
  // CLI 只要求 WAV 头通过本地校验；空 data chunk 足够测试 daemon health，不需要真实音频内容。
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(0, 40);
  fs.writeFileSync(file, buffer);
}

// 验证 shouldCancel=true 时 transcribeAudioFile 不进入 fallback,直接抛出取消错误。
// 场景:TUI 发起转录后 0.5s 撤销,daemon 不应进入 ~90s 的听写 UI fallback。
async function testTranscribeShouldCancelBeforeFallback() {
  const { createChatGPTDom } = require('./chatgpt-dom');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-voice-cancel-'));
  const voice = path.join(dir, 'voice.wav');
  writeTinyWav(voice);
  try {
    // direct path 失败(模拟 HTTP 错误),shouldCancel 返回 true → 应在 fallback 前抛出
    const page = {
      bringToFront: async () => {},
      goto: async () => {},
      waitForSelector: async () => { throw new Error('should not reach fallback'); },
      evaluateOnNewDocument: async () => {},
      evaluate: async (_fn, config) => {
        if (config?.audioBase64) throw new Error('HTTP 500: simulated direct path failure');
        throw new Error('unexpected evaluate');
      },
    };
    let fallbackStarted = false;
    const dom = createChatGPTDom({ responseTimeout: 1_000 });
    let threw = false;
    try {
      await dom.transcribeAudioFile(page, voice, 'https://chatgpt.com/', () => {}, () => true, () => { fallbackStarted = true; });
    } catch (err) {
      threw = true;
      // 取消错误必须包含 "cancelled" 关键词,与 runVoiceTranscribe 的 catch 模式匹配
      assert.ok(/cancelled/i.test(err.message), `expected cancel error, got: ${err.message}`);
    }
    assert.ok(threw, 'shouldCancel=true must throw before fallback');
    assert.ok(!fallbackStarted, 'onFallbackStart must NOT be called when shouldCancel=true');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 验证 onFallbackStart 回调在 direct path 失败后、fallback 开始前被调用。
// 场景:voice fallback 需要独占前台,onFallbackStart 通知 caller 让 ask foregroundPulse 跳过。
async function testTranscribeOnFallbackStartCalled() {
  const { createChatGPTDom } = require('./chatgpt-dom');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-voice-fallback-'));
  const voice = path.join(dir, 'voice.wav');
  writeTinyWav(voice);
  try {
    let fallbackStarted = false;
    let navigatedTo = null;
    const page = {
      bringToFront: async () => {},
      url: () => 'https://chatgpt.com.evil.example/',
      goto: async url => { navigatedTo = url; },
      waitForSelector: async () => {},
      evaluateOnNewDocument: async () => {},
      evaluate: async (_fn, config) => {
        if (config?.audioBase64) throw new Error('HTTP 500: simulated direct path failure');
        // fallback 路径的 evaluate 调用:返回足够数据让测试验证 onFallbackStart 被调用
        return { index: 0, label: 'dictation' };
      },
    };
    const dom = createChatGPTDom({ responseTimeout: 1_000 });
    try {
      // shouldCancel=false 让 fallback 路径执行;onFallbackStart 记录调用
      await dom.transcribeAudioFile(page, voice, 'https://chatgpt.com/', () => {}, () => false, () => { fallbackStarted = true; });
    } catch {
      // fallback 内部可能因 fake page 抛出,不影响 onFallbackStart 验证
    }
    assert.ok(fallbackStarted, 'onFallbackStart must be called when direct path fails and fallback begins');
    assert.strictEqual(navigatedTo, 'https://chatgpt.com/', 'fallback must leave a lookalike origin before touching dictation controls');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testEmptyAssistantTurnCompletes() {
  // Deep Research 可能只留下新的“ChatGPT 说：”空 turn；正常等待必须完成，不能挂到外层超时后再靠 recovery。
  const { createChatGPTDom } = require('./chatgpt-dom');
  await withBrowserPage('empty assistant completion', 'chatgpt-empty-assistant-', async page => {
    await page.setContent('<main id="fixture"><div data-testid="conversation-turn-1"><div data-message-author-role="user">old question</div></div><div data-testid="conversation-turn-2">ChatGPT 说：</div></main>');
    const dom = createChatGPTDom({ responseTimeout: 5_000 });
    const before = await dom.state(page);
    await page.evaluate(() => setTimeout(() => {
      document.querySelector('#fixture').insertAdjacentHTML('beforeend', '<div data-testid="conversation-turn-3"><div data-message-author-role="user">question</div></div><div data-testid="conversation-turn-4">ChatGPT 说：</div>');
    }, 100));
    const result = await dom.waitForResponse(page, before, {}, () => {});
    assert.strictEqual(result.status, 'completed');
    await page.setContent('<div data-testid="conversation-turn-1"><div data-message-author-role="user">ChatGPT said:</div></div>');
    assert.strictEqual((await dom.state(page)).emptyAssistantTurn, false, 'a user prompt matching the empty heading must not complete its own turn');
  });
}

async function testForegroundPulseInterval8s() {
  // 后台 hydration 健康维持必须保留 8 秒节奏；滚动断言走公开 waitForResponse seam，避免绑定私有 helper。
  const { createChatGPTDom } = require('./chatgpt-dom');
  await withBrowserPage('foreground pulse', 'chatgpt-foreground-pulse-', async page => {
    // 当前 ChatGPT 的 main 只承载布局；中间 auto wrapper 不溢出，防止仅凭 CSS 误选非滚动祖先。
    await page.setContent(`
      <style>
        #scroll-root { height: 240px; overflow-y: auto; }
        #non-scrolling-auto { overflow-y: auto; }
        #fixture { overflow: visible; }
        .history-turn { height: 420px; }
        .current-user { height: 300px; }
        .current-answer { height: 320px; }
        .turn-tail { height: 174px; }
      </style>
      <div id="scroll-root"><div id="non-scrolling-auto"><main id="fixture"><div id="thread">
        <section class="history-turn" data-testid="conversation-turn-1"><div data-message-author-role="user">old question</div></section>
        <section class="history-turn" data-testid="conversation-turn-2"><div data-message-author-role="assistant">old answer</div></section>
        <section class="current-user" data-testid="conversation-turn-3"><div data-message-author-role="user">question</div></section>
      </div></main></div></div>
    `);
    await page.evaluate(() => setTimeout(() => {
      // 提前一秒插入，保证第二次 8 秒 pulse 看见新回答，避免把调度抖动误判成滚动失败。
      document.querySelector('#thread').insertAdjacentHTML('beforeend', '<section data-testid="conversation-turn-4"><div class="current-answer" data-message-author-role="assistant">answer<button aria-label="Copy">Copy</button></div><div class="turn-tail"></div></section>');
    }, 7_000));
    let frontCount = 0;
    const bringToFront = page.bringToFront.bind(page);
    page.bringToFront = async () => { frontCount++; return bringToFront(); };
    const startedAt = Date.now();
    const result = await createChatGPTDom({ responseTimeout: 15_000 }).waitForResponse(page, {
      count: 1, userCount: 1, turnCount: 2, lastText: 'old answer', nativeImageCount: 0,
    }, { foregroundPulseMs: 8_000 }, () => {});
    assert.strictEqual(result.status, 'completed');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 8_000 && elapsed < 12_500, `rendered completion controls should avoid the generic quiet delay: ${elapsed}`);
    assert.strictEqual(frontCount, 2);
    // assistant 后仍有 action/footer 空间；只有真实 conversation scroll root 到底时 gap 才为零。
    const bottomGap = await page.$eval('#scroll-root', element => element.scrollHeight - element.scrollTop - element.clientHeight);
    assert.ok(bottomGap <= 1, `foreground pulse must reach the conversation bottom: gap=${bottomGap}`);
  });
}

// 验证 voice cancel 后 daemon 的 send 函数不在已关闭的 res 上崩溃。
// 场景:TUI 发起 voice → 取消 → res.on('close') 触发 → runVoiceTranscribe throw
// → catch 调 send(500,...) → send 必须在 res.destroyed/writableEnded 时静默返回。
// 修复前:send 调 res.writeHead() 抛异常 → daemon 崩溃 → voiceLock 永不释放 → 后续请求永久阻塞。
async function testVoiceCancelSendSafeOnClosedRes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-send-json-'));
  const script = `
    const assert = require('assert');
    const { sendJSON } = require('./chatgpt-core').testing;
    const closed = { destroyed: true, writableEnded: false, writeHead() { throw new Error('must not write'); }, end() { throw new Error('must not end'); } };
    assert.strictEqual(sendJSON(closed, 500, { error: 'cancelled' }), false);
    const calls = [];
    const open = { destroyed: false, writableEnded: false, writeHead(...args) { calls.push(['head', ...args]); }, end(value) { calls.push(['end', value]); } };
    assert.strictEqual(sendJSON(open, 200, { ok: true }), true);
    assert.deepStrictEqual(JSON.parse(calls[1][1]), { ok: true });
  `;
  try {
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      env: { ...BASE_ENV, CHATGPT_TEST_HOOKS: '1', CHATGPT_STATE_DIR: path.join(dir, 'state'), CHATGPT_SESSION_DIR: path.join(dir, 'sessions') },
    });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
