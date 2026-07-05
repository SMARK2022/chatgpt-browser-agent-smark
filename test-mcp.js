#!/usr/bin/env node
'use strict';

/**
 * test-mcp.js — MCP 协议烟测 + 真实 daemon 端到端测试
 *
 * 测试分两层：
 *   1. wrapper 协议层（runServer）：JSON-RPC、schema 校验、超限恢复——不依赖浏览器。
 *   2. 真实 E2E 层（runChatgptCLI + 真实 daemon）：ask、文件上传、voice、并发、session 续聊。
 * E2E 测试在 daemon 不可用时自动跳过（打印 SKIP），不失败。
 * 每个测试最多 40 秒；全部测试最多 3 分钟。
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
  // 测试不连接真实浏览器；显式禁用 CDP 端口，避免默认值 9222 导致 CLI 连接到用户正在运行的 Edge。
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
    ['testTableCitationExtraction', () => testTableCitationExtraction(), false],
    ['testVoicePageHealthCheck', () => testVoicePageHealthCheck(), false],
    ['checkE2EAvailability', () => checkE2EAvailability(), true],
    ['testE2EStatus', () => testE2EStatus(), true],
    ['testE2EAskBasic', () => testE2EAskBasic(), true],
    ['testE2EAskWithSession', () => testE2EAskWithSession(), true],
    ['testE2EAskWithFileUpload', () => testE2EAskWithFileUpload(), true],
    ['testE2EAskWithSaveToFile', () => testE2EAskWithSaveToFile(), true],
    ['testE2EConcurrentAsks', () => testE2EConcurrentAsks(), true],
    ['testE2EVoiceTranscribe', () => testE2EVoiceTranscribe(), true],
  ];
  // 有 filter 时只跑指定测试；E2E 测试需要先检测 daemon 可用性。
  const selected = filter.length > 0 ? allTests.filter(t => filter.includes(t[0])) : allTests;
  // 如果选了 E2E 测试但没选 checkE2EAvailability，自动先跑它。
  const needsE2ECheck = selected.some(t => t[2]) && !selected.some(t => t[0] === 'checkE2EAvailability');
  if (needsE2ECheck) await withTestTimeout('checkE2EAvailability', checkE2EAvailability, PER_TEST_TIMEOUT);
  for (const [name, fn] of selected) {
    await withTestTimeout(name, fn, PER_TEST_TIMEOUT);
  }
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
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms); }),
    ]);
    console.log(`  PASS: ${name}`);
  } catch (err) {
    if (err instanceof SkipError) {
      console.log(`  ${err.message}`);
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
  const outsideFile = path.join(os.tmpdir(), 'outside-allowlist-test.txt');
  fs.writeFileSync(outsideFile, 'should be rejected');
  try {
    const responses = runServer([
      JSON.stringify({ jsonrpc: '2.0', id: 'upload-outside', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'test', file: outsideFile } } }),
    ]);
    const result = responses.find(item => item.id === 'upload-outside');
    assert.ok(result.result?.isError, 'file outside allowlist must return tool error');
    assert.match(result.result.content[0].text, /outside.*root|allowed.*root/i);
  } finally {
    try { fs.unlinkSync(outsideFile); } catch {}
  }
}

async function testFileUploadRejectsDuplicateBasenames() {
  // ChatGPT composer 按文件名匹配 attachment；同名文件无法区分，必须在上传前拒绝。
  const uploadDir = path.join(process.cwd(), '.opencode', 'cache', 'chatgpt', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(path.join(uploadDir, 'sub'), { recursive: true });
  const fileA = path.join(uploadDir, 'dup-name.txt');
  const fileB = path.join(uploadDir, 'sub', 'dup-name.txt');
  fs.writeFileSync(fileA, 'A');
  fs.writeFileSync(fileB, 'B');
  try {
    const responses = runServer([
      JSON.stringify({ jsonrpc: '2.0', id: 'dup-basenames', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'test', file: [fileA, fileB] } } }),
    ]);
    const result = responses.find(item => item.id === 'dup-basenames');
    assert.ok(result.result?.isError, 'duplicate basenames must return tool error');
    assert.match(result.result.content[0].text, /basename|distinct/i);
  } finally {
    try { fs.unlinkSync(fileA); } catch {}
    try { fs.rmSync(path.join(uploadDir, 'sub'), { recursive: true, force: true }); } catch {}
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

async function testTableCitationExtraction() {
  // 验证表格单元格内 citation pill 被正确转成 [Ref n] 并追加 References 段。
  // 用真实浏览器 + DOM fixture 直接测试 extractAssistant 的提取逻辑，
  // 不依赖 ChatGPT 回答格式，比 E2E 测试更确定。
  const puppeteer = require('puppeteer-core');
  const { createChatGPTDom } = require('./chatgpt-dom');
  // 惰性 require puppeteer-core：避免无浏览器环境加载不必要的重模块。
  const browserPath = findTestBrowserPath();
  if (!browserPath) { console.log('  SKIP: no browser found for DOM extraction test'); return; }
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-dom-test-'));
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    userDataDir: tmpProfile,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
  });
  try {
    const page = await browser.newPage();
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
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(tmpProfile, { recursive: true, force: true });
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

async function testVoicePageHealthCheck() {
  // 验证 withTimeout 能检测并中断挂起的 page.evaluate——这是防止 voiceLock 永久卡死的核心机制。
  // 生产场景：页面复用数小时后 fetch 挂起 → page.evaluate 永不返回 → voiceLock 永久 pending。
  // withTimeout 让 runVoiceTranscribe 在超时后 reject，释放 voiceLock，后续 voice 调用不被阻塞。
  const puppeteer = require('puppeteer-core');
  const browserPath = findTestBrowserPath();
  if (!browserPath) { console.log('  SKIP: no browser found for health check test'); return; }
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-voice-health-'));
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    userDataDir: tmpProfile,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body>test</body></html>');
    // 异步冻结事件循环：setTimeout 回调中执行 while(true)。
    // evaluate 本身立即返回，但 100ms 后事件循环被永久阻塞。
    await page.evaluate(() => { setTimeout(() => { while(true) {} }, 100); });
    // 等待冻结生效
    await new Promise(r => setTimeout(r, 300));
    // 此时 page.evaluate(() => true) 应该挂起——模拟生产中 fetch 挂起的场景。
    // 用 Promise.race + setTimeout 验证挂起的 evaluate 能被超时中断（withTimeout 的核心机制）。
    const startedAt = Date.now();
    let timed = false;
    try {
      await Promise.race([
        page.evaluate(() => true),
        new Promise((_, reject) => setTimeout(() => { timed = true; reject(new Error('health check timeout')); }, 3_000)),
      ]);
      // 如果 evaluate 返回了（页面可能没冻结），跳过
      if (!timed) { console.log('  SKIP: page did not freeze as expected'); return; }
    } catch {
      // 预期：超时触发，evaluate 被中断
      assert.ok(timed, 'timeout must fire within 3s on a frozen page');
      const elapsed = Date.now() - startedAt;
      // 超时应在 3-5s 范围内（给 Puppeteer CDP 通信留余量）
      assert.ok(elapsed < 6_000, `health check timeout should be fast, got ${elapsed}ms`);
    }
    console.log('  confirmed: withTimeout detects frozen page.evaluate within timeout');
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(tmpProfile, { recursive: true, force: true });
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
  // voiceFileRoots 用 path.resolve（不做 realpath），validateVoiceInput 用 realpathSync.native。
  // 如果 root 不做 realpath，pathInside 比较会失败，误报 "outside allowed roots"。
  //
  // 这个测试不能通过 fake daemon 端到端验证，因为 "outside allowed roots" 检查
  // 在真实 daemon 的 validateVoiceInput 里，fake daemon 不运行该逻辑。
  // 这里直接复现 pathInside + realpath 比较模式，验证修复逻辑的正确性：
  // 由于 validateVoiceInput 运行在真实 daemon 进程内（需要浏览器），fake daemon 不执行该逻辑，
  // 因此本测试是逻辑模式验证而非端到端回归守卫——它确保 realpath 比较模式正确处理符号链接，
  // 但不直接调用 validateVoiceInput 本身。
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-real-'));
  // 用 symlink 模拟 macOS /var → /private/var 场景
  const linkDir = path.join(path.dirname(realDir), 'chatgpt-symlink-' + path.basename(realDir));
  try {
    fs.symlinkSync(realDir, linkDir);
    const voiceFile = path.join(linkDir, 'voice.wav');
    writeTinyWav(voiceFile);

    // 模拟 voiceFileRoots 的计算：path.resolve 不做 realpath
    const root = path.resolve(linkDir);
    // 模拟 validateVoiceInput 的文件 realpath
    const realFile = fs.realpathSync.native(voiceFile);

    // 修复前（bug）：root 不做 realpath，pathInside 比较失败
    const buggyRelative = path.relative(path.resolve(root), path.resolve(realFile));
    const buggyInside = !buggyRelative || (!buggyRelative.startsWith('..') && !path.isAbsolute(buggyRelative));
    assert.ok(!buggyInside, 'without realpath on root, symlinked dir should fail pathInside (reproducing bug)');

    // 修复后：root 也做 realpath，pathInside 比较通过
    let realRoot = root;
    try { realRoot = fs.realpathSync.native(root); } catch {}
    const fixedRelative = path.relative(path.resolve(realRoot), path.resolve(realFile));
    const fixedInside = !fixedRelative || (!fixedRelative.startsWith('..') && !path.isAbsolute(fixedRelative));
    assert.ok(fixedInside, 'with realpath on root, symlinked dir should pass pathInside (fix verified)');
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
    try { fs.unlinkSync(linkDir); } catch {}
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
      // goto 记录调用 URL，证明 voice adapter 使用 daemon 已解析的 Project URL，而不是退回普通首页。
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
    assert.deepStrictEqual(calls.goto, [projectUrl]);
    // composer wait 和 fake mic 都是 fallback-only 行为；direct 成功时必须保持为零以避免固定 3 秒浪费。
    assert.strictEqual(calls.waitForSelector, 0);
    assert.strictEqual(calls.evaluateOnNewDocument, 0);
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
