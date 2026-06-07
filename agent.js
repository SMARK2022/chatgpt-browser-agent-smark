#!/usr/bin/env node
'use strict';

/**
 * agent.js — no-exec ChatGPT helper CLI
 *
 * 这个文件不实现“模型请求本地动作，然后本地执行”的 agentic loop。
 * 本项目的 MCP 定位是让 OpenCode 主 agent 调用 ChatGPT Web 做检索、分析、生成备选方案、
 * sandbox 数据处理和文档产物制作；本地命令执行与文件写入必须继续由 OpenCode 主 agent
 * 自己的工具权限、审批流和审计日志承接。它仍会复用 chatgpt.js 的 response cache，
 * 因此长回答或 --save-to-file 可能写入 .opencode/cache/chatgpt/。
 *
 * Usage:
 *   node agent.js [--cwd /path] [--session-id #id] [--save-to-file] "task"
 *
 * The helper sends a single prompt through chatgpt.js and prints the answer.
 * It never runs shell commands, applies patches, or modifies source files.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'chatgpt.js');
const MAX_PROMPT_CHARS = 200_000;
const CHILD_TIMEOUT = positiveIntEnv('CHATGPT_CLI_TIMEOUT_MS', 300_000);

// ─── CLI Parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // 入口参数刻意保持小：它只是 chatgpt.js 的只读薄封装，不复制 MCP schema。
  const args = { cwd: process.cwd(), sessionID: null, saveToFile: false, task: [] };
  for (let i = 0; i < argv.length; i++) {
    const next = flag => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (argv[i] === '--cwd') args.cwd = path.resolve(next('--cwd'));
    else if (argv[i] === '--session-id') args.sessionID = next('--session-id');
    else if (argv[i] === '--save-to-file') args.saveToFile = true;
    else if (argv[i].startsWith('--')) throw new Error(`Unknown option: ${argv[i]}`);
    else args.task.push(argv[i]);
  }
  args.task = args.task.join(' ').trim();
  return args;
}

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function usage() {
  return 'Usage: node agent.js [--cwd /path] [--session-id #id] [--save-to-file] "task"';
}

// ─── Prompt Assembly ──────────────────────────────────────────────────────────

function buildPrompt(args) {
  // 文件材料应由主 agent 审批并放入 prompt，或走 MCP file 上传；这个 helper 不直接读项目文件。
  const prompt = [
    `Task: ${args.task}`,
    `Working directory: ${args.cwd}`,
    '',
    'You are an external ChatGPT Web helper for OpenCode.',
    'Use web research, repository/document reasoning, sandbox analysis, data fitting, or document generation when useful.',
    'Do not ask for local shell commands and do not emit local file-write instructions for this helper to execute.',
    'Return findings, references, generated artifact descriptions, or analysis for the main OpenCode agent to consume.',
  ].join('\n');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`Prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  return prompt;
}

// ─── chatgpt.js Invocation ───────────────────────────────────────────────────

function askChatGPT(args) {
  assertWorkspaceAllowed(args.cwd);
  const payload = JSON.stringify({
    prompt: buildPrompt(args),
    cwd: args.cwd,
    workspace: args.cwd,
    sessionID: args.sessionID || undefined,
    saveToFile: args.saveToFile,
  });

  // prompt 走 stdin JSON，而不是 argv；Windows 命令行长度不该限制长文档分析任务。
  const result = spawnSync(process.execPath, [SCRIPT, '--raw', '--request-json', '-'], {
    input: payload,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const output = (result.stdout || '').trim() || (result.stderr || '').trim();
  if (result.error) throw new Error(output ? `${result.error.message}\n${output}` : result.error.message);
  if (result.status !== 0) throw new Error(output || `chatgpt.js exited with ${result.status ?? result.signal}`);
  return output;
}

function assertWorkspaceAllowed(cwd) {
  const roots = (process.env.CHATGPT_WORKSPACE_ROOTS || '').split(path.delimiter).map(item => item.trim()).filter(Boolean).map(item => path.resolve(item));
  if (roots.length === 0) throw new Error('agent.js requires CHATGPT_WORKSPACE_ROOTS so response cache writes stay inside an explicit workspace allowlist');
  const realCwd = require('fs').realpathSync.native(cwd);
  if (!require('fs').statSync(realCwd).isDirectory()) throw new Error(`--cwd must be a directory: ${cwd}`);
  if (!roots.map(root => require('fs').realpathSync.native(root)).some(root => pathInside(root, realCwd))) throw new Error(`--cwd is outside CHATGPT_WORKSPACE_ROOTS: ${cwd}`);
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error(usage());
    process.exit(1);
  }
  console.log(askChatGPT(args));
}

main();
