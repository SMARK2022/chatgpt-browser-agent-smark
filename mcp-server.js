#!/usr/bin/env node
/**
 * mcp-server.js — MCP stdio server wrapping the chatgpt daemon
 *
 * Registered in project-local .opencode/opencode.jsonc so the chatgpt tools
 * appear in OpenCode's MCP tools panel alongside other MCP servers.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

'use strict';

const { spawnSync } = require('child_process');
const readline      = require('readline');
const path          = require('path');

const SCRIPT = path.join(__dirname, 'chatgpt.js');
const CHATGPT_CLI_TIMEOUT = positiveIntEnv('CHATGPT_CLI_TIMEOUT_MS', 310_000);
const CHATGPT_STOP_TIMEOUT = positiveIntEnv('CHATGPT_STOP_TIMEOUT_MS', 30_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function positiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sendToolResult(id, result) {
  const payload = { content: [{ type: 'text', text: result.text }] };
  if (result.isError) payload.isError = true;
  send({ jsonrpc: '2.0', id, result: payload });
}

function normalizeToolName(name) {
  if (name === 'chatgpt_ask') return 'ask';
  if (name === 'chatgpt_status') return 'status';
  if (name === 'chatgpt_stop') return 'stop';
  return name;
}

function normalizeFiles(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function stopDaemon() {
  spawnSync(process.execPath, [SCRIPT, '--stop'], {
    encoding: 'utf8',
    timeout: CHATGPT_STOP_TIMEOUT,
    maxBuffer: 1024 * 1024,
  });
}

function shouldRestartDaemon(text) {
  return /detached Frame|Execution context was destroyed|Cannot find context|Target closed|Protocol error|Runtime\.callFunctionOn timed out/i.test(text);
}

/**
 * Run chatgpt.js with the given args array.
 * Returns trimmed stdout and marks non-zero process results as MCP tool errors.
 */
function runChatgpt(args, retry = true) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding:  'utf8',
    timeout:   CHATGPT_CLI_TIMEOUT,
    maxBuffer: 10 * 1024 * 1024,
  });
  const out = (result.stdout || '').trim();
  const err = (result.stderr || '').trim();
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      stopDaemon();
      return {
        text: `Error: ChatGPT request timed out after ${CHATGPT_CLI_TIMEOUT}ms; daemon was restarted automatically. Retry with the same sessionID, or use saveToFile for long answers.`,
        isError: true,
      };
    }
    return { text: `Error: ${result.error.message}`, isError: true };
  }
  if (result.status !== 0) {
    if (retry && shouldRestartDaemon(`${err}\n${out}`)) {
      stopDaemon();
      return runChatgpt(args, false);
    }
    return {
      text: err || out || `Error: chatgpt.js exited with status ${result.status}`,
      isError: true,
    };
  }
  return { text: out || err || '(no output)', isError: false };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'ask',
    description:
      'Ask ChatGPT via the user\'s logged-in chatgpt.com browser session. ' +
      'Use for web-backed research, current documentation, ecosystem and issue investigation, ' +
      'repository or architecture research, debugging ideas, implementation guidance, ' +
      'summarization, comparison, and other tasks where ChatGPT\'s web/project context can help. ' +
      'The daemon auto-starts on first use and stays alive between calls.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The question or task to send to ChatGPT',
        },
        sessionID: {
          type: 'string',
          description: 'Optional global ChatGPT session handle like #4fa92c. Omit to create a new session; pass an existing ID to continue it.',
        },
        context: {
          type: 'string',
          description: 'Additional curated context to prepend to the prompt',
        },
        git: {
          type: 'boolean',
          description: 'If true, attach git branch, status, and diff from the current OpenCode working directory as context',
        },
        file: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Absolute path, or array of absolute paths, to local files to upload to ChatGPT via the attachment button',
        },
        saveToFile: {
          type: 'boolean',
          description: 'If true, save ChatGPT\'s text response under <current-project>/.opencode/cache/chatgpt/responses/<sessionID>/ and return only metadata.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'status',
    description: 'Check whether the ChatGPT browser daemon is currently running.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop',
    description: 'Shut down the ChatGPT browser daemon and close the browser.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Request dispatcher ───────────────────────────────────────────────────────

function handleRequest(req) {
  const { id, method, params } = req;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities:   { tools: {} },
        serverInfo:     { name: 'chatgpt', version: '1.0.0' },
      },
    });
    return;
  }

  // Notification — no response required
  if (method === 'notifications/initialized') return;

  // ── Tool discovery ─────────────────────────────────────────────────────────
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  // ── Tool invocation ────────────────────────────────────────────────────────
  if (method === 'tools/call') {
    const name = normalizeToolName(params && params.name);
    const args = (params && params.arguments) || {};

    if (name === 'status') {
      sendToolResult(id, runChatgpt(['--status']));
      return;
    }

    if (name === 'stop') {
      sendToolResult(id, runChatgpt(['--stop']));
      return;
    }

    if (name === 'ask') {
      // MCP schema 只暴露意图参数：会话句柄、上下文、git、上传文件和是否保存回答。
      // project/new/download/save path 这些执行细节由本地 wrapper 固定处理。
      const flags = ['--raw', '--workspace', process.cwd()];
      if (args.sessionID)  flags.push('--session-id', args.sessionID);
      if (args.saveToFile) flags.push('--save-to-file');
      if (args.git) {
        flags.push('--git');
        // process.cwd() 是 OpenCode 启动目录，用它读取当前项目的 git 上下文。
        flags.push('--cwd', process.cwd());
      }
      if (args.context)  flags.push('--context', args.context);
      for (const file of normalizeFiles(args.file)) flags.push('--upload', file);
      flags.push(args.prompt);

      sendToolResult(id, runChatgpt(flags));
      return;
    }

    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    });
    return;
  }

  // Unknown method — only respond if it was a request (has id)
  if (id !== undefined) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

// ─── stdin loop ───────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handleRequest(req);
});

// Keep the process alive waiting for stdin
process.stdin.resume();
