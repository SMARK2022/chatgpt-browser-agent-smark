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
    ['testDirectVoiceUsesBootstrapAuth', () => testDirectVoiceUsesBootstrapAuth(), false],
    ['testSessionPageFactUsesBootstrapAuth', () => testSessionPageFactUsesBootstrapAuth(), false],
    ['testOversizedLineRecovery', () => testOversizedLineRecovery(), false],
    ['testExistingSessionIndexStartup', () => testExistingSessionIndexStartup(), false],
    ['testStatusReportsDisconnectedBrowser', () => testStatusReportsDisconnectedBrowser(), false],
    ['testVoiceSkipsStaleBrowserDaemon', () => testVoiceSkipsStaleBrowserDaemon(), false],
    ['testVoiceDoesNotRetryAfterBrowserDisconnect', () => testVoiceDoesNotRetryAfterBrowserDisconnect(), false],
    ['testOwnedBrowserDisconnectLifecycle', () => testOwnedBrowserDisconnectLifecycle(), false],
    ['testAskSkipsStaleBrowserDaemon', () => testAskSkipsStaleBrowserDaemon(), false],
    ['testLoginRequiredMarkerNotTreatedAsStartupError', () => testLoginRequiredMarkerNotTreatedAsStartupError(), false],
    ['testLoginWaitTimeoutErrorDetected', () => testLoginWaitTimeoutErrorDetected(), false],
    ['testSessionIDValidationRejection', () => testSessionIDValidationRejection(), false],
    ['testFileUploadRejectsOutsideAllowlist', () => testFileUploadRejectsOutsideAllowlist(), false],
    ['testFileUploadRejectsDuplicateBasenames', () => testFileUploadRejectsDuplicateBasenames(), false],
    ['testCliUploadPathPolicy', () => testCliUploadPathPolicy(), false],
    ['testCoreUploadPathPolicy', () => testCoreUploadPathPolicy(), false],
    ['testStopWithoutActiveAsk', () => testStopWithoutActiveAsk(), false],
    ['testProjectIdentityPolicy', () => testProjectIdentityPolicy(), false],
    ['testCoreProjectStateMachine', () => testCoreProjectStateMachine(), false],
    ['testVoiceLeaseWaitsForProjectSubmission', () => testVoiceLeaseWaitsForProjectSubmission(), false],
    ['testProjectPinUsesSingleRecoveryChain', () => testProjectPinUsesSingleRecoveryChain(), false],
    ['testProjectCacheRetainsTransientValidation', () => testProjectCacheRetainsTransientValidation(), false],
    ['testProjectCacheReplacesProvenStale', () => testProjectCacheReplacesProvenStale(), false],
    ['testVoiceStartupSkipsProject', () => testVoiceStartupSkipsProject(), false],
    ['testStartupRecoversMixedLoginOnce', () => testStartupRecoversMixedLoginOnce(), false],
    ['testLazyProjectInitializationSingleFlight', () => testLazyProjectInitializationSingleFlight(), false],
    ['testExistingSessionSkipsDefaultProjectInitialization', () => testExistingSessionSkipsDefaultProjectInitialization(), false],
    ['testQueuedVoiceCancelHasZeroSideEffects', () => testQueuedVoiceCancelHasZeroSideEffects(), false],
    ['testVoiceTaskLifecycle', () => testVoiceTaskLifecycle(), false],
    ['testFreshVoicePageWaitsForConvergence', () => testFreshVoicePageWaitsForConvergence(), false],
    ['testVoiceAndAskSerializeRemoteSubmission', () => testVoiceAndAskSerializeRemoteSubmission(), false],
    ['testBorrowedVoiceStablePreflightRenewsOnce', () => testBorrowedVoiceStablePreflightRenewsOnce(), false],
    ['testVoiceStablePreflightRejectsLoggedOutPage', () => testVoiceStablePreflightRejectsLoggedOutPage(), false],
    ['testVoiceStatusCounts', () => testVoiceStatusCounts(), false],
    ['testVoiceDeadlineAndForeground', () => testVoiceDeadlineAndForeground(), false],
    ['testProjectDiscoveryCollectsDistinctProjectLinks', () => testProjectDiscoveryCollectsDistinctProjectLinks(), false],
    ['testProjectHomeDiscoveryUsesLiveSidebar', () => testProjectHomeDiscoveryUsesLiveSidebar(), false],
    ['testSubmitUsesTrustedClick', () => testSubmitUsesTrustedClick(), false],
    ['testFileUploadUsesStableLocalCopy', () => testFileUploadUsesStableLocalCopy(), false],
    ['testImageModeUsesCurrentComposerMenu', () => testImageModeUsesCurrentComposerMenu(), false],
    ['testTableCitationExtraction', () => testTableCitationExtraction(), false],
    ['testSandboxArtifactPreviewDownload', () => testSandboxArtifactPreviewDownload(), false],
    ['testVoicePageHealthCheck', () => testVoicePageHealthCheck(), false],
    // 验证 voice cancel 后 send 不在已关闭 res 上崩溃,daemon 仍存活
    ['testVoiceCancelSendSafeOnClosedRes', () => testVoiceCancelSendSafeOnClosedRes(), false],
    ['testTranscribeCancelDoesNotStartAnotherPath', () => testTranscribeCancelDoesNotStartAnotherPath(), false],
    ['testDirectVoiceSubmitsOnce', () => testDirectVoiceSubmitsOnce(), false],
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
  // 显式 root 是 opt-in 收窄策略；只创建该 root，不能偷偷依赖默认 staging 目录。
  fs.mkdirSync(allowed);
  const outsideFile = path.join(os.tmpdir(), `outside-allowlist-${crypto.randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(outsideFile, 'should be rejected');
  try {
    const responses = runServer([
      JSON.stringify({ jsonrpc: '2.0', id: 'upload-outside', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'test', file: outsideFile } } }),
    ], { CHATGPT_WORKSPACE_DIR: workspace, CHATGPT_WORKSPACE_ROOTS: workspace, CHATGPT_UPLOAD_ROOTS: allowed });
    const result = responses.find(item => item.id === 'upload-outside');
    assert.ok(result.result?.isError, 'file outside allowlist must return tool error');
    assert.match(result.result.content[0].text, /outside.*root|allowed.*root/i);
    const missingResponses = runServer([
      JSON.stringify({ jsonrpc: '2.0', id: 'missing-root', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'test', file: outsideFile } } }),
    ], { CHATGPT_WORKSPACE_DIR: workspace, CHATGPT_WORKSPACE_ROOTS: workspace, CHATGPT_UPLOAD_ROOTS: path.join(workspace, 'missing-root') });
    assert.match(missingResponses.find(item => item.id === 'missing-root').result.content[0].text, /upload root does not exist/i);
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
  // 未显式配置 root 时，Project cache 外的绝对路径也应进入后续安全校验，而不是要求预建 staging 目录。
  fs.mkdirSync(path.join(uploadDir, 'sub'), { recursive: true });
  const fileA = path.join(uploadDir, 'dup-name.txt');
  const fileB = path.join(uploadDir, 'sub', 'dup-name.txt');
  fs.writeFileSync(fileA, 'A');
  fs.writeFileSync(fileB, 'B');
  try {
    const responses = runServer([
      JSON.stringify({ jsonrpc: '2.0', id: 'dup-basenames', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'test', file: [fileA, fileB] } } }),
    ], { CHATGPT_WORKSPACE_DIR: workspace, CHATGPT_WORKSPACE_ROOTS: workspace });
    const result = responses.find(item => item.id === 'dup-basenames');
    assert.ok(result.result?.isError, 'duplicate basenames must return tool error');
    assert.match(result.result.content[0].text, /basename|distinct/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function testCliUploadPathPolicy() {
  // 公开 CLI 必须在启动 daemon 前完成路径校验，因此本测试不会打开浏览器或发送 prompt。
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-cli-upload-policy-'));
  const firstDir = path.join(workspace, 'first');
  const secondDir = path.join(workspace, 'second');
  const allowed = path.join(workspace, 'allowed');
  fs.mkdirSync(firstDir);
  fs.mkdirSync(secondDir);
  fs.mkdirSync(allowed);
  const first = path.join(firstDir, 'same.zip');
  const second = path.join(secondDir, 'same.zip');
  const outside = path.join(workspace, 'outside.zip');
  const text = path.join(workspace, 'notes.txt');
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(second, 'second');
  fs.writeFileSync(outside, 'outside');
  fs.writeFileSync(text, 'notes');
  const env = { CHATGPT_WORKSPACE_DIR: workspace, CHATGPT_WORKSPACE_ROOTS: workspace, CHATGPT_UPLOAD_ROOTS: '', CHATGPT_STATE_DIR: path.join(workspace, 'state'), CHATGPT_SESSION_DIR: path.join(workspace, 'sessions') };
  try {
    // cache 外文件先通过 unrestricted 路径策略，再由仍然保留的 basename 约束拒绝。
    const unrestricted = await runChatgptCLI(['--raw', '--upload', first, '--upload', second, 'test'], env);
    assert.notStrictEqual(unrestricted.status, 0);
    assert.match(unrestricted.stderr, /basename|distinct/i);
    const restricted = await runChatgptCLI(['--raw', '--upload', outside, 'test'], { ...env, CHATGPT_UPLOAD_ROOTS: allowed });
    assert.notStrictEqual(restricted.status, 0);
    assert.match(restricted.stderr, /outside allowed roots/i);
    const relativeUpload = await runChatgptCLI(['--raw', '--upload', 'relative.zip', 'test'], env);
    assert.match(relativeUpload.stderr, /path must be absolute/i);
    const relativeText = await runChatgptCLI(['--raw', '--file', 'relative.txt', 'test'], env);
    assert.match(relativeText.stderr, /path must be absolute/i);
    // --file 与 --upload 共用 unrestricted/显式 root 策略；用后续 duplicate 错误证明文本读取已通过。
    const unrestrictedText = await runChatgptCLI(['--raw', '--file', text, '--upload', first, '--upload', second, 'test'], env);
    assert.match(unrestrictedText.stderr, /basename|distinct/i);
    const allowedText = path.join(allowed, 'inside.txt');
    const allowedA = path.join(allowed, 'a');
    const allowedB = path.join(allowed, 'b');
    fs.mkdirSync(allowedA);
    fs.mkdirSync(allowedB);
    fs.writeFileSync(allowedText, 'inside');
    fs.writeFileSync(path.join(allowedA, 'same.zip'), 'a');
    fs.writeFileSync(path.join(allowedB, 'same.zip'), 'b');
    const restrictedText = await runChatgptCLI(['--raw', '--file', allowedText, '--upload', path.join(allowedA, 'same.zip'), '--upload', path.join(allowedB, 'same.zip'), 'test'], { ...env, CHATGPT_UPLOAD_ROOTS: allowed });
    assert.match(restrictedText.stderr, /basename|distinct/i);
    const outsideText = await runChatgptCLI(['--raw', '--file', text, 'test'], { ...env, CHATGPT_UPLOAD_ROOTS: allowed });
    assert.match(outsideText.stderr, /outside allowed roots/i);
    const missingTextRoot = await runChatgptCLI(['--raw', '--file', text, 'test'], { ...env, CHATGPT_UPLOAD_ROOTS: path.join(workspace, 'missing-root') });
    assert.match(missingTextRoot.stderr, /upload root does not exist/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function testCoreUploadPathPolicy() {
  // daemon HTTP 校验是绕过 MCP/CLI 时的最终边界，使用既有 test hook 直接验证，不创建 browser runtime。
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-core-upload-policy-'));
  const allowed = path.join(workspace, 'allowed');
  fs.mkdirSync(allowed);
  const inside = path.join(allowed, 'inside.zip');
  const outside = path.join(workspace, 'outside.zip');
  fs.writeFileSync(inside, 'inside');
  fs.writeFileSync(outside, 'outside');
  const script = String.raw`
    const assert = require('assert');
    const fs = require('fs');
    const { testing } = require('./chatgpt-core');
    const input = file => ({ fullPrompt: 'test', uploadPaths: [file], workspaceDir: process.env.FIXTURE_WORKSPACE });
    if (process.env.EXPECT_MISSING_ROOT) {
      assert.throws(() => testing.validateAskInput(input(process.env.FIXTURE_INSIDE)), /upload root does not exist/i);
      process.exit(0);
    }
    const accepted = testing.validateAskInput(input(process.env.FIXTURE_INSIDE));
    assert.strictEqual(accepted.uploadPaths[0], fs.realpathSync.native(process.env.FIXTURE_INSIDE));
    assert.throws(() => testing.validateAskInput(input('relative.zip')), /absolute/i);
    if (process.env.FIXTURE_OUTSIDE) assert.throws(() => testing.validateAskInput(input(process.env.FIXTURE_OUTSIDE)), /outside allowed roots/i);
  `;
  const run = env => spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    env: { ...BASE_ENV, CHATGPT_TEST_HOOKS: '1', CHATGPT_WORKSPACE_ROOTS: workspace, FIXTURE_WORKSPACE: workspace, FIXTURE_INSIDE: inside, ...env },
  });
  try {
    const unrestricted = run({ CHATGPT_UPLOAD_ROOTS: '' });
    assert.strictEqual(unrestricted.status, 0, unrestricted.stderr || unrestricted.stdout);
    const restricted = run({ CHATGPT_UPLOAD_ROOTS: allowed, FIXTURE_OUTSIDE: outside });
    assert.strictEqual(restricted.status, 0, restricted.stderr || restricted.stdout);
    const missing = run({ CHATGPT_UPLOAD_ROOTS: path.join(workspace, 'missing-root'), EXPECT_MISSING_ROOT: '1' });
    assert.strictEqual(missing.status, 0, missing.stderr || missing.stdout);
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

// Project身份测试固定URL、ID和名称三者的职责，避免DOM层自行猜测历史会话归属。
// 歧义和跨Project URL必须显式拒绝，不能为了继续ask回退到当前标签页。
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

// 该组合测试通过生产runAsk覆盖pending、replay、lost和URL漂移，不复制状态机分支。
// 每个故障注入都在DOM/文件外部边界，断言的是是否发送、恢复和落盘的用户行为。
// 计数器只辅助证明没有隐藏副作用，不能替代最终response和registry断言。
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
        return {
          url: () => current,
          goto: async target => { current = redirected || target; },
          waitForResponse: async predicate => {
            const response = { request: () => ({ method: () => 'POST' }), ok: () => true, url: () => 'https://chatgpt.com/backend-api/conversation/init' };
            return predicate(response) ? response : null;
          },
        };
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
        // 生产在稳定性失败时会关闭候选页；fixture必须保留这个真实生命周期原语，避免掩盖状态机断言。
        // login DOM事实是当前voice稳定性owner；旧status/authenticated字段不能再让fixture伪造已登录态。
        const voiceBootstrap = { url: () => 'https://chatgpt.com/', isClosed: () => false, evaluate: async () => ({ kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' }), close: async () => {} };
        const askCreated = { url: () => 'about:blank', isClosed: () => false, goto: async () => {}, close: async () => {} };
        const ownershipRuntime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => askCreated }, bootstrapPage: voiceBootstrap, project });
        const [voiceOwned, askOwned] = await Promise.all([ownershipRuntime.voicePage(), ownershipRuntime.pageFor('#ownership')]);
        assert.notStrictEqual(voiceOwned, askOwned, 'voice and ask must never drive the same page');

        // Project trusted input与target creation共享browser调度，但不能因此占用voice direct的submission顺序。
        // fixture保持第二个new Session的newPage未完成，验证cold Project只等待现有page-creation边界。
        let allocationActive = false;
        let initializerOverlappedAllocation = false;
        let releaseAllocation;
        let markAllocationStarted;
        const allocationStarted = new Promise(resolve => { markAllocationStarted = resolve; });
        const allocationPage = { url: () => 'about:blank', isClosed: () => false, close: async () => {} };
        const allocationRuntime = testing.createDaemonRuntime({
          browser: {
            isConnected: () => true,
            newPage: async () => {
              allocationActive = true;
              markAllocationStarted();
              await new Promise(resolve => { releaseAllocation = resolve; });
              allocationActive = false;
              return allocationPage;
            },
          },
          bootstrapPage: voiceBootstrap,
          project: null,
          initializeProject: async () => {
            initializerOverlappedAllocation = allocationActive;
            return project;
          },
        });
        const projectPage = await allocationRuntime.pageFor('#allocation-first');
        const allocatingPage = allocationRuntime.pageFor('#allocation-second');
        await allocationStarted;
        const initializedProject = allocationRuntime.ensureProject(projectPage, () => {});
        await new Promise(resolve => setImmediate(resolve));
        releaseAllocation();
        await Promise.all([allocatingPage, initializedProject]);
        assert.strictEqual(initializerOverlappedAllocation, false, 'Project initialization must wait for new Session target allocation');

        // cold Project导航与voice direct必须共享远端副作用队列；否则另页可信click会与Runtime.callFunctionOn重叠并卡住first ask。
        let remoteActive = 0;
        let maxRemoteActive = 0;
        let initializerStarted = false;
        let releaseVoice;
        let markVoiceStarted;
        const voiceStarted = new Promise(resolve => { markVoiceStarted = resolve; });
        const contentionRuntime = testing.createDaemonRuntime({
          browser: { isConnected: () => true, newPage: async () => askCreated },
          bootstrapPage: voiceBootstrap,
          project: null,
          initializeProject: async () => {
            initializerStarted = true;
            remoteActive++;
            maxRemoteActive = Math.max(maxRemoteActive, remoteActive);
            remoteActive--;
            return project;
          },
        });
        const voiceSubmission = contentionRuntime.withSubmission(async () => {
          remoteActive++;
          maxRemoteActive = Math.max(maxRemoteActive, remoteActive);
          markVoiceStarted();
          await new Promise(resolve => { releaseVoice = resolve; });
          remoteActive--;
        });
        await voiceStarted;
        const firstProject = contentionRuntime.ensureProject({}, () => {});
        const secondProject = contentionRuntime.ensureProject({}, () => {});
        await Promise.resolve();
        assert.strictEqual(initializerStarted, false, 'cold Project initialization must wait behind an active voice submission');
        releaseVoice();
        const [firstProjectResult, secondProjectResult] = await Promise.all([firstProject, secondProject, voiceSubmission]).then(results => [results[0], results[1]]);
        assert.strictEqual(firstProjectResult, secondProjectResult, 'concurrent first asks must share one Project initialization result');
        assert.strictEqual(maxRemoteActive, 1, 'Project acquisition and voice submission must not overlap');

        // cache/currentProject 的 fresh goto 也必须等待同一 Project 初始化合同；否则 cold page 仍会在 init 未完成时进入后续 ask。
        const navigationPage = fakePage('about:blank');
        let initCompleted = false;
        const originalNavigateProjectHome = testing.dom.navigateProjectHome;
        const originalProjectHomeState = testing.dom.projectHomeState;
        testing.dom.navigateProjectHome = async (page, url) => {
          await page.goto(url);
          initCompleted = true;
        };
        testing.dom.projectHomeState = async page => ({ kind: 'readable', state: {
          url: page.url(), composer: true, title: true, titleName: 'MCP', chatActive: true, workActive: false,
        } });
        try {
          const navigated = await testing.ensureProjectHome(navigationPage, project, () => {});
          assert.strictEqual(navigated.url, project.url);
          assert.strictEqual(initCompleted, true, 'fresh Project navigation must complete init before validation returns');
        } finally {
          testing.dom.navigateProjectHome = originalNavigateProjectHome;
          testing.dom.projectHomeState = originalProjectHomeState;
        }

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
        let focusCalls = 0;
        let artifactBeforeState = null;
        let submitImpl = async (_page, _prompt, _files, _mode, _ratio, _log, _cancel, beforeSend) => {
          submitCalls++;
          beforeSend();
          return { ...idle };
        };
        let waitImpl = async () => ({ status: 'completed', reason: 'fixture' });
        Object.assign(testing.dom, {
          // 所有替换都挂到 core 实际持有的 adapter 对象，runAsk 调用的仍是生产状态机而非测试副本。
          state: async () => ({ ...state, url: askPage.url() }),
          focus: async () => { focusCalls++; },
          extractAssistant: async () => { extractCalls++; return state.lastText || ''; },
          collectArtifacts: async (_page, _dir, _log, _cancel, beforeState) => { artifactCalls++; artifactBeforeState = beforeState; return { downloads: [], notices: [] }; },
          projectHomeState: async () => ({ kind: 'readable', state: { url: askPage.url(), composer: true, title: true, titleName: 'MCP', chatActive: true, workActive: false } }),
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
        submitImpl = async (_page, _prompt, _files, _mode, _ratio, _log, _cancel, beforeSend) => {
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
        submitImpl = async (_page, _prompt, _files, _mode, _ratio, _log, _cancel, beforeSend) => {
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
        submitImpl = async (_page, _prompt, _files, _mode, _ratio, _log, _cancel, beforeSend) => {
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

        await testing.rememberCurrentSessionUrl(fakePage(scoped), project, '#client-close', () => {}, 1_000, false, scoped);
        askPage.current = scoped; state = { ...idle }; let clientClosed = false;
        submitImpl = async (_page, _prompt, _files, _mode, _ratio, _log, _cancel, beforeSend) => { beforeSend(); state = { ...idle, userCount: 2 }; clientClosed = true; return { ...idle }; };
        waitImpl = async () => ({ status: 'generating', reason: 'client-disconnected' });
        const focusBeforeClose = focusCalls; const artifactsBeforeClose = artifactCalls;
        const disconnected = await testing.runAsk(askRuntime, input('disconnect after click'), '#client-close', () => {}, () => clientClosed);
        assert.strictEqual(disconnected.status, 'generating'); assert.ok(testing.readSessionEntry('#client-close', project).pending);
        assert.deepStrictEqual([focusCalls, artifactCalls], [focusBeforeClose, artifactsBeforeClose], 'post-send disconnect must not regain foreground or collect artifacts');

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
        submitImpl = async (_page, _prompt, _files, _mode, _ratio, _log, _cancel, beforeSend) => {
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

function runCoreFixture(prefix, build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    const child = spawnSync(process.execPath, ['-e', build(dir)], { cwd: __dirname, encoding: 'utf8', timeout: 5_000, windowsHide: true, env: { ...BASE_ENV, CHATGPT_TEST_HOOKS: '1', CHATGPT_VOICE_FILE_ROOTS: dir, CHATGPT_STATE_DIR: dir, CHATGPT_SESSION_DIR: path.join(dir, 'sessions'), ...(prefix === 'chatgpt-voice-foreground-' ? { CHATGPT_VOICE_TRANSCRIBE_TIMEOUT_MS: '700' } : {}) } });
    assert.strictEqual(child.status, 0, child.error?.stack || child.stderr || child.stdout);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Project先进入submission queue时，voice的lease/preflight不能绕过队列先操作另一页。
// 该fixture只观察真实runVoiceRequest的页面事实和最终文本，不断言helper调用次数。
function testVoiceLeaseWaitsForProjectSubmission() {
  runCoreFixture('chatgpt-voice-project-queue-', dir => {
    const voice = path.join(dir, 'voice.wav'); writeTinyWav(voice);
    return String.raw`
      const assert = require('assert'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
      const project = policy.parse('g-p-queue123-mcp', 'MCP');
      const voicePage = { current: 'about:blank', url() { return this.current; }, isClosed: () => false, goto: async url => { voicePage.current = url; }, close: async () => {} };
      let projectStartedResolve, releaseProject;
      const projectStarted = new Promise(resolve => { projectStartedResolve = resolve; });
      const projectRelease = new Promise(resolve => { releaseProject = resolve; });
      let preflightStarted = false;
      const runtime = testing.createDaemonRuntime({
        browser: { isConnected: () => true, newPage: async () => voicePage },
        bootstrapPage: null,
        project: null,
        initializeProject: async () => { projectStartedResolve(); await projectRelease; return project; },
      });
      testing.dom.sessionPageFact = async () => { preflightStarted = true; return { kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' }; };
      testing.dom.transcribeAudioFile = async () => 'queued voice';
      (async () => {
        const projectPromise = runtime.ensureProject({}, () => {});
        await projectStarted;
        const voicePromise = testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false);
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(preflightStarted, false, 'voice lease must wait behind Project browser side effects');
        releaseProject();
        const [resolved, voice] = await Promise.all([projectPromise, voicePromise]);
        assert.strictEqual(resolved.id, project.id);
        assert.strictEqual(voice.text, 'queued voice');
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
  });
}

// 有效pin必须跳过sidebar探索，避免每次启动先加载错误Project再跳回目标页。
// 无效pin只允许进入现有唯一恢复链，不能叠加第二套缓存或导航算法。
function testProjectPinUsesSingleRecoveryChain() {
  runCoreFixture('chatgpt-project-pin-', () => String.raw`
      const assert = require('assert'), fs = require('fs'), path = require('path'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
      const pinned = policy.parse('g-p-pin123-mcp', 'MCP'); fs.writeFileSync(path.join(process.env.CHATGPT_STATE_DIR, 'projects.json'), JSON.stringify({ projects: { [pinned.id]: pinned, [pinned.token]: pinned, [pinned.key]: pinned } }));
      let sidebarCalls = 0; Object.assign(testing.dom, { discoverProjects: async () => [], openProjectHome: async () => { sidebarCalls++; return null; } }); // 有效pin必须在前置sidebar等待之前交给唯一ensure。
      (async () => {
        const selected = await testing.resolveProject({}, 'MCP', () => {});
        assert.strictEqual(selected.id, pinned.id); assert.strictEqual(sidebarCalls, 0, 'a valid exact-ID pin must skip the preliminary sidebar recovery');
        const replacement = policy.parse('g-p-new456-mcp', 'MCP'); let current = 'https://chatgpt.com/';
        const page = { url: () => current, goto: async url => { current = url === pinned.url ? 'https://chatgpt.com/' : url; }, waitForResponse: async predicate => {
          const response = { request: () => ({ method: () => 'POST' }), ok: () => true, url: () => 'https://chatgpt.com/backend-api/conversation/init' };
          return predicate(response) ? response : null;
        } };
        testing.dom.projectHomeState = async () => ({ kind: 'readable', state: { url: current, composer: true, title: true, titleName: 'MCP', chatActive: true, workActive: false } });
        // 连续两次官方root事实证明旧ID已失效；live sidebar随后给出可验证的新ID。
        testing.dom.openProjectHome = async () => { sidebarCalls++; current = replacement.url; return replacement.url; };
        const recovered = await testing.ensureProjectHome(page, pinned, () => {});
        assert.strictEqual(recovered.id, replacement.id); assert.strictEqual(sidebarCalls, 1, 'a stale pin must use the existing sidebar recovery only once');
        const cache = JSON.parse(fs.readFileSync(path.join(process.env.CHATGPT_STATE_DIR, 'projects.json'))).projects;
        assert.strictEqual(cache[pinned.id], undefined, 'stale exact-ID aliases must not survive recovery'); assert.strictEqual(cache[pinned.token], undefined, 'stale token aliases must not survive recovery');
        // cache-first只验证当前候选；清空cache后，live discovery仍必须拒绝同名不同ID。
        fs.writeFileSync(path.join(process.env.CHATGPT_STATE_DIR, 'projects.json'), JSON.stringify({ projects: {} }));
        testing.dom.discoverProjects = async () => [pinned, replacement].map(item => ({ href: item.url, name: 'MCP' }));
        await assert.rejects(() => testing.resolveProject({}, 'MCP', () => {}), /Multiple ChatGPT projects are named/);
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `);
}

// 页面暂时不可读不等于Project已删除；测试确保瞬态错误不会清除仍可复用的cache。
// 保留cache时也不能伪装验证成功，调用方必须收到可诊断失败而不是错误导航。
function testProjectCacheRetainsTransientValidation() {
  runCoreFixture('chatgpt-project-transient-', () => String.raw`
    const assert = require('assert'), fs = require('fs'), path = require('path'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
    const cached = policy.parse('g-p-cache123-mcp', 'MCP');
    const file = path.join(process.env.CHATGPT_STATE_DIR, 'projects.json');
    fs.writeFileSync(file, JSON.stringify({ projects: { [cached.id]: cached, [cached.token]: cached, [cached.key]: cached } }));
    let sidebarCalls = 0;
    testing.dom.projectHomeState = async () => ({ kind: 'unavailable', error: 'Execution context was destroyed' });
    testing.dom.openProjectHome = async () => { sidebarCalls++; return null; };
    const page = { url: () => cached.url, goto: async () => {} };
    // 快进15秒验证窗；这个时间技巧只缩短等待，断言仍观察真实cache和sidebar副作用。
    const realNow = Date.now; let tick = 0; Date.now = () => realNow() + ++tick * 16_000;
    (async () => {
      await assert.rejects(() => testing.ensureProjectHome(page, cached, () => {}), /validat|unavailable|Project/i);
      Date.now = realNow;
      const projects = JSON.parse(fs.readFileSync(file)).projects;
      // execution context瞬态消失不能证明Project身份失效，也不能触发sidebar换绑。
      assert.strictEqual(projects[cached.id].id, cached.id);
      assert.strictEqual(projects[cached.key].id, cached.id);
      assert.strictEqual(sidebarCalls, 0);
    })().catch(error => { Date.now = realNow; console.error(error.stack || error); process.exit(1); });
  `);
}

// 只有网页事实证明旧ID stale后才允许live discovery替换alias，不能以一次evaluate失败触发。
// 替代项必须先通过同一Project验证，避免缓存修复把后续Session迁到错误Project。
function testProjectCacheReplacesProvenStale() {
  runCoreFixture('chatgpt-project-replace-', () => String.raw`
    const assert = require('assert'), fs = require('fs'), path = require('path'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
    const stale = policy.parse('g-p-stale123-mcp', 'MCP');
    const replacement = policy.parse('g-p-fresh456-mcp', 'MCP');
    const file = path.join(process.env.CHATGPT_STATE_DIR, 'projects.json');
    fs.writeFileSync(file, JSON.stringify({ projects: { [stale.id]: stale, [stale.token]: stale, [stale.key]: stale } }));
    let current = 'https://chatgpt.com/';
    const page = { url: () => current, goto: async url => { current = url === stale.url ? 'https://chatgpt.com/' : url; }, waitForResponse: async predicate => {
      const response = { request: () => ({ method: () => 'POST' }), ok: () => true, url: () => 'https://chatgpt.com/backend-api/conversation/init' };
      return predicate(response) ? response : null;
    } };
    testing.dom.projectHomeState = async () => ({ kind: 'readable', state: { url: current, composer: current === replacement.url, title: current === replacement.url, titleName: 'MCP', chatActive: true, workActive: false } });
    testing.dom.openProjectHome = async () => { current = replacement.url; return current; };
    (async () => {
      const recovered = await testing.ensureProjectHome(page, stale, () => {});
      assert.strictEqual(recovered.id, replacement.id);
      const projects = JSON.parse(fs.readFileSync(file)).projects;
      // 替代身份通过页面验证后，同名alias必须只指向新ID，旧ID/token不能残留。
      assert.strictEqual(projects[replacement.key].id, replacement.id);
      assert.strictEqual(projects[stale.id], undefined);
      assert.strictEqual(projects[stale.token], undefined);
    })().catch(error => { console.error(error.stack || error); process.exit(1); });
  `);
}

// voice启动不拥有default Project，Project不可用时仍应完成daemon readiness和direct转录。
// 该边界防止每次Alt+V先打开Project页再刷新root，锁定无多余导航的冷启动路径。
function testVoiceStartupSkipsProject() {
  runCoreFixture('chatgpt-voice-no-project-', dir => {
    const voice = path.join(dir, 'voice.wav'); writeTinyWav(voice);
    return String.raw`
      const assert = require('assert'), { testing } = require('./chatgpt-core');
      // voice只依赖browser/page transport；default Project不可用时不能进入ask专属初始化。
      let projectCalls = 0;
      const page = { url: () => 'https://chatgpt.com/', isClosed: () => false, evaluate: async () => ({ kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' }), close: async () => {} };
      const runtime = testing.createDaemonRuntime({
        browser: { isConnected: () => true, newPage: async () => page },
        bootstrapPage: page,
        project: null,
        initializeProject: async () => { projectCalls++; throw new Error('default Project unavailable'); },
      });
      testing.dom.transcribeAudioFile = async () => 'voice without Project';
      (async () => {
        const result = await testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false);
        assert.deepStrictEqual(result, { ok: true, text: 'voice without Project' });
        assert.strictEqual(projectCalls, 0, 'voice must not initialize the default Project');
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
  });
}

// 正常hydrate由Mutation收敛而不刷新；只有持续混合事实允许消费一次startup reload。
// logged-out保留手工登录现场，第二次仍混合则失败，防止反复刷新破坏登录态。
function testStartupRecoversMixedLoginOnce() {
  runCoreFixture('chatgpt-startup-convergence-', () => String.raw`
    const assert = require('assert'), { testing } = require('./chatgpt-core');
    const authenticated = { kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' };
    const loggedOut = { kind: 'logged-out', origin: 'https://chatgpt.com', readyState: 'complete' };
    const inconsistent = { kind: 'inconsistent', origin: 'https://chatgpt.com', readyState: 'complete' };

    const run = async facts => {
      let reloads = 0;
      const page = { reload: async () => { reloads++; } };
      const remaining = [...facts];
      testing.dom.sessionPageFact = async () => remaining.shift() || inconsistent;
      try { return { fact: await testing.convergeBootstrapPage(page, 25), reloads }; }
      catch (error) { return { error, reloads }; }
    };

    (async () => {
      // adapter在自己的等待期内自然收敛时，core只能接受terminal事实，不能制造一次多余刷新。
      assert.deepStrictEqual(await run([authenticated]), { fact: authenticated, reloads: 0 });
      // 明确未登录是手工登录入口，不属于混合页面恢复，刷新会打断用户正在填写的表单。
      assert.deepStrictEqual(await run([loggedOut]), { fact: loggedOut, reloads: 0 });
      // 首轮持续混合时允许一次与用户手工刷新等价的恢复；第二轮一致后才可以ready。
      assert.deepStrictEqual(await run([inconsistent, authenticated]), { fact: authenticated, reloads: 1 });
      const failed = await run([inconsistent, inconsistent]);
      assert.match(failed.error.message, /did not converge/);
      assert.strictEqual(failed.reloads, 1, 'persistent mixed DOM must never start a reload loop');
    })().catch(error => { console.error(error.stack || error); process.exit(1); });
  `);
}

// 并发new ask可以拥有不同Session页，但default Project解析只能共享一个in-flight结果。
// 失败引用必须清除，后续请求才可重试同一主路径而不是永久继承坏Promise。
function testLazyProjectInitializationSingleFlight() {
  runCoreFixture('chatgpt-lazy-project-', () => String.raw`
    const assert = require('assert'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
    const project = policy.parse('g-p-lazy123-mcp', 'MCP');
    const pages = [{ id: 'first' }, { id: 'second' }];
    let calls = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const runtime = testing.createDaemonRuntime({
      browser: { isConnected: () => true, newPage: async () => pages.shift() },
      bootstrapPage: pages.shift(),
      project: null,
      initializeProject: async page => {
        // 两个new ask可以各自持有Session页，但default Project转换只能由首个调用拥有。
        calls++;
        assert.strictEqual(page.id, 'first');
        await gate;
        return project;
      },
    });
    (async () => {
      const first = runtime.ensureProject({ id: 'first' }, () => {});
      const second = runtime.ensureProject({ id: 'second' }, () => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(calls, 1, 'concurrent default Project consumers must share one initialization');
      release();
      assert.deepStrictEqual(await Promise.all([first, second]), [project, project]);
      assert.strictEqual(runtime.project.id, project.id);
    })().catch(error => { console.error(error.stack || error); process.exit(1); });
  `);
}

// existing Session以registry中的Project快照恢复，不应被当前default Project失效阻断。
// pending恢复必须零submit，证明兼容路径没有偷偷追加新的user turn。
function testExistingSessionSkipsDefaultProjectInitialization() {
  runCoreFixture('chatgpt-existing-project-', () => String.raw`
    const assert = require('assert'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
    const project = policy.parse('g-p-stored123-mcp', 'Stored');
    const sessionID = '#abc1230000';
    const scoped = 'https://chatgpt.com/g/' + project.token + '/c/existing-turn';
    const page = { current: scoped, url() { return this.current; }, isClosed: () => false, goto: async url => { page.current = url; }, close: async () => {} };
    let projectCalls = 0, submitCalls = 0;
    const runtime = testing.createDaemonRuntime({
      browser: { isConnected: () => true, newPage: async () => page },
      bootstrapPage: page,
      project: null,
      initializeProject: async () => { projectCalls++; throw new Error('current default Project unavailable'); },
    });
    testing.markSessionPending(sessionID, project, scoped, null, { beforeState: { count: 1, userCount: 1 } });
    Object.assign(testing.dom, {
      state: async () => ({ url: scoped, count: 2, userCount: 2, turnCount: 4, nativeImageCount: 0, nativeImageURLs: [], lastText: 'registry recovery', generating: false, placeholder: false, emptyAssistantTurn: false }),
      focus: async () => {}, ensureChatMode: async () => {},
      projectHomeState: async () => ({ kind: 'readable', state: { url: scoped, composer: true, title: true, titleName: 'Stored', chatActive: true, workActive: false } }),
      submit: async () => { submitCalls++; throw new Error('existing pending Session must not submit'); },
      waitForResponse: async () => ({ status: 'completed', reason: 'fixture' }),
      extractAssistant: async () => 'registry recovery',
      collectArtifacts: async () => ({ downloads: [], notices: [] }),
    });
    (async () => {
      const result = await runtime.withSession(sessionID, () => testing.runAsk(runtime, { fullPrompt: 'must recover only', uploadPaths: [], workspaceDir: process.env.CHATGPT_SESSION_DIR, mode: 'auto', imageAspectRatio: null, saveToFile: false, newSession: false }, sessionID, () => {}));
      // registry快照是existing Session的权威身份；当前default配置故障不能参与恢复。
      assert.strictEqual(projectCalls, 0);
      assert.strictEqual(submitCalls, 0);
      assert.strictEqual(result.status, 'completed');
      assert.match(result.response, /registry recovery/);
    })().catch(error => { console.error(error.stack || error); process.exit(1); });
  `);
}

// 第一段锁定voiceLock排队取消在文件读取和页面检查前生效，临时WAV删除后不能再被访问。
// 第二段锁定submission排队取消：即使外部closed状态稍后恢复，旧closure也永远不得POST。
// 两次取消后下一合法voice必须成功，直接证明daemon队列没有被拒绝Promise毒化。
function testQueuedVoiceCancelHasZeroSideEffects() {
  runCoreFixture('chatgpt-queued-voice-', dir => {
    const voice = path.join(dir, 'queued.wav');
    writeTinyWav(voice);
    return String.raw`
      const assert = require('assert'), fs = require('fs'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
      let healthCalls = 0; const page = { url: () => 'https://chatgpt.com/', isClosed: () => false, evaluate: async () => { healthCalls++; return { kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' }; }, close: async () => {} };
      const runtime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => { throw new Error('cancelled queued voice allocated a page'); } }, bootstrapPage: page, project: policy.parse('g-p-voice123-mcp', 'MCP') });
      let directCalls = 0;
      testing.dom.transcribeAudioFile = async () => { directCalls++; return 'third voice'; }; let release;
      const first = runtime.withVoice(() => new Promise(resolve => { release = resolve; })); let closed = false;
      (async () => {
        await new Promise(resolve => setImmediate(resolve));
        const second = testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => closed);
        closed = true; fs.unlinkSync(${JSON.stringify(voice)}); release(); await first;
        await assert.rejects(second, error => error.code === 'VOICE_CANCELLED'); assert.strictEqual(healthCalls, 0, 'cancelled queued voice must not validate a page');
        // 前一项取消不能毒化voice queue；下一条合法录音必须正常进入同一生产入口。
        fs.writeFileSync(${JSON.stringify(voice)}, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)]));
        assert.deepStrictEqual(await testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false), { ok: true, text: 'third voice' });
        assert.strictEqual(directCalls, 1);

        let releaseSubmission;
        const blocker = runtime.withSubmission(() => new Promise(resolve => { releaseSubmission = resolve; }));
        await new Promise(resolve => setImmediate(resolve));
        closed = false;
        const probesBeforeCancel = healthCalls;
        const cancelledSubmission = testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => closed);
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(healthCalls, probesBeforeCancel, 'a voice cancelled behind submission queue must not create or probe a page');
        closed = true;
        // 尚未取得queue所有权时，取消仍必须零POST且不能卡住voiceLock。
        await assert.rejects(cancelledSubmission, error => error.code === 'VOICE_CANCELLED');
        assert.strictEqual(directCalls, 1);
        releaseSubmission(); await blocker;
        closed = false;
        assert.deepStrictEqual(await testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false), { ok: true, text: 'third voice' });
        assert.strictEqual(directCalls, 2, 'submission cancellation must leave the daemon usable for the next voice');
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
  });
}

// borrowed Session页与dedicated页共享同一lease contract，成功和endpoint失败都必须释放owner。
// endpoint错误只返回诊断，不能打开UI听写、创建fallback页或阻断后续ask锁。
function testVoiceTaskLifecycle() {
  runCoreFixture('chatgpt-voice-lifecycle-', dir => {
    const voice = path.join(dir, 'voice.wav'); writeTinyWav(voice);
    return String.raw`
      const assert = require('assert'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
      let healthCalls = 0;
      const session = { id: 'session', url: () => 'https://chatgpt.com/c/idle', isClosed: () => false, evaluate: async () => { healthCalls++; return { kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' }; }, close: async () => {} }, dedicated = { id: 'dedicated', url: () => 'https://chatgpt.com/', isClosed: () => false, evaluate: async () => ({ kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' }), close: async () => {} };
      let newPages = 0; const runtime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => { newPages++; return dedicated; } }, bootstrapPage: session, project: policy.parse('g-p-life123-mcp', 'MCP') });
      (async () => {
        await runtime.pageFor('#idle'); const calls = []; let endpointFails = false;
        testing.dom.transcribeAudioFile = async page => {
          calls.push(page.id);
          if (endpointFails) throw Object.assign(new Error('endpoint changed'), { code: 'VOICE_ENDPOINT' });
          return 'direct text';
        };
        assert.strictEqual((await testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false)).text, 'direct text');
        assert.deepStrictEqual(calls, ['session']); assert.strictEqual(healthCalls, 2, 'borrowed pages must pass two stable probes'); assert.strictEqual(newPages, 0, 'stable idle session direct must not create a voice tab');
        endpointFails = true;
        await assert.rejects(() => testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false), /endpoint changed/);
        assert.deepStrictEqual(calls, ['session', 'session'], 'direct failure must not start a second transcription path');
        assert.strictEqual(newPages, 0, 'endpoint errors must not open a fallback page');
        // direct错误释放borrowed reservation；后续ask锁无需等待UI听写或页面导航。
        assert.strictEqual(await runtime.withSession('#idle', async () => 'released'), 'released');
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
  });
}

// borrowed页在POST前稳定性失败时只退役一次，再由dedicated candidate承接同一主路径。
// submitted列表证明坏页零POST且新页仅一次，续租不是direct失败后的重发。
function testBorrowedVoiceStablePreflightRenewsOnce() {
  runCoreFixture('chatgpt-voice-stable-lease-', dir => {
    const voice = path.join(dir, 'voice.wav'); writeTinyWav(voice);
    return String.raw`
      const assert = require('assert'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
      let borrowedProbes = 0, borrowedCloses = 0, dedicatedProbes = 0, newPages = 0;
      // 这里替换DOM adapter的公开四态事实，core仍只消费非敏感kind/origin/readyState。
      const fact = { kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' };
      const borrowed = { id: 'borrowed', url: () => 'https://chatgpt.com/c/idle', isClosed: () => false, close: async () => { borrowedCloses++; }, evaluate: async () => { borrowedProbes++; if (borrowedProbes === 2) throw new Error('network context degraded'); return fact; } };
      const dedicated = { id: 'dedicated', url: () => 'https://chatgpt.com/', isClosed: () => false, close: async () => {}, evaluate: async () => { dedicatedProbes++; return fact; } };
      const runtime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => { newPages++; return dedicated; } }, bootstrapPage: borrowed, project: policy.parse('g-p-stable123-mcp', 'MCP') });
      testing.dom.sessionPageFact = page => page.evaluate();
      const submitted = [];
      testing.dom.transcribeAudioFile = async page => { submitted.push(page.id); return 'renewed transcript'; };
      (async () => {
        await runtime.pageFor('#idle');
        const result = await testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false);
        assert.strictEqual(result.text, 'renewed transcript');
        // borrowed页第二次事实失败发生在POST前；同一lease acquisition只续租一次专属页。
        assert.deepStrictEqual(submitted, ['dedicated']);
        assert.strictEqual(borrowedProbes, 2);
        assert.strictEqual(borrowedCloses, 1);
        assert.strictEqual(dedicatedProbes, 2);
        assert.strictEqual(newPages, 1);
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
  });
}

// fresh/goto页先等待terminal hydrate再做双快照，不能把React加载过程当成健康失败。
// 已收敛复用页不新增固定等待；测试同时锁定无额外导航、关闭和重复提交。
function testFreshVoicePageWaitsForConvergence() {
  runCoreFixture('chatgpt-fresh-voice-convergence-', dir => {
    const voice = path.join(dir, 'voice.wav'); writeTinyWav(voice);
    return String.raw`
      const assert = require('assert'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
      let newPages = 0, gotoCalls = 0, closeCalls = 0;
      const pages = [];
      const createPage = () => {
        const page = {
          id: 'fresh-' + (pages.length + 1), current: 'about:blank', hydrated: false, closed: false,
          url() { return this.current; }, isClosed() { return this.closed; },
          async goto(url) { gotoCalls++; this.current = url; },
          async close() { closeCalls++; this.closed = true; },
        };
        pages.push(page);
        return page;
      };
      const runtime = testing.createDaemonRuntime({
        browser: { isConnected: () => true, newPage: async () => { newPages++; return createPage(); } },
        bootstrapPage: null,
        project: policy.parse('g-p-fresh123-mcp', 'MCP'),
      });
      const authenticated = { kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' };
      testing.dom.sessionPageFact = async (page, options) => {
        // bounded terminal观察模拟真实React后续hydrate；snapshot本身不能推动页面变健康。
        if (options.waitForTerminal) { page.hydrated = true; return authenticated; }
        return page.hydrated ? authenticated : { kind: 'loading', origin: 'https://chatgpt.com', readyState: 'interactive' };
      };
      const submitted = [];
      testing.dom.transcribeAudioFile = async page => { submitted.push(page.id); return 'fresh transcript'; };
      (async () => {
        assert.strictEqual((await testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false)).text, 'fresh transcript');
        // 第二次voice复用已经收敛的页；不得再次导航或为了等待正常hydrate新建页面。
        assert.strictEqual((await testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false)).text, 'fresh transcript');
        assert.deepStrictEqual(submitted, ['fresh-1', 'fresh-1']);
        assert.strictEqual(newPages, 1);
        assert.strictEqual(gotoCalls, 1);
        assert.strictEqual(closeCalls, 0, 'normal fresh-page hydration must not consume the renewal budget');
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
  });
}

// fixture重放真实2 voice/1 ask伪发送：第一direct pending，第二受voiceLock排队，ask已到composer。
// 修复后ask必须在第一voice后记录可信URL，第二voice又能与finishAsk长等待并发。
// 最终registry、文本和direct次数共同证明没有lost、全局串行或任何隐式重试。
function testVoiceAndAskSerializeRemoteSubmission() {
  runCoreFixture('chatgpt-voice-ask-submission-', dir => {
    const voice = path.join(dir, 'voice.wav'); writeTinyWav(voice);
    return String.raw`
      const assert = require('assert'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
      const project = policy.parse('g-p-submit123-mcp', 'MCP');
      const conversation = 'https://chatgpt.com/g/' + project.token + '/c/submission-turn';
      const authenticated = { kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' };
      const voicePage = {
        current: 'about:blank', closed: false,
        url() { return this.current; }, isClosed() { return this.closed; },
        async goto(url) { this.current = url; }, async close() { this.closed = true; },
      };
      const askPage = {
        current: project.url, closed: false,
        url() { return this.current; }, isClosed() { return this.closed; },
        async goto(url) { this.current = url; }, async close() { this.closed = true; },
      };
      let pages = 0;
      const runtime = testing.createDaemonRuntime({
        browser: { isConnected: () => true, newPage: async () => ++pages === 1 ? voicePage : askPage },
        bootstrapPage: null,
        project,
      });
      testing.dom.sessionPageFact = async () => authenticated;
      let projectReadyResolve, continueProjectResolve;
      const projectReady = new Promise(resolve => { projectReadyResolve = resolve; });
      const continueProject = new Promise(resolve => { continueProjectResolve = resolve; });
      testing.dom.projectHomeState = async () => {
        projectReadyResolve();
        await continueProject;
        return { kind: 'readable', state: { url: askPage.url(), composer: true, title: true, titleName: 'MCP', chatActive: true, workActive: false } };
      };
      testing.dom.ensureChatMode = async () => {};

      let directActive = false, directCalls = 0, releaseFirstVoice;
      let directStartedResolve, secondVoiceStartedResolve, submitEnteredResolve, askWaitingResolve, releaseAskWait;
      const directStarted = new Promise(resolve => { directStartedResolve = resolve; });
      const secondVoiceStarted = new Promise(resolve => { secondVoiceStartedResolve = resolve; });
      const submitEntered = new Promise(resolve => { submitEnteredResolve = resolve; });
      const askWaiting = new Promise(resolve => { askWaitingResolve = resolve; });
      const askWait = new Promise(resolve => { releaseAskWait = resolve; });
      testing.dom.transcribeAudioFile = async () => {
        directCalls++;
        if (directCalls === 1) {
          directActive = true;
          directStartedResolve();
          await new Promise(resolve => { releaseFirstVoice = resolve; });
          directActive = false;
          return 'voice one';
        }
        secondVoiceStartedResolve();
        return 'voice two';
      };

      const before = { count: 0, userCount: 0, turnCount: 0, nativeImageCount: 0, nativeImageURLs: [], lastText: '', generating: false, placeholder: false, emptyAssistantTurn: false };
      const completed = { ...before, count: 1, userCount: 1, turnCount: 2, lastText: 'OK' };
      testing.dom.submit = async (_page, _prompt, _files, _mode, _ratio, _log, _cancel, beforeSend) => {
        submitEnteredResolve();
        beforeSend();
        // 重放真实伪发送：voice POST覆盖click acceptance时，页面没有新增user turn或conversation URL。
        if (directActive) throw new Error('Waiting failed: 10000ms exceeded');
        askPage.current = conversation;
        return before;
      };
      testing.dom.state = async () => completed;
      testing.dom.waitForResponse = async () => { askWaitingResolve(); await askWait; return { status: 'completed', reason: 'fixture' }; };
      testing.dom.extractAssistant = async () => 'OK';
      testing.dom.collectArtifacts = async () => ({ downloads: [], notices: [] });
      testing.dom.focus = async () => {};

      const askInput = { fullPrompt: 'Reply exactly OK.', uploadPaths: [], workspaceDir: process.env.CHATGPT_SESSION_DIR, mode: 'auto', imageAspectRatio: null, saveToFile: false, newSession: true };
      // 纯Promise barrier不会保持child进程存活；有界计时器保证成功和失败断言都会真正执行。
      const testTimeout = setTimeout(() => { console.error('voice/ask submission fixture timed out'); process.exit(1); }, 4_000);
      (async () => {
        const firstVoice = testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false);
        await directStarted;
        const secondVoice = testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false);
        const ask = testing.runAsk(runtime, askInput, '#submit1234', () => {});
        ask.catch(() => {});

        // 在Project composer已确认的位置放行；旧实现会同一轮进入submit，R26则应等待voice释放。
        await projectReady;
        continueProjectResolve();
        await Promise.race([submitEntered, new Promise(resolve => setTimeout(resolve, 500))]);
        releaseFirstVoice();
        const accepted = await Promise.race([askWaiting.then(() => true), ask.then(() => false, () => false)]);
        if (!accepted) await ask; // 旧实现从这里原样暴露voice重叠造成的伪发送失败。
        await secondVoiceStarted;
        // ask已记录URL并进入finishAsk后，第二voice必须能够开始，证明没有串行整个生成阶段。
        releaseAskWait();
        const [one, two, answer] = await Promise.all([firstVoice, secondVoice, ask]);
        assert.deepStrictEqual([one.text, two.text], ['voice one', 'voice two']);
        assert.match(answer.response, /OK/);
        assert.strictEqual(testing.readSessionEntry('#submit1234', project).lost, undefined);
        assert.strictEqual(testing.readSessionEntry('#submit1234', project).url, conversation);
        assert.strictEqual(directCalls, 2, 'each voice input must keep one direct submission');
      })().then(() => clearTimeout(testTimeout), error => { clearTimeout(testTimeout); console.error(error.stack || error); process.exit(1); });
    `;
  });
}

// terminal logged-out和authenticated必须来自同一bootstrap authority，core不能用composer文案覆盖。
// 未登录candidate在音频读取后仍须POST为零，并沿既有退役边界返回明确失败。
function testVoiceStablePreflightRejectsLoggedOutPage() {
  runCoreFixture('chatgpt-voice-auth-lease-', dir => {
    const voice = path.join(dir, 'voice.wav'); writeTinyWav(voice);
    return String.raw`
      const assert = require('assert'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
      let borrowedCloses = 0, dedicatedFacts = 0, newPages = 0;
      const borrowed = { id: 'guest', url: () => 'https://chatgpt.com/c/idle', isClosed: () => false, close: async () => { borrowedCloses++; }, evaluate: async () => ({ origin: 'https://chatgpt.com', readyState: 'complete' }) };
      const dedicated = { id: 'logged-in', url: () => 'https://chatgpt.com/', isClosed: () => false, close: async () => {}, evaluate: async () => ({ origin: 'https://chatgpt.com', readyState: 'complete' }) };
      const runtime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => { newPages++; return dedicated; } }, bootstrapPage: borrowed, project: policy.parse('g-p-auth123-mcp', 'MCP') });
      testing.dom.sessionPageFact = async page => page.id === 'guest'
        ? { kind: 'logged-out', origin: 'https://chatgpt.com', readyState: 'complete' }
        : (dedicatedFacts++, { kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' });
      const submitted = [];
      testing.dom.transcribeAudioFile = async page => { submitted.push(page.id); return 'authenticated transcript'; };
      (async () => {
        await runtime.pageFor('#idle');
        const result = await testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false);
        assert.strictEqual(result.text, 'authenticated transcript');
        // guest/login页必须在POST前退役；只有连续稳定的登录页能进入唯一direct调用。
        assert.deepStrictEqual(submitted, ['logged-in']);
        assert.strictEqual(borrowedCloses, 1);
        assert.strictEqual(newPages, 1);
        assert.strictEqual(dedicatedFacts, 2);
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
  });
}

// status只暴露数量和健康事实，不得包含音频、文本、token、Session或页面句柄。
// active/queued/submitted的转换按真实请求观察，确保压力E2E可判定资源最终收敛。
function testVoiceStatusCounts() {
  runCoreFixture('chatgpt-voice-status-', () => String.raw`
    const assert = require('assert'), policy = require('./chatgpt-project'), { testing } = require('./chatgpt-core');
    // status fixture复用四态事实，不读取或伪造bootstrap凭据。
    const fact = { kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' };
    const session = { url: () => 'https://chatgpt.com/c/status', isClosed: () => false, evaluate: async () => fact, close: async () => {} };
    const dedicated = { url: () => 'https://chatgpt.com/', isClosed: () => false, evaluate: async () => fact, close: async () => {} };
    const runtime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => dedicated }, bootstrapPage: session, project: policy.parse('g-p-status123-mcp', 'MCP') });
    testing.dom.sessionPageFact = page => page.evaluate();
    (async () => {
      await runtime.pageFor('#status');
      await runtime.voicePage();
      let release;
      const first = runtime.withVoice(() => new Promise(resolve => { release = resolve; }));
      await new Promise(resolve => setImmediate(resolve));
      const second = runtime.withVoice(async () => 'second');
      await new Promise(resolve => setImmediate(resolve));
      runtime.noteVoiceSubmitted(); runtime.noteVoiceSubmitted();
      const busy = runtime.status();
      // status只暴露有界数量；压力harness无需读取Session ID、音频或page句柄。
      assert.deepStrictEqual({ active: busy.voiceActive, queued: busy.voiceQueued, voicePages: busy.voicePageCount, managed: busy.managedPageCount, submitted: busy.voiceSubmitted }, { active: 1, queued: 1, voicePages: 1, managed: 2, submitted: 2 });
      release(); await Promise.all([first, second]);
      assert.deepStrictEqual({ active: runtime.status().voiceActive, queued: runtime.status().voiceQueued }, { active: 0, queued: 0 });
    })().catch(error => { console.error(error.stack || error); process.exit(1); });
  `);
}

// deadline从进入voice队列前起算，排队时间不能在拿到锁后重新获得一整份预算。
// direct期间不持有foreground；取消必须先settle或隔离页面任务再释放voiceLock。
function testVoiceDeadlineAndForeground() {
  runCoreFixture('chatgpt-voice-foreground-', dir => {
    const voice = path.join(dir, 'voice.wav'); writeTinyWav(voice);
    return String.raw`
      const assert = require('assert'); const policy = require('./chatgpt-project'); const { testing } = require('./chatgpt-core');
      let closed = false, closeCalls = 0, rejectDirect, directStarted = false;
      const page = { url: () => 'https://chatgpt.com/', isClosed: () => false, evaluate: async () => ({ kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' }), close: async () => { closeCalls++; rejectDirect?.(new Error('target closed')); } };
      const runtime = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: async () => page }, bootstrapPage: page, project: policy.parse('g-p-fg123-mcp', 'MCP') });
      testing.dom.transcribeAudioFile = async () => { directStarted = true; return new Promise((_, reject) => { rejectDirect = reject; }); };
      testing.dom.cancelDirectVoice = async () => { rejectDirect(Object.assign(new Error('Voice transcription cancelled'), { code: 'VOICE_CANCELLED' })); };
      (async () => {
        const task = testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => closed);
        while (!directStarted) await new Promise(resolve => setImmediate(resolve));
        closed = true;
        const bounded = Promise.race([task, new Promise((_, reject) => setTimeout(() => reject(new Error('direct cancellation stayed pending')), 1_500))]);
        await assert.rejects(bounded, error => error.code === 'VOICE_CANCELLED');
        assert.strictEqual(closeCalls, 0, 'a direct request that settles after abort may release its stable page');
        testing.dom.transcribeAudioFile = async () => 'after cancel';
        assert.strictEqual((await testing.runVoiceRequest(runtime, { file: ${JSON.stringify(voice)} }, () => {}, () => false)).text, 'after cancel', 'cancelled direct work must release voice queue for the next request');
        let release, lateCalls = 0, cancelled = false;
        const first = runtime.withForeground(() => new Promise(resolve => { release = resolve; }), { assertUsable() {} });
        const late = runtime.withForeground(() => { lateCalls++; }, { assertUsable() { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'VOICE_CANCELLED' }); } });
        while (!first.hasStarted()) await new Promise(resolve => setImmediate(resolve));
        cancelled = true; release(); await first.internal; await assert.rejects(late.internal, /cancelled/);
        assert.strictEqual(lateCalls, 0, 'a cancelled queued foreground entry must remain inert');
        testing.dom.waitForResponse = async (_page, _before, options) => { assert.strictEqual(options.shouldSkipForeground(), true); return { status: 'generating', reason: 'client-disconnected' }; };
        assert.strictEqual((await runtime.waitForResponse(page, {}, { shouldCancel: () => true }, () => {})).reason, 'client-disconnected');
        let killed = 0; await testing.closeOwnedBrowser({ close: () => new Promise(() => {}), process: () => ({ kill() { killed++; } }) }, 10); assert.strictEqual(killed, 1);
        const stalled = testing.createDaemonRuntime({ browser: { isConnected: () => true, newPage: () => new Promise(() => {}) }, bootstrapPage: null, project: policy.parse('g-p-stall123-mcp', 'MCP') });
        await assert.rejects(Promise.race([testing.runVoiceRequest(stalled, { file: ${JSON.stringify(voice)} }, () => {}, () => false), new Promise((_, reject) => setTimeout(() => reject(new Error('page preparation stayed pending')), 3_000))]), error => error.code === 'VOICE_RUNTIME_FATAL');
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `;
  });
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
          // 网页已接受trusted click，但高负载时user turn可能晚于旧10秒窗口进入DOM。
          setTimeout(() => {
            const user = document.createElement('div');
            user.dataset.messageAuthorRole = 'user';
            user.textContent = 'project submit probe';
            document.body.appendChild(user);
          }, 10_200);
        });
      </script>
    `);
    // Chromium contenteditable 会原生把续行空格读回 NBSP；必须保持语义一致才能继续可信提交。
    await createChatGPTDom({ responseTimeout: 12_000 }).submit(page, 'project submit probe\n  continuation', [], 'auto', null, () => {});
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
      () => createChatGPTDom({ responseTimeout: 1_000 }).submit(page, 'route-only fixture', [], 'auto', null, () => {}),
      error => error.promptMayHaveBeenSent === true && /waiting failed|timeout/i.test(error.message),
    );
  });
}

async function testFileUploadUsesStableLocalCopy() {
  // 本地 Chromium fixture 走公开 submit seam，覆盖真实 file input/change/chip/send 链路而不连接 ChatGPT。
  const { createChatGPTDom } = require('./chatgpt-dom');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-upload-success-'));
  const previousUploadRoots = process.env.CHATGPT_UPLOAD_ROOTS;
  delete process.env.CHATGPT_UPLOAD_ROOTS;
  // 带空格的任意本地目录覆盖默认 unrestricted 语义，随后仍必须复制到 adapter 私有临时目录。
  const uploadDir = path.join(workspace, 'external upload fixtures');
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
      const allowed = path.join(workspace, 'allowed');
      fs.mkdirSync(allowed);
      process.env.CHATGPT_UPLOAD_ROOTS = path.join(workspace, 'missing-root');
      await assert.rejects(() => dom.submit(page, 'missing root fixture', [file], 'auto', null, () => {}), /ENOENT|no such file/i);
      process.env.CHATGPT_UPLOAD_ROOTS = allowed;
      // DOM 最后一跳仍服从显式 opt-in root，不能因前层已验证就跳过 TOCTOU 前的复核。
      await assert.rejects(() => dom.submit(page, 'blocked upload fixture', [file], 'auto', null, () => {}), /escaped allowed roots/i);
      const raceFile = path.join(allowed, 'race.txt');
      const replacement = path.join(workspace, 'replacement.txt');
      fs.writeFileSync(raceFile, 'safe');
      fs.writeFileSync(replacement, 'risk');
      const raceReal = fs.realpathSync.native(raceFile);
      const openSync = fs.openSync;
      let swapped = false;
      fs.openSync = (target, ...args) => {
        if (!swapped && target === raceReal) {
          swapped = true;
          // 模拟 Windows 已跟随瞬时 symlink、但 pathname 随即恢复：fd 指向替代文件，路径则是新的安全文件。
          const descriptor = openSync(replacement, fs.constants.O_RDONLY);
          fs.unlinkSync(raceFile);
          fs.writeFileSync(raceFile, 'safe');
          return descriptor;
        }
        return openSync(target, ...args);
      };
      try {
        // fd/path 身份不一致必须失败，不能把同尺寸替代内容复制进浏览器快照。
        await assert.rejects(() => dom.submit(page, 'race fixture', [raceFile], 'auto', null, () => {}), /identity changed/i);
      } finally {
        fs.openSync = openSync;
      }
      delete process.env.CHATGPT_UPLOAD_ROOTS;
      await dom.submit(page, 'upload fixture', [file, secondFile], 'auto', null, () => {});
      const probe = await page.evaluate(() => window.uploadProbe);
      assert.deepStrictEqual(probe.files, [
        { name: 'fixture upload.txt', size: marker.length, text: marker },
        { name: 'fixture second.txt', size: secondMarker.length, text: secondMarker },
      ]);
      assert.strictEqual(probe.sent, true);
      assert.strictEqual(probe.removed, 2, 'both recoverable retries must remove partial attachments before the third upload');
    });
  } finally {
    if (previousUploadRoots === undefined) delete process.env.CHATGPT_UPLOAD_ROOTS;
    else process.env.CHATGPT_UPLOAD_ROOTS = previousUploadRoots;
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
  const server = http.createServer((req, res) => {
    if (req.url === '/backend-api/conversation/init' && req.method === 'POST') {
      // 延迟响应复现Project首页已出现composer、但首屏网络仍未完成的真实窗口。
      const delay = req.headers['x-project-init-delay'] === 'slow' ? 15_200 : 100;
      return setTimeout(() => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end('{}');
      }, delay);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`
      <section class="sidebar-expando-section">
        <div class="project-unfurl-row"><div role="button" data-sidebar-item="true">Other</div></div>
        <button id="expand-projects" data-sidebar-item="true">Mehr anzeigen</button>
        <ul id="projects"></ul>
      </section>
      <script>
        window.projectProbe = { expanded: false, trusted: null, initStarted: false, initCompleted: false };
        document.querySelector('#expand-projects').addEventListener('click', expandEvent => {
          if (!expandEvent.isTrusted) return;
          window.projectProbe.expanded = true;
          document.querySelector('#projects').innerHTML = '<li><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button aria-label="Open project home">Open</button><button data-trailing-button aria-haspopup="menu">Options</button></li>';
          document.querySelector('[aria-label="Open project home"]').addEventListener('click', event => {
            window.projectProbe.trusted = event.isTrusted;
            if (!event.isTrusted) return;
            // 首页DOM先更新不等于Project网络初始化完成；ask不能在这个Promise前拿走页面。
            window.projectProbe.initStarted = true;
            fetch('/backend-api/conversation/init', { method: 'POST' }).then(() => { window.projectProbe.initCompleted = true; });
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
      assert.deepStrictEqual(await page.evaluate(() => ({ ...window.projectProbe, chat: document.querySelector('[role="radio"]')?.getAttribute('aria-checked') })), { expanded: true, trusted: true, initStarted: true, initCompleted: true, chat: 'true' });
      const explicitUrlState = await dom.projectHomeState(page, null);
      assert.strictEqual(explicitUrlState.kind, 'readable');
      assert.deepStrictEqual({ title: explicitUrlState.state.title, titleName: explicitUrlState.state.titleName }, { title: true, titleName: 'MCP' }, 'an explicit id/URL validates against the actual h1 instead of its slug');
      // 额外激活“高”模拟推理级别 radio；它不能把已经激活的日文 Chat 误判为 Work。
      await page.evaluate(() => {
        const radios = document.querySelectorAll('[role="radio"]');
        radios[0].textContent = '会話';
        radios[1].textContent = '作業';
        document.body.insertAdjacentHTML('beforeend', '<button role="radio" aria-checked="true">高</button>');
      });
      const japanese = await dom.projectHomeState(page, 'MCP');
      assert.strictEqual(japanese.state.chatActive, true, 'a supported localized Chat label must remain usable');
      assert.strictEqual(japanese.state.workActive, false, 'an unrelated active model radio must not be interpreted as Work');
      await page.evaluate(() => {
        const radios = document.querySelectorAll('[role="radio"]');
        radios[0].textContent = 'Unknown mode A';
        radios[1].textContent = 'Unknown mode B';
      });
      const unknown = await dom.projectHomeState(page, 'MCP');
      // 未识别语言既不能假定为 Chat，也不能伪造为 Work；core 会因此拒绝未经确认的模式。
      // 该负路径保留未知标签，同时正路径单独覆盖日文，避免通过无限放宽文本匹配掩盖漂移。
      assert.strictEqual(unknown.state.chatActive, false, 'unknown mode labels must not be assumed to mean Chat');
      assert.strictEqual(unknown.state.workActive, false, 'unknown and unrelated radios must not be mislabeled as Work');
      await page.evaluate(() => {
        document.querySelector('[data-project-mode-switch]').remove();
        document.body.insertAdjacentHTML('beforeend', '<div role="radiogroup"><button role="radio" aria-checked="true">GPT-5.6</button><button role="radio" aria-checked="false">GPT-4o</button></div>');
      });
      const chatOnly = await dom.projectHomeState(page, 'MCP');
      assert.strictEqual(chatOnly.state.chatActive, true, 'a Chat-only page with a two-option model radio group must remain valid');
      assert.strictEqual(chatOnly.state.workActive, false);

      // 当前网页会保留完整Project DOM，但折叠层会移出视口并禁用pointer events；尺寸存在不能代表可操作。
      await page.setContent(`
        <style>
          #open-sidebar { position: absolute; left: -180px; top: 8px; }
          #close-sidebar { position: absolute; left: 216px; top: 8px; pointer-events: none; }
          #stage-slideover-sidebar { position: absolute; left: 0; top: 60px; width: 260px; height: 300px; transform: translateX(-300px); pointer-events: none; opacity: 0; }
        </style>
        <button id="open-sidebar" aria-controls="stage-slideover-sidebar" aria-expanded="false">Open sidebar</button>
        <button id="close-sidebar" aria-controls="stage-slideover-sidebar" aria-expanded="true">Close sidebar</button>
        <div id="stage-slideover-sidebar">
          <ul><li><div role="button" data-sidebar-item="true">MCP</div><button id="collapsed-home" data-trailing-button>Open</button></li></ul>
        </div>
        <script>
          window.collapsedProjectProbe = { sidebarOpened: false, homeTrusted: null };
          document.querySelector('#open-sidebar').addEventListener('click', () => {
            // toggle只恢复同一sidebar；测试不提供URL、Project ID或第二种导航来源。
            window.collapsedProjectProbe.sidebarOpened = true;
            const sidebar = document.querySelector('#stage-slideover-sidebar');
            sidebar.style.transform = 'none';
            sidebar.style.pointerEvents = 'auto';
            sidebar.style.opacity = '1';
            document.querySelector('#open-sidebar').style.pointerEvents = 'none';
            document.querySelector('#close-sidebar').style.pointerEvents = 'auto';
          });
          document.querySelector('#collapsed-home').addEventListener('click', event => {
            // sidebar恢复不能放宽首页副作用；Project导航仍必须来自Puppeteer可信click。
            window.collapsedProjectProbe.homeTrusted = event.isTrusted;
            if (!event.isTrusted) return;
            fetch('/backend-api/conversation/init', { method: 'POST' });
            history.pushState({}, '', '/g/g-p-collapsed-mcp/project');
            document.body.insertAdjacentHTML('beforeend', '<h1>MCP</h1><div id="prompt-textarea"></div>');
          });
        </script>
      `);
      // 用户可观察结果是目标Project首页可用，而不是某个恢复helper被调用。
      const collapsedUrl = await dom.openProjectHome(page, 'MCP', () => {});
      assert.match(collapsedUrl, /\/g\/g-p-collapsed-mcp\/project$/);
      // 同时锁定恢复动作和既有可信首页点击，防止未来改成猜测URL或DOM伪导航。
      assert.deepStrictEqual(await page.evaluate(() => window.collapsedProjectProbe), { sidebarOpened: true, homeTrusted: true });

      await page.setContent(`
        <ul><li><div role="button" data-sidebar-item="true">MCP</div><button id="delayed-home" data-trailing-button>Open</button></li></ul>
        <script>
          history.replaceState({}, '', '/');
          window.delayedProjectProbe = { trusted: false, converged: false };
          document.querySelector('#delayed-home').addEventListener('click', event => {
            window.delayedProjectProbe.trusted = event.isTrusted;
            if (!event.isTrusted) return;
            // 真实故障中init超过15秒；只有网络成功后才产生route/DOM，确保测试不被提前DOM更新误放行。
            fetch('/backend-api/conversation/init', { method: 'POST', headers: { 'x-project-init-delay': 'slow' } }).then(() => {
              history.pushState({}, '', '/g/g-p-delayed-mcp/project');
              document.body.insertAdjacentHTML('beforeend', '<h1>MCP</h1><div id="prompt-textarea"></div>');
              window.delayedProjectProbe.converged = true;
            });
          });
        </script>
      `);
      const delayedStartedAt = Date.now();
      const delayedUrl = await createChatGPTDom({ responseTimeout: 20_000 }).openProjectHome(page, 'MCP', () => {});
      assert.match(delayedUrl, /g-p-delayed-mcp/, 'Project home must follow the route/init events instead of a 15-second DOM gate');
      assert.ok(Date.now() - delayedStartedAt >= 15_000, 'the fixture must cross the observed fixed-wait boundary');
      assert.deepStrictEqual(await page.evaluate(() => window.delayedProjectProbe), { trusted: true, converged: true });

      await page.setContent(`
        <ul>
          <li><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button id="visible-home">Open</button></li>
          <li style="display:none"><div role="button" data-sidebar-item="true">MCP</div><button data-trailing-button>Hidden copy</button></li>
        </ul>
        <script>
          document.querySelector('#visible-home').addEventListener('click', event => {
            if (!event.isTrusted) return;
            fetch('/backend-api/conversation/init', { method: 'POST' });
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

async function testProjectDiscoveryCollectsDistinctProjectLinks() {
  // discovery只负责收集候选；同href响应式副本与无关重名不能越权变成目标身份错误。
  // 目标同名的不同ID和无href row仍由既有Project policy/open-home测试负责拒绝。
  const { createChatGPTDom } = require('./chatgpt-dom');
  await withBrowserPage('Project candidate collection', 'chatgpt-project-collection-test-', async page => {
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (!request.isNavigationRequest() || !request.url().startsWith('https://chatgpt.com')) return request.abort();
      return request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<section class="sidebar-expando-section"><ul>
          <li><div class="project-unfurl-row"><div id="project-row" role="button" data-sidebar-item="true" aria-expanded="false">个人</div><a href="/g/g-p-mcp/project">MCP</a></div></li>
          <li><a href="/g/g-p-mcp/project">MCP</a></li>
          <li><div class="project-unfurl-row"><div role="button" data-sidebar-item="true">个人</div><button data-trailing-button>Open B</button></div></li>
        </ul></section><div id="unrelated-more" class="group __menu-item">更多</div><script>window.projectRowClicked = false; window.moreClicked = false; document.querySelector('#project-row').addEventListener('click', () => { window.projectRowClicked = true; }); document.querySelector('#unrelated-more').addEventListener('click', () => { window.moreClicked = true; });</script>`,
      });
    });
    await page.goto('https://chatgpt.com');
    const projects = await createChatGPTDom({ responseTimeout: 5_000 }).discoverProjects(page, () => {});
    assert.strictEqual(projects.length, 1, 'same href must be collected once despite unrelated duplicate names');
    assert.strictEqual(projects[0].name, 'MCP');
    assert.strictEqual(await page.evaluate(() => window.projectRowClicked), false, 'Project rows are not list expanders');
    assert.strictEqual(await page.evaluate(() => window.moreClicked), false, 'unrelated More controls are not Project expanders');
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
    await createChatGPTDom({ responseTimeout: 5_000 }).submit(page, 'draw fixture', [], 'image', 'wide', () => {});
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
    await createChatGPTDom({ responseTimeout: 5_000 }).submit(page, 'draw fallback', [], 'image', 'wide', message => logs.push(message));
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
      url: () => healthyUrl, isClosed: () => false, evaluate: async () => ({ kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' }),
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
  // 警告属于模型可见的 Tool 契约，默认 unrestricted 不能只写在 README 里。
  assert.match(askSchema.properties.file.description, /sent to ChatGPT.*explicitly selected.*never infer sensitive paths/i);
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

// direct voice不需要composer ready、focus或Project导航，避免后台DOM渲染影响转录响应时间。
// fixture只允许同源endpoint路径成功，任何UI控制调用都会立即使行为测试失败。
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
        if (config?.audioBase64) return { ok: true, text: 'direct transcript', elapsedMs: 7 };
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

// Bearer只能从当前页面client-bootstrap读取并用于本次fetch，Node测试只能看到请求shape布尔事实。
// logged-out或缺token必须在POST前失败；HTTP错误仍保持一次请求且不得切换端点。
// 成功response只返回文本和耗时，凭据不能穿过page.evaluate结果边界。
async function testDirectVoiceUsesBootstrapAuth() {
  const { createChatGPTDom } = require('./chatgpt-dom');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-direct-bootstrap-auth-'));
  const voice = path.join(dir, 'bootstrap-auth.wav');
  writeTinyWav(voice);
  try {
    await withBrowserPage('direct bootstrap auth', 'chatgpt-direct-bootstrap-auth-browser-', async page => {
      let sessionRequests = 0;
      let transcribeRequests = 0;
      let authorization = null;
      let method = null;
      let pathName = null;
      let contentType = null;
      let formBody = null;
      let accept = null;
      let language = null;
      await page.setRequestInterception(true);
      page.on('request', async request => {
        const target = new URL(request.url());
        if (request.isNavigationRequest()) return request.respond({
          status: 200,
          contentType: 'text/html',
          body: '<html><body><script id="client-bootstrap" type="application/json">{"authStatus":"logged_in","session":{"accessToken":"page-access-token"}}</script><div id="prompt-textarea"></div></body></html>',
        });
        if (target.pathname === '/api/auth/session') {
          sessionRequests++;
          // 当前已登录网页只返回warning；direct不得再把旧token wire当作上传前置。
          return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ WARNING_BANNER: 'session tokens are unavailable' }) });
        }
        if (target.pathname === '/backend-api/transcribe') {
          transcribeRequests++;
          const headers = request.headers();
          method = request.method();
          pathName = target.pathname;
          contentType = headers['content-type'] || null;
          const encodedBody = await request.fetchPostData();
          // CDP对multipart字节返回base64；只解码本次已成功请求的fixture，便于独立确认file字段存在。
          formBody = encodedBody ? Buffer.from(encodedBody, 'base64').toString('utf8') : null;
          accept = headers.accept || null;
          language = headers['oai-language'] || null;
          authorization = headers.authorization || null;
          // 真实short voice曾被15秒页面timer误杀；fixture跨过该边界但仍位于本次20秒总预算内。
          await new Promise(resolve => setTimeout(resolve, 15_200));
          try { return await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'bootstrap transcript' }) }); }
          catch { return; } // red路径中浏览器已abort请求；不能让迟到fixture响应制造未处理rejection。
        }
        request.abort();
      });
      await page.goto('https://chatgpt.com');
      const dom = createChatGPTDom({ responseTimeout: 20_000 });
      const text = await dom.transcribeAudioFile(page, voice, 'https://chatgpt.com', () => {}, () => false, () => {}, { requestID: 'bootstrap-auth', timeoutMs: 20_000 });
      assert.strictEqual(text, 'bootstrap transcript');
      // 一个输入只走网页当前authenticated POST；Bearer与cookie同源发送，不能切换第二种上传算法。
      assert.strictEqual(sessionRequests, 0);
      assert.strictEqual(transcribeRequests, 1);
      assert.strictEqual(method, 'POST');
      assert.strictEqual(pathName, '/backend-api/transcribe');
      assert.match(contentType, /^multipart\/form-data; boundary=/);
      assert.match(formBody, /name="file"/);
      assert.strictEqual(accept, 'application/json');
      assert.ok(language);
      assert.strictEqual(authorization, 'Bearer page-access-token');

      // stable probe后session仍可能被用户登出；direct必须在音频POST前重新读取同一个bootstrap owner。
      await page.setContent('<script id="client-bootstrap" type="application/json">{"authStatus":"logged_out"}</script><div id="prompt-textarea"></div><a href="/auth/login">Log in</a>');
      await assert.rejects(
        () => dom.transcribeAudioFile(page, voice, 'https://chatgpt.com', () => {}, () => false, () => {}, { requestID: 'logged-out' }),
        /authenticated session/i,
      );
      assert.strictEqual(transcribeRequests, 1, 'logged-out page must fail before a second audio POST');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 四态事实同时约束bootstrap、composer和登录入口，防止半登录DOM被简单布尔值误判。
// Mutation等待只观察当前页面自然收敛，不触发刷新、导航或旧session endpoint请求。
// adapter返回固定非敏感联合，accessToken永远不进入core或测试进程。
async function testSessionPageFactUsesBootstrapAuth() {
  const { createChatGPTDom } = require('./chatgpt-dom');
  await withBrowserPage('session page fact', 'chatgpt-session-page-fact-', async page => {
    const dom = createChatGPTDom({ responseTimeout: 2_000 });
    const expectedKeys = ['kind', 'origin', 'readyState'];
    const bootstrap = value => `<script id="client-bootstrap" type="application/json">${JSON.stringify(value)}</script>`;

    // 已登录必须同时满足网页自己的session和收敛后的composer；token只能参与页面事实，不能进入返回对象。
    await page.setContent(`${bootstrap({ authStatus: 'logged_in', session: { accessToken: 'page-secret' } })}<main><div id="prompt-textarea" contenteditable="true"></div></main>`);
    const loggedIn = await dom.sessionPageFact(page, { waitForTerminal: false, timeoutMs: 0 });
    assert.deepStrictEqual(Object.keys(loggedIn).sort(), expectedKeys);
    assert.strictEqual(loggedIn.kind, 'authenticated');
    assert.strictEqual(JSON.stringify(loggedIn).includes('page-secret'), false, 'bootstrap credentials must remain inside the page');

    // 真实guest允许输入composer；明确logged_out必须优先于易漂移正文，且不能触发旧session endpoint。
    await page.setContent(`${bootstrap({ authStatus: 'logged_out' })}<main><div id="prompt-textarea"></div><a href="/auth/login">Log in</a></main>`);
    const guest = await dom.sessionPageFact(page, { waitForTerminal: false, timeoutMs: 0 });
    assert.deepStrictEqual(Object.keys(guest).sort(), expectedKeys);
    assert.strictEqual(guest.kind, 'logged-out');

    // bootstrap已登录但登录入口仍在时是用户观察到的混合页；它不能提前成为daemon/voice可用事实。
    await page.setContent(`${bootstrap({ authStatus: 'logged_in', session: { accessToken: 'page-secret' } })}<main><div id="prompt-textarea"></div><a id="login" href="/auth/login">Log in</a></main>`);
    assert.strictEqual((await dom.sessionPageFact(page, { waitForTerminal: false, timeoutMs: 0 })).kind, 'inconsistent');
    await page.evaluate(() => setTimeout(() => document.querySelector('#login')?.remove(), 50));
    assert.strictEqual((await dom.sessionPageFact(page, { waitForTerminal: true, timeoutMs: 1_000 })).kind, 'authenticated', 'Mutation convergence must avoid a normal-page reload');

    // 持续混合到预算结束仍返回typed事实，由core决定一次reload；adapter不能自行导航或合成登录成功。
    await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<a href="/auth/login">Log in</a>'));
    assert.strictEqual((await dom.sessionPageFact(page, { waitForTerminal: true, timeoutMs: 25 })).kind, 'inconsistent');

    await page.setContent(`${bootstrap({ authStatus: 'logged_in', session: { accessToken: 'page-secret' } })}<main><div id="prompt-textarea"></div></main>`);
    // 重放真实时间线已经观察到的loading事实；只覆盖浏览器只读属性，不伪造认证schema或异常response。
    await page.evaluate(() => Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' }));
    assert.strictEqual((await dom.sessionPageFact(page, { waitForTerminal: false, timeoutMs: 0 })).kind, 'loading');
  });
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

// Node daemon存活不代表browser可用；status必须独立报告连接事实而不尝试修复生命周期。
// 只读探测不能启动新Edge或清理索引，真正恢复留给下一次ask/voice调用。
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

// stale daemon索引必须先通过本地identity/browser探测淘汰，再启动下一独立生命周期。
// 当前voice只允许进入一个新daemon，不能在同一音频POST后做透明重试。
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

// browser在direct期间断开时，本调用返回生命周期错误并保持提交次数一，绝不自动重发音频。
// 恢复只属于下一次独立调用，测试拒绝任何同进程fallback成功结果。
async function testVoiceDoesNotRetryAfterBrowserDisconnect() {
  const fixture = await withFakeDaemon({ browserConnected: true, voiceResponse: { status: 503, body: { ok: false, code: 'BROWSER_DISCONNECTED', error: 'Browser was closed during voice transcription' } } });
  const voice = path.join(fixture.dir, 'one request.wav');
  writeTinyWav(voice);
  try {
    const result = await runChatgptCLI(['transcribe-file', '--file', voice, '--json'], {
      ...fixture.env,
      CHATGPT_BROWSER_PATH: path.join(fixture.dir, 'missing browser.exe'),
      CHATGPT_DAEMON_START_TIMEOUT_MS: '1500',
    }, 6000);
    assert.notStrictEqual(result.status, 0);
    // 原生命周期错误必须直接返回；若同调用重启daemon，stderr会变成startup错误且可能重复上传。
    assert.match(result.stderr, /Browser was closed during voice transcription/);
    assert.strictEqual(fixture.calls.voice, 1, 'one CLI invocation must submit the audio to at most one daemon endpoint');
    assert.strictEqual(fixture.calls.stop, 1, 'the disconnected daemon index should still be retired for the next invocation');
  } finally {
    await fixture.close();
  }
}

// owned browser断连必须触发幂等shutdown并删除发现索引，避免CLI继续命中假活daemon。
// disconnect回调不再次close已断开的句柄，防止协议错误掩盖真实退出原因。
function testOwnedBrowserDisconnectLifecycle() {
  runCoreFixture('chatgpt-browser-disconnect-', () => String.raw`
    const assert = require('assert'), { EventEmitter } = require('events'), { testing } = require('./chatgpt-core');
    const browser = new EventEmitter();
    const calls = [];
    testing.installBrowserDisconnectHandler(browser, async (message, options) => { calls.push({ message, options }); }, () => {});
    (async () => {
      browser.emit('disconnected');
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(calls.length, 1);
      assert.match(calls[0].message, /Browser disconnected/);
      // 断连后的browser已经不可操作；shutdown只清索引/服务，不得再次close或立即重开窗口。
      assert.deepStrictEqual(calls[0].options, { closeBrowser: false });
    })().catch(error => { console.error(error.stack || error); process.exit(1); });
  `);
}

// ask和voice共享相同daemon身份验证；stale端口不能让prompt落入错误浏览器实例。
// 新生命周期只接收一次prompt，避免retire/start竞争产生重复user turn。
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
      if (options.voiceResponse) return send(options.voiceResponse.status, options.voiceResponse.body);
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
// direct取消只能终止当前page task，不能转入composer听写、续租后重发或返回空成功。
// cancel adapter和原Promise都必须settle，后续voice才能安全复用runtime。
async function testTranscribeCancelDoesNotStartAnotherPath() {
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

// direct错误是最终诊断结果；一个输入最多进入一次页面请求，不能导航、抢前台或点击听写UI。
// 同一个音频输入的唯一可观察远端副作用是一次direct adapter调用。
// 返回失败也不能递归调用adapter；该断言保护无fallback和无重发不变量。
async function testDirectVoiceSubmitsOnce() {
  const { createChatGPTDom } = require('./chatgpt-dom');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-voice-fallback-'));
  const voice = path.join(dir, 'voice.wav');
  writeTinyWav(voice);
  try {
    let fallbackStarted = false, evaluateCalls = 0, foregroundCalls = 0, gotoCalls = 0;
    const page = {
      bringToFront: async () => { foregroundCalls++; },
      url: () => 'https://chatgpt.com.evil.example/',
      goto: async () => { gotoCalls++; },
      waitForSelector: async () => {},
      evaluateOnNewDocument: async () => {},
      evaluate: async (_fn, config) => {
        evaluateCalls++;
        if (config?.audioBase64) return { ok: false, kind: 'endpoint', message: 'HTTP 500: simulated direct path failure' };
        throw new Error('unexpected secondary page operation');
      },
    };
    const dom = createChatGPTDom({ responseTimeout: 1_000 });
    await assert.rejects(() => dom.transcribeAudioFile(page, voice, 'https://chatgpt.com/', () => {}, () => false, () => { fallbackStarted = true; }), /HTTP 500/);
    assert.strictEqual(evaluateCalls, 1, 'one voice input must produce one direct request attempt');
    assert.strictEqual(fallbackStarted, false);
    assert.strictEqual(foregroundCalls, 0);
    assert.strictEqual(gotoCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ChatGPT可能完成无文本assistant turn；turn增长仍应结束等待但不能伪造response内容。
// 该ask边界必须保持与voice submission queue无关，不能因空文本长期占锁。
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

// 八秒pulse只用于后台生成DOM刷新，不能改变完成判定、重新提交prompt或阻塞voice direct。
// 每次pulse先滚到末尾且受取消gate保护，避免用户取消后继续周期性抢前台。
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
// TUI关闭HTTP响应后，迟到voice结果必须被丢弃，不能在closed res上writeHead杀死共享daemon。
// 取消错误仍由生产voice cleanup处理，send边界只负责安全地拒绝二次写入。
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
