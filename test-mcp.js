#!/usr/bin/env node
'use strict';

/**
 * test-mcp.js — 不启动浏览器的 MCP 协议烟测
 *
 * 这些测试只覆盖 wrapper 层能确定的协议不变量：JSON-RPC id、batch、tool schema、
 * 超大 stdin 行和 notification。它们故意不发送真正 ask，避免 CI/本地检查依赖登录态、
 * ChatGPT Web DOM 或浏览器窗口。
 *
 * 这里还固定覆盖 OpenCode 全局 config 深合并留下旧环境变量的回归路径：wrapper
 * 不应因为部署层 timeout 组合陈旧就在启动期退出，否则 host 只能看到 Connection closed。
 */

const assert = require('assert');
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
};

async function main() {
  testBasicProtocol();
  testLegacyTimeoutEnv();
  testArgumentValidation();
  testVoiceTranscribeIsPrivate();
  testTranscribeFileCliValidation();
  testOversizedLineRecovery();
  testExistingSessionIndexStartup();
  await testStatusReportsDisconnectedBrowser();
  await testVoiceSkipsStaleBrowserDaemon();
  await testAskSkipsStaleBrowserDaemon();
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
