#!/usr/bin/env node
/**
 * mcp-server.js — MCP stdio server wrapping the chatgpt daemon
 *
 * Registered in ~/.config/opencode/opencode.json so the chatgpt tools
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

function defaultDownloadDir() {
  if (process.env.CHATGPT_DOWNLOAD_DIR) return path.resolve(process.env.CHATGPT_DOWNLOAD_DIR);
  if (process.env.OPENCODE_CHATGPT_DOWNLOAD_DIR) return path.resolve(process.env.OPENCODE_CHATGPT_DOWNLOAD_DIR);
  return path.join(process.cwd(), '.opencode', 'cache', 'chatgpt-downloads');
}

/**
 * Run chatgpt.js with the given args array.
 * Returns trimmed stdout and marks non-zero process results as MCP tool errors.
 */
function runChatgpt(args) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    encoding:  'utf8',
    timeout:   CHATGPT_CLI_TIMEOUT,
    maxBuffer: 10 * 1024 * 1024,
  });
  const out = (result.stdout || '').trim();
  const err = (result.stderr || '').trim();
  if (result.error) return { text: `Error: ${result.error.message}`, isError: true };
  if (result.status !== 0) {
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
        codeOnly: {
          type: 'boolean',
          description: 'If true, extract only code blocks from the response',
        },
        context: {
          type: 'string',
          description: 'Additional context to prepend to the prompt',
        },
        git: {
          type: 'boolean',
          description: 'If true, attach git status and diff from the current working directory as context',
        },
        newChat: {
          type: 'boolean',
          description: 'If true, start a fresh conversation instead of continuing the last one',
        },
        file: {
          type: 'string',
          description: 'Absolute path to a local file to upload to ChatGPT via the attachment button',
        },
        savePath: {
          type: 'string',
          description: 'Absolute path where ChatGPT\'s response should be saved as a text file',
        },
        downloadDir: {
          type: 'string',
          description: 'Optional absolute directory for generated ChatGPT sandbox/download files. Defaults to the current project .opencode cache.',
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

// ─── Dedup cache ──────────────────────────────────────────────────────────────
// Prevents the model from hitting ChatGPT multiple times with the same prompt
// within a short window (common when small models loop before outputting).

const CACHE_TTL = 60_000; // 60 seconds
const cache     = new Map(); // key → { text, ts }

function cacheKey(args) {
  return JSON.stringify({
    p:  args.prompt    || '',
    c:  args.context   || '',
    nc: !!args.newChat,
    co: !!args.codeOnly,
    g:  !!args.git,
    f:  args.file      || '',
  });
}

function cacheGet(args) {
  if (args.savePath) return null;
  const hit = cache.get(cacheKey(args));
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.text;
  return null;
}

function cachePut(args, text) {
  if (args.savePath) return;
  cache.set(cacheKey(args), { text, ts: Date.now() });
  // Evict stale entries
  for (const [k, v] of cache) {
    if (Date.now() - v.ts > CACHE_TTL) cache.delete(k);
  }
}

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
      // Return cached result if same prompt was called recently
      const cached = cacheGet(args);
      if (cached) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: cached }] } });
        return;
      }

      const flags = ['--raw'];
      if (args.newChat)  flags.push('--new');
      if (args.codeOnly) flags.push('--code');
      if (args.git) {
        flags.push('--git');
        // process.cwd() is the directory OpenCode was launched from — correct for git ops
        flags.push('--cwd', process.cwd());
      }
      if (args.context)  flags.push('--context', args.context);
      if (args.file)     flags.push('--upload',  args.file);
      flags.push('--download-dir', args.downloadDir || defaultDownloadDir());
      if (args.savePath) flags.push('--save',    args.savePath);
      flags.push(args.prompt);

      const result = runChatgpt(flags);
      if (!result.isError) cachePut(args, result.text);
      sendToolResult(id, result);
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
