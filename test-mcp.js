#!/usr/bin/env node
'use strict';

/**
 * test-mcp.js — 不启动浏览器的 MCP 协议烟测
 *
 * 这些测试只覆盖 wrapper 层能确定的协议不变量：JSON-RPC id、batch、tool schema、
 * 超大 stdin 行和 notification。它们故意不发送真正 ask，避免 CI/本地检查依赖登录态、
 * ChatGPT Web DOM 或浏览器窗口。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
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

function main() {
  testBasicProtocol();
  testArgumentValidation();
  testOversizedLineRecovery();
  testExistingSessionIndexStartup();
}

function runServer(lines, env = {}) {
  // 每个用例独立启动 wrapper，避免 activeCalls、oversized-line 状态或环境变量在用例间串味。
  const child = spawnSync(process.execPath, ['mcp-server.js'], {
    input: lines.join('\n') + '\n',
    encoding: 'utf8',
    // wrapper 异常卡死要快速暴露；测试不能复现用户遇到的长时间阻塞。
    timeout: 5000,
    env: { ...BASE_ENV, ...env },
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
  assert.ok(responses.some(item => item.id === null && item.error?.code === -32600));
  assert.ok(responses.some(item => item.id === 3 && item.error?.code === -32601));
  assert.ok(batch?.some(item => item.id === 4 && item.result));
  assert.ok(batch?.some(item => item.id === 5 && item.result?.isError));
  assert.ok(batch?.some(item => item.id === 6 && item.error?.code === -32600));
}

function testArgumentValidation() {
  // 参数错误必须在 wrapper 内返回 tool error，不能启动浏览器，也不能触碰 ChatGPT 会话状态。
  // 这类错误是主 agent 最常犯的 schema 误用，应该快速、确定地失败。
  const responses = runServer([
    JSON.stringify({ jsonrpc: '2.0', id: 'status-args', method: 'tools/call', params: { name: 'status', arguments: { verbose: true } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 'ask-extra', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', onlyCode: true } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 'ask-bad-file', method: 'tools/call', params: { name: 'ask', arguments: { prompt: 'x', file: ['relative.txt'] } } }),
  ]);
  assert.ok(responses.every(item => item.result?.isError));
  assert.match(responses.find(item => item.id === 'ask-extra').result.content[0].text, /Unknown ask argument/);
  assert.match(responses.find(item => item.id === 'ask-bad-file').result.content[0].text, /absolute path/);
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
    });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
