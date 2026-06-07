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
  testLegacyTimeoutEnv();
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
