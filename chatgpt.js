#!/usr/bin/env node
/**
 * chatgpt.js — Fast persistent-browser Codex-style CLI backed by chatgpt.com
 *
 * The browser runs as a background daemon so the launch/navigation overhead
 * only happens once. Subsequent calls take ~2-5s (ChatGPT response time only).
 *
 * Setup (first time):
 *   node chatgpt.js --login
 *
 * Usage:
 *   node chatgpt.js "prompt"                              # continue last chat
 *   node chatgpt.js --session-id #4fa92c "prompt"         # continue a session
 *   node chatgpt.js --file <path> "prompt"                # attach a file
 *   node chatgpt.js --git "write a commit message"        # attach git context
 *   node chatgpt.js --context "we use Fiber v2" "prompt"  # inline context
 *   cat error.log | node chatgpt.js "what is wrong"       # pipe input
 *   node chatgpt.js --status                              # check daemon
 *   node chatgpt.js --stop                                # kill daemon
 */

const { addExtra }        = require('puppeteer-extra');
const puppeteerCore       = require('puppeteer-core');
const StealthPlugin       = require('puppeteer-extra-plugin-stealth');
const path                = require('path');
const fs                  = require('fs');
const http                = require('http');
const readline            = require('readline');
const os                  = require('os');
const crypto              = require('crypto');
const { execSync, spawn } = require('child_process');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ─── Constants ────────────────────────────────────────────────────────────────

const CHROME_PATH      = process.env.CHATGPT_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const STATE_DIR        = path.resolve(process.env.CHATGPT_STATE_DIR || path.join(__dirname, '.chatgpt-poc'));
const USER_DATA_DIR    = path.resolve(process.env.CHATGPT_SESSION_DIR || defaultUserDataDir());
const PROFILE_DIR      = path.join(STATE_DIR, 'profile');
const PROJECTS_FILE    = path.join(STATE_DIR, 'projects.json');
const SESSION_INDEX_FILE = path.join(USER_DATA_DIR, 'sessions.json');
const DAEMON_FILE      = path.join(STATE_DIR, 'daemon.json');
const DAEMON_LOG       = path.join(STATE_DIR, 'daemon.log');
const CHATGPT_URL      = 'https://chatgpt.com';
const DEFAULT_PROJECT  = process.env.CHATGPT_PROJECT || process.env.CHATGPT_PROJECT_NAME || process.env.CHATGPT_PROJECT_URL || 'MCP';
const RESPONSE_TIMEOUT = positiveIntEnv('CHATGPT_RESPONSE_TIMEOUT_MS', 300_000); // 5 min — file analysis can be slow
const DAEMON_START_TIMEOUT = positiveIntEnv('CHATGPT_DAEMON_START_TIMEOUT_MS', 60_000);
const FILE_UPLOAD_TIMEOUT = positiveIntEnv('CHATGPT_FILE_UPLOAD_TIMEOUT_MS', 180_000);
const AUTO_SAVE_RESPONSE_CHARS = positiveIntEnv('CHATGPT_AUTOSAVE_RESPONSE_CHARS', 12_000);
const AUTO_SAVE_PREVIEW_CHARS = positiveIntEnv('CHATGPT_AUTOSAVE_PREVIEW_CHARS', 4_000);

// 运行状态和会话索引分离：浏览器 profile/daemon 放插件状态目录，#xxxxxx 会话索引放用户级 opencode 数据目录。
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are ChatGPT, an external assistant connected to opencode through the user's browser session.

Work as a high-signal research and engineering collaborator. Use the provided
code, diffs, logs, files, and task context together with your general knowledge
and any available web or research capabilities.

Prioritize:
- accurate, current answers grounded in evidence;
- practical debugging and implementation guidance;
- broad ecosystem, documentation, issue, and repository research when useful;
- concrete tradeoffs, risks, commands, code, or next steps when they help.

Match the user's requested depth. Be concise when the answer is simple, and be
thorough when research or analysis is needed. If information is uncertain, say
what is uncertain and give the best supported path forward.
---
`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim() || null));
  });
}

function readFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return fs.readFileSync(abs, 'utf8');
}

function getGitContext(cwd) {
  // git 是输入侧上下文开关：只读取当前 OpenCode 工作区的分支、状态和 diff，方便交给 ChatGPT 研究。
  const run = cmd => { try { return execSync(cmd, { encoding: 'utf8', cwd }).trim(); } catch { return ''; } };
  const branch = run('git branch --show-current');
  const status = run('git status --short');
  const diff   = run('git diff HEAD');
  if (!branch && !status && !diff) throw new Error('Not inside a git repo or no changes found.');
  let out = '';
  if (branch) out += `Branch: ${branch}\n`;
  if (status) out += `\nStatus:\n${status}\n`;
  if (diff)   out += `\nDiff:\n${diff}\n`;
  return out;
}

function buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData }) {
  const parts = [SYSTEM_PROMPT];
  if (contextData) parts.push(`Context:\n${contextData}\n`);
  if (gitData)     parts.push(`Git context:\n${gitData}\n`);
  if (fileData)    parts.push(`File content:\n\`\`\`\n${fileData}\n\`\`\`\n`);
  if (stdinData)   parts.push(`Input:\n\`\`\`\n${stdinData}\n\`\`\`\n`);
  parts.push(`Task: ${userPrompt}`);
  return parts.join('\n');
}

// ─── Browser helpers (daemon-side only) ───────────────────────────────────────

/**
 * Upload a local file to ChatGPT via direct CDP file-input injection.
 *
 * The ChatGPT composer always has a hidden <input id="upload-files"> in the DOM.
 * Puppeteer's uploadFile() uses the Chrome DevTools Protocol to set files on
 * the input element without needing a native file-picker dialog (which requires
 * a real user gesture and cannot be triggered programmatically in headless mode).
 * After setting the files via CDP we fire a synthetic change event so React's
 * event system picks up the new FileList and registers the attachment.
 */
function normalizePathList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

async function uploadFilesToChatGPT(page, uploadPaths, log) {
  const files = normalizePathList(uploadPaths).map(file => path.resolve(file));
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`Upload file not found: ${file}`);
  }
  if (files.length === 0) return;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log(`Uploading ${files.length} file(s), attempt ${attempt}: ${files.join(', ')}`);
      await page.bringToFront();
      await page.waitForSelector('#prompt-textarea', { timeout: 15_000 });
      const inputHandle = await page.waitForSelector('#upload-files', { timeout: 15_000 });

      // CDP 直接注入文件，支持一次上传多个文件，避免系统文件选择器和前台焦点依赖。
      await inputHandle.uploadFile(...files);
      await page.evaluate(() => {
        const el = document.getElementById('upload-files');
        if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
      });

      await dismissUploadDialog(page, log);
      await waitForUploadReady(page, log);
      log('Upload complete.');
      return;
    } catch (err) {
      log(`Upload attempt ${attempt} failed: ${err.message}`);
      if (attempt === 3 || !isRecoverableBrowserError(err)) throw err;
      await new Promise(r => setTimeout(r, 1_500));
    }
  }
}

async function dismissUploadDialog(page, log) {
  await new Promise(r => setTimeout(r, 1_000));
  const dialog = await page.$('[role="dialog"]');
  if (!dialog) return;
  const dialogText = await page.evaluate(el => el.textContent.trim().slice(0, 160), dialog).catch(() => 'unknown dialog');
  log(`Dismissing dialog: "${dialogText}"`);
  const okBtn = await page.$('[role="dialog"] button');
  if (okBtn) await okBtn.click();
  await new Promise(r => setTimeout(r, 800));
}

async function waitForUploadReady(page, log) {
  // 大 PDF/DOCX 上传后 ChatGPT 会在后台解析，send button 会保持 disabled；这里给文件任务更长等待。
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('button[data-testid="send-button"]');
      return btn && !btn.disabled;
    },
    { timeout: FILE_UPLOAD_TIMEOUT, polling: 1_000 }
  );
  log('Send button is enabled after upload.');
}

function isRecoverableBrowserError(err) {
  return /detached Frame|Execution context was destroyed|Cannot find context|Node is detached|Target closed|Protocol error|Runtime\.callFunctionOn timed out/i.test(err.message || '');
}

function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    headless: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-extensions-except=',
    ],
    defaultViewport: null,
    protocolTimeout: RESPONSE_TIMEOUT,
  });
}

function positiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function defaultUserDataDir() {
  if (process.env.OPENCODE_DATA_DIR) return path.join(process.env.OPENCODE_DATA_DIR, 'chatgpt-browser-agent');
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'opencode', 'chatgpt-browser-agent');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'chatgpt-browser-agent');
}

function normalizeProjectKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function normalizeSessionID(value) {
  // 对模型只暴露短句柄，避免把 ChatGPT 的真实 conversation URL 泄漏进 schema。
  if (!value) return null;
  const body = String(value).trim().toLowerCase().replace(/^#/, '');
  if (/^[a-f0-9]{6}$/.test(body)) return `#${body}`;
  throw new Error('sessionID must be a short handle like #4fa92c');
}

function parseProjectRef(value, name) {
  const input = String(value || '').trim();
  const token = input.match(/\/g\/(g-p-[^/]+)(?:\/|$)/)?.[1]
    || input.match(/^(g-p-[a-f0-9]+(?:-[a-z0-9-]+)?)$/i)?.[1];
  if (!token) return;
  const id = token.match(/^(g-p-[a-f0-9]+)/i)?.[1];
  if (!id) return;
  const url = `${CHATGPT_URL}/g/${token}/project`;
  const title = name || token.replace(id, '').replace(/^-/, '') || id;
  return { id, token, key: normalizeProjectKey(title || id), name: title, url };
}

function projectIdFromUrl(url) {
  return parseProjectRef(url)?.id;
}

function isChatSessionUrlForProject(url, project) {
  return projectIdFromUrl(url) === project.id && /\/c\//.test(url);
}

function isProjectEntryUrlForProject(url, project) {
  return projectIdFromUrl(url) === project.id && /\/project(?:$|[?#])/.test(url);
}

function isAllowedChatUrl(url, project) {
  return isProjectEntryUrlForProject(url, project) || isChatSessionUrlForProject(url, project);
}

function readProjectCache() {
  const cache = readJSON(PROJECTS_FILE, { projects: {} });
  return cache && typeof cache === 'object' && cache.projects ? cache : { projects: {} };
}

function cacheProject(project) {
  const cache = readProjectCache();
  const keys = new Set([project.id, project.token, project.key, normalizeProjectKey(project.name)]);
  for (const key of keys) {
    if (key) cache.projects[key] = project;
  }
  writeJSON(PROJECTS_FILE, cache);
}

function readSessionIndex() {
  const index = readJSON(SESSION_INDEX_FILE, { sessions: {} });
  return index && typeof index === 'object' && index.sessions ? index : { sessions: {} };
}

function createSessionID() {
  // 6 位 hex 足够短，生成时做碰撞检查；用户可以从任意目录用同一个 #id 继续会话。
  const index = readSessionIndex();
  for (let i = 0; i < 20; i++) {
    const id = `#${crypto.randomBytes(3).toString('hex')}`;
    if (!index.sessions[id]) return id;
  }
  throw new Error('Could not allocate a unique ChatGPT sessionID');
}

function readSessionEntry(sessionID, project) {
  const entry = readSessionIndex().sessions[sessionID];
  return entry && isAllowedChatUrl(entry.url, project) ? entry : null;
}

function writeSessionEntry(sessionID, project, url) {
  const index = readSessionIndex();
  const now = new Date().toISOString();
  index.sessions[sessionID] = {
    url,
    project: project.name,
    projectID: project.id,
    projectURL: project.url,
    createdAt: index.sessions[sessionID]?.createdAt || now,
    updatedAt: now,
  };
  writeJSON(SESSION_INDEX_FILE, index);
}

function sameUrl(a, b) {
  return String(a || '').replace(/[#?].*$/, '').replace(/\/$/, '') === String(b || '').replace(/[#?].*$/, '').replace(/\/$/, '');
}

function resolveWorkspaceDir(value) {
  const cwd = path.resolve(value || process.cwd());
  try { return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8' }).trim() || cwd; }
  catch { return cwd; }
}

function sessionCacheDirs(workspaceDir, sessionID) {
  // ChatGPT 生成物属于当前项目，因此文本快照和下载文件固定落到项目 .opencode/cache/chatgpt。
  const root = path.join(resolveWorkspaceDir(workspaceDir), '.opencode', 'cache', 'chatgpt');
  return {
    responses: path.join(root, 'responses', sessionID),
    downloads: path.join(root, 'downloads', sessionID),
  };
}

function timestampName(ext) {
  return `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}.${ext}`;
}

function saveResponseToFile(text, workspaceDir, sessionID) {
  const dir = sessionCacheDirs(workspaceDir, sessionID).responses;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, timestampName('md'));
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

async function resolveProject(page, requested, log) {
  const value = String(requested || DEFAULT_PROJECT).trim();
  const direct = parseProjectRef(value);
  if (direct) {
    cacheProject(direct);
    return direct;
  }

  const key = normalizeProjectKey(value);
  const cached = readProjectCache().projects[key];
  if (cached) return cached;

  log(`Resolving ChatGPT project: ${value}`);
  const discovered = await discoverProjects(page, log);
  const match = discovered.find(project =>
    normalizeProjectKey(project.name) === key ||
    project.key === key ||
    project.id === value ||
    project.token === value
  );
  if (match) return match;
  throw new Error(`Could not find ChatGPT project "${value}". Set CHATGPT_PROJECT to a project name or URL.`);
}

async function discoverProjects(page, log) {
  await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
  await new Promise(r => setTimeout(r, 1_000));

  const cachedProjects = await cachedProjectsFromPage(page);
  if (cachedProjects.length > 0) {
    for (const project of cachedProjects) cacheProject(project);
    log(`Discovered cached ChatGPT projects: ${cachedProjects.map(project => `${project.name}=${project.id}`).join(', ')}`);
    return cachedProjects;
  }

  for (let i = 0; i < 5; i++) {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, div.group.__menu-item, a.group.__menu-item')];
      const button = buttons.find(item => {
        const text = (item.innerText || item.textContent || '').trim();
        return ['Show more', 'More'].includes(text) && String(item.className).includes('__menu-item');
      });
      if (!button) return false;
      button.click();
      return true;
    });
    if (!clicked) break;
    await new Promise(r => setTimeout(r, 700));
  }

  const projects = await page.evaluate(() => {
    return [...document.querySelectorAll('a[href*="/g/g-p-"][href*="/project"]')]
      .map(anchor => ({
        name: (anchor.innerText || anchor.textContent || '').trim().split('\n')[0],
        href: anchor.href,
      }))
      .filter(project => project.name && project.href);
  });

  const parsed = projects
    .map(project => parseProjectRef(project.href, project.name))
    .filter(Boolean);
  for (const project of parsed) cacheProject(project);
  log(`Discovered ChatGPT projects: ${parsed.map(project => `${project.name}=${project.id}`).join(', ') || 'none'}`);
  return parsed;
}

async function cachedProjectsFromPage(page) {
  const projects = await page.evaluate(() => {
    const found = [];
    const seen = new WeakSet();
    for (const key of Object.keys(localStorage)) {
      if (!/(snorlax-history|pinned-items|gizmo)/.test(key)) continue;
      try { visit(JSON.parse(localStorage.getItem(key))); }
      catch {}
    }
    return found;

    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);

      const candidate = value.gizmo && value.gizmo.id ? value.gizmo : value;
      if (typeof candidate.id === 'string' && candidate.id.startsWith('g-p-')) {
        const name = candidate.display?.name || candidate.name;
        if (name) {
          found.push({
            name,
            href: `https://chatgpt.com/g/${candidate.short_url || candidate.id}/project`,
          });
        }
      }

      for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
    }
  });
  return projects
    .map(project => parseProjectRef(project.href, project.name))
    .filter(Boolean)
    .filter((project, index, all) => all.findIndex(item => item.id === project.id) === index);
}

// Single DOM operation — no keystroke simulation, no chunking, no delay.
// execCommand('insertText') is the fastest reliable way to fill a
// React-controlled contenteditable without breaking its event listeners.
async function fillTextarea(page, text) {
  await page.bringToFront();
  await page.waitForSelector('#prompt-textarea', { timeout: 10_000 });
  await page.click('#prompt-textarea');
  await page.evaluate(t => {
    const el = document.querySelector('#prompt-textarea');
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, t);
  }, text);
}

async function waitForStreamingDone(page, log, beforeState, options = {}) {
  // ChatGPT 有时会复用最后一个 assistant DOM 节点，而不是新增节点；因此同时记录数量和最后文本。
  if (beforeState === undefined || typeof beforeState === 'number') {
    beforeState = await assistantState(page, typeof beforeState === 'number' ? beforeState : undefined);
  }
  log(`waitForStreamingDone: beforeCount=${beforeState.count}`);

  // Phase 1 — wait for a new assistant message to appear (ChatGPT started replying).
  // polling:1000 reduces CDP round-trips on heavy pages and avoids
  // "Runtime.callFunctionOn timed out" errors that occur with the default 100ms poll.
  await page.waitForFunction(
    before => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const text = msgs.length > 0 ? (msgs[msgs.length - 1].innerText || '').trim() : '';
      if (msgs.length > before.count) return text.length > 0;
      return text.length > 0 && text !== before.lastText;
    },
    { timeout: RESPONSE_TIMEOUT, polling: 1_000 },
    beforeState
  ).catch(async err => {
    // On timeout, dump the DOM state to the log for debugging
    const dump = await page.evaluate(() => {
      const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
        .map(el => el.innerText.trim().slice(0, 100));
      const allRoles = [...document.querySelectorAll('[data-message-author-role]')]
        .map(el => `${el.getAttribute('data-message-author-role')}: ${(el.innerText||'').trim().slice(0,80)}`);
      const buttons = [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim().slice(0,30)).filter(Boolean);
      const url = location.href;
      return { assistants, allRoles, buttons: buttons.slice(0,15), url };
    }).catch(() => ({ error: 'page.evaluate failed' }));
    log(`waitForStreamingDone TIMEOUT dump: ${JSON.stringify(dump)}`);
    const current = await assistantState(page).catch(() => null);
    if (current && current.lastText && current.lastText !== beforeState.lastText) {
      log('waitForStreamingDone: continuing with changed assistant text after phase-1 timeout');
      return;
    }
    throw err;
  });

  // Phase 2 — wait for the final answer to stop growing. New ChatGPT UIs can
  // render a stable "Thinking" placeholder before the final text exists, so
  // don't treat that placeholder as a complete assistant response.
  let lastLen = -1;
  let lastChangedAt = Date.now();
  const deadline = Date.now() + RESPONSE_TIMEOUT;
  while (true) {
    if (Date.now() > deadline) {
      const current = await assistantState(page).catch(() => null);
      if (current && current.lastText && current.lastText !== beforeState.lastText) {
        log('waitForStreamingDone: response deadline reached, returning best available assistant text');
        break;
      }
      throw new Error('Timed out waiting for ChatGPT response to finish');
    }
    await new Promise(r => setTimeout(r, 750));
    const state = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const text = msgs.length > 0 ? msgs[msgs.length - 1].innerText : '';
      const labels = [...document.querySelectorAll('button')]
        .map(button => `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim())
        .filter(Boolean);
      const stopButton = !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]');
      return {
        len: text.length,
        text: text.replace(/\s+/g, ' ').trim(),
        generating: stopButton || labels.some(label => /stop|interrupt|cancel|停止|中止|取消/i.test(label)),
      };
    });
    const placeholder = /^(thinking|thinking\.\.\.|思考中|正在思考)$/i.test(state.text);
    if (state.len !== lastLen) {
      lastLen = state.len;
      lastChangedAt = Date.now();
      continue;
    }
    const stableMs = responseStableMs(state.len, options.slow);
    if (!state.generating && !placeholder && state.len > 0 && Date.now() - lastChangedAt >= stableMs) break;
  }
}

function responseStableMs(length, slow) {
  if (slow) return length < 1_000 ? 15_000 : length < 4_000 ? 18_000 : 22_000;
  return length < 1_000 ? 6_000 : length < 4_000 ? 8_000 : 12_000;
}

async function assistantState(page, count) {
  return page.evaluate(existingCount => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    return {
      count: existingCount ?? msgs.length,
      lastText: msgs.length > 0 ? (msgs[msgs.length - 1].innerText || '').trim() : '',
    };
  }, count);
}

async function extractLastAssistantMessage(page) {
  return page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    const root = msgs.length > 0
      ? msgs[msgs.length - 1].querySelector('.markdown, .prose') || msgs[msgs.length - 1]
      : [...document.querySelectorAll('.markdown, .prose')].at(-1);
    if (root) return markdownFromElement(root);
    return null;

    function markdownFromElement(root) {
      const text = cleanup([...root.childNodes].map(node => block(node, 0)).join(''));
      return normalizeReferences(text, root) || root.innerText.trim();
    }

    function cleanup(value) {
      return value
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function inlineChildren(el) {
      return [...el.childNodes].map(inline).join('');
    }

    function inline(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const el = node;
      const tag = el.tagName.toLowerCase();
      if (el.getAttribute('data-testid') === 'webpage-citation-pill' || el.closest('[data-testid="webpage-citation-pill"]')) return '';
      if (tag === 'br') return '\n';
      if (tag === 'button' || tag === 'svg') return '';
      if (tag === 'code' && !el.closest('pre')) return `\`${el.textContent || ''}\``;
      if (tag === 'strong' || tag === 'b') return `**${inlineChildren(el).trim()}**`;
      if (tag === 'em' || tag === 'i') return `*${inlineChildren(el).trim()}*`;
      if (tag === 'a') {
        const text = inlineChildren(el).trim() || el.href;
        return el.href ? `[${text}](${cleanHref(el.href, text)})` : text;
      }
      return inlineChildren(el);
    }

    function normalizeReferences(markdown, root) {
      const labels = new Map(
        [...root.querySelectorAll('[data-testid="webpage-citation-pill"] a[href]')]
          .map(link => [cleanHref(link.href, link.textContent || ''), cleanup(link.textContent || '')])
          .filter(([, label]) => label)
      );
      return markdown.replace(/^\[(\d+)\]\s+\[(https?:\/\/[^\]]+)\]\((https?:\/\/[^)]+)\)$/gm, (_, index, text, href) => {
        const clean = cleanHref(href, text);
        return `[${index}] [${labels.get(clean) || shortLinkLabel(clean)}](${clean})`;
      });
    }

    function shortLinkLabel(href) {
      try {
        const url = new URL(href);
        return url.hostname.replace(/^www\./, '');
      } catch {
        return href;
      }
    }

    function cleanHref(href, text) {
      try {
        const url = new URL(href);
        for (const key of [...url.searchParams.keys()]) {
          if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
        }
        const cleaned = url.toString();
        return /^https?:\/\//.test(text) ? text : cleaned;
      } catch {
        return href;
      }
    }

    function block(node, depth) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const el = node;
      const tag = el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'svg' || tag === 'style' || tag === 'script') return '';
      if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${inlineChildren(el).trim()}\n\n`;
      if (tag === 'p') return `${inlineChildren(el).trim()}\n\n`;
      if (tag === 'pre') return codeBlock(el);
      if (tag === 'blockquote') return quoteBlock(el, depth);
      if (tag === 'ul') return listBlock(el, depth, false);
      if (tag === 'ol') return listBlock(el, depth, true);
      if (tag === 'table') return tableBlock(el);
      if (tag === 'hr') return '---\n\n';
      if (tag === 'li') return listItem(el, depth, '-');
      if (tag === 'div' || tag === 'section' || tag === 'article') {
        return [...el.childNodes].map(child => block(child, depth)).join('');
      }
      return `${inline(el).trim()}\n\n`;
    }

    function codeBlock(el) {
      const code = el.querySelector('code');
      const codeText = (code ? code.innerText || code.textContent : el.innerText || el.textContent || '').trimEnd();
      const firstLine = (el.innerText || '').split('\n').map(line => line.trim()).find(Boolean) || '';
      const language = firstLine && !codeText.trimStart().startsWith(firstLine) && /^[a-zA-Z0-9_+#.-]{1,30}$/.test(firstLine)
        ? firstLine.toLowerCase()
        : '';
      return `\`\`\`${language}\n${codeText}\n\`\`\`\n\n`;
    }

    function quoteBlock(el, depth) {
      const text = cleanup([...el.childNodes].map(child => block(child, depth)).join(''));
      return `${text.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
    }

    function listBlock(el, depth, ordered) {
      const items = [...el.children].filter(child => child.tagName.toLowerCase() === 'li');
      return `${items.map((item, index) => listItem(item, depth, ordered ? `${index + 1}.` : '*')).join('')}\n`;
    }

    function listItem(el, depth, marker) {
      const indent = '  '.repeat(depth);
      const nested = [];
      const parts = [];
      for (const child of el.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
          nested.push(block(child, depth + 1).trimEnd());
          continue;
        }
        const text = child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === 'p'
          ? inlineChildren(child).trim()
          : cleanup(block(child, depth));
        if (text) parts.push(text);
      }
      const head = `${indent}${marker} ${parts.join('\n').trim()}\n`;
      return nested.length ? `${head}${nested.join('\n')}\n` : head;
    }

    function tableBlock(el) {
      const rows = [...el.querySelectorAll('tr')].map(row => [...row.children].map(cell => cleanup(cell.innerText || '')));
      if (rows.length === 0) return '';
      const header = rows[0];
      const separator = header.map(() => '---');
      return `${[header, separator, ...rows.slice(1)].map(row => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
    }
  });
}

async function downloadAssistantFiles(page, downloadDir, log) {
  fs.mkdirSync(downloadDir, { recursive: true });
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

  const files = await page.evaluate(() => {
    const msg = [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
    if (!msg) return [];
    return [...msg.querySelectorAll('button')]
      .map((button, index) => ({
        index,
        text: (button.innerText || button.textContent || '').trim().replace(/^(download|下载)\s+/i, ''),
        aria: button.getAttribute('aria-label') || '',
        className: button.className || '',
      }))
      .filter(button =>
        button.text &&
        !button.aria &&
        /behavior-btn|entity-underline/.test(button.className) &&
        /\.[a-z0-9]{1,12}$/i.test(button.text)
      );
  });

  const downloaded = [];
  for (const file of files) {
    log(`Downloading generated file: ${file.text}`);
    const before = snapshotDownloadDir(downloadDir);
    await page.evaluate(index => {
      const msg = [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
      const button = msg ? [...msg.querySelectorAll('button')][index] : undefined;
      button?.scrollIntoView({ block: 'center' });
      button?.click();
    }, file.index);
    downloaded.push({ name: file.text, path: await waitForDownloadedFile(downloadDir, before, file.text) });
  }
  return downloaded;
}

function snapshotDownloadDir(downloadDir) {
  if (!fs.existsSync(downloadDir)) return new Map();
  return new Map(
    fs.readdirSync(downloadDir)
      .filter(name => !name.endsWith('.crdownload') && !name.endsWith('.tmp'))
      .map(name => {
        const stat = fs.statSync(path.join(downloadDir, name));
        return [name, `${stat.size}:${stat.mtimeMs}`];
      })
  );
}

async function waitForDownloadedFile(downloadDir, before, expectedName) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const active = fs.readdirSync(downloadDir).some(name => name.endsWith('.crdownload') || name.endsWith('.tmp'));
    if (active) continue;

    const current = snapshotDownloadDir(downloadDir);
    const expected = current.get(expectedName);
    if (expected && expected !== before.get(expectedName)) return path.join(downloadDir, expectedName);

    for (const [name, marker] of current) {
      if (marker !== before.get(name)) return path.join(downloadDir, name);
    }
  }
  throw new Error(`Timed out waiting for generated file download: ${expectedName}`);
}

function formatResponse(result) {
  return [
    result.response || null,
    result.savedResponse ? `Response saved to:\n${result.savedResponse}` : null,
    result.downloads && result.downloads.length > 0
      ? ['Downloaded files:', ...result.downloads.map(file => `- ${file.name}: ${file.path}`)].join('\n')
      : null,
    result.sessionID ? `Session: ${result.sessionID}` : null,
  ].filter(Boolean).join('\n\n');
}

// ─── Daemon process ───────────────────────────────────────────────────────────

async function startDaemonProcess() {
  const logStream = fs.createWriteStream(DAEMON_LOG, { flags: 'a' });
  const log = msg => logStream.write(`[${new Date().toISOString()}] ${msg}\n`);

  log('Daemon starting...');

  let browser, page, project;
  try {
    browser = await launchBrowser();
    page    = await browser.newPage();

    project = await resolveProject(page, DEFAULT_PROJECT, log);

    log(`Navigating to fixed project: ${project.name} (${project.id})`);
    await page.goto(project.url, { waitUntil: 'networkidle2', timeout: 30_000 });

    const loggedOut = await page.evaluate(() => {
      const hasLoginBtn = [...document.querySelectorAll('button, a')]
        .some(el => ['Log in', 'Sign in'].includes(el.textContent.trim()));
      const hasInput = !!document.querySelector('#prompt-textarea');
      return hasLoginBtn && !hasInput;
    });

    if (loggedOut) {
      log('ERROR: Not logged in. Run: node chatgpt.js --login');
      await browser.close();
      process.exit(1);
    }

    log('Browser ready and logged in.');
  } catch (err) {
    log(`Startup error: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }

  // Serialize requests — ChatGPT is one-at-a-time.
  let busy = false;

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/status') {
      return send(200, { ok: true, pid: process.pid });
    }

    if (req.method === 'POST' && req.url === '/stop') {
      send(200, { ok: true });
      log('Shutting down...');
      server.close();
      await browser.close().catch(() => {});
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      process.exit(0);
    }

    if (req.method === 'POST' && req.url === '/ask') {
      if (busy) return send(503, { ok: false, error: 'Daemon busy — try again in a moment.' });
      busy = true;

      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', async () => {
        const { fullPrompt, uploadPath, uploadPaths, workspaceDir, sessionID: requestedSessionID, saveToFile } = JSON.parse(body);

        try {
          const sessionID = normalizeSessionID(requestedSessionID) || createSessionID();
          const files = normalizePathList(uploadPaths || uploadPath);
          log(`ask: sessionID=${sessionID} saveToFile=${!!saveToFile} uploads=${files.length || 'none'} workspace=${workspaceDir||process.cwd()} len=${fullPrompt.length}`);

          // sessionID 是全局句柄；存在则恢复对应 ChatGPT 会话，不存在则在固定 Project 中创建新会话。
          const session = readSessionEntry(sessionID, project);
          const targetUrl = session?.url || project.url;
          if (!sameUrl(page.url(), targetUrl)) {
            log(session ? `Restoring session ${sessionID}` : `Starting session ${sessionID} in ${project.name}`);
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
          }

          await uploadFilesToChatGPT(page, files, log);

          await fillTextarea(page, fullPrompt);

          // 发送前记录 assistant 状态，避免 ChatGPT 复用 DOM 节点时误判没有新回复。
          const beforeState = await assistantState(page);

          // Submit by pressing Enter in the focused textarea.
          // Clicking the send button is unreliable when text is selected or when
          // a file attachment is present — React handles keyboard Enter more robustly.
          await page.focus('#prompt-textarea');
          await page.keyboard.press('Enter');
          log('Submitted via Enter key');

          log('Prompt sent, waiting for response...');
          await waitForStreamingDone(page, log, beforeState, { slow: files.length > 0 || fullPrompt.length > 2_000 });

          const finalUrl = page.url();
          if (isAllowedChatUrl(finalUrl, project)) {
            writeSessionEntry(sessionID, project, finalUrl);
          }

          const raw = await extractLastAssistantMessage(page);
          if (!raw) throw new Error('Could not extract response from page');

          const dirs = sessionCacheDirs(workspaceDir, sessionID);
          fs.mkdirSync(dirs.downloads, { recursive: true });
          // 下载目录不暴露给模型，始终写到当前项目 cache，避免全局目录堆积生成物。
          const downloads = await downloadAssistantFiles(page, dirs.downloads, log);
          const autoSave = !saveToFile && raw.length > AUTO_SAVE_RESPONSE_CHARS;
          const savedResponse = saveToFile || autoSave ? saveResponseToFile(raw, workspaceDir, sessionID) : null;
          const response = saveToFile
            ? ''
            : autoSave
              ? `${raw.slice(0, AUTO_SAVE_PREVIEW_CHARS).trimEnd()}\n\n[Full response auto-saved because it was ${raw.length} characters.]`
              : raw;

          log(`Done: ${raw.length} chars`);
          send(200, { ok: true, response, downloads, savedResponse, sessionID });
        } catch (err) {
          log(`Error: ${err.message}`);
          send(500, { ok: false, error: err.message });
        } finally {
          busy = false;
        }
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
    fs.writeFileSync(DAEMON_FILE, JSON.stringify({ port, pid: process.pid }), 'utf8');
    log('Daemon ready.');
  });

  const shutdown = async signal => {
    log(`${signal} received, shutting down`);
    if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  // never returns — stays alive as the server
}

// ─── Client helpers ───────────────────────────────────────────────────────────

function readDaemonState() {
  if (!fs.existsSync(DAEMON_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
    process.kill(state.pid, 0); // throws if PID is dead
    return state;
  } catch {
    return null;
  }
}

function httpPost(port, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error('Invalid JSON from daemon')); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function ensureDaemon() {
  let state = readDaemonState();
  if (state) return state.port;

  if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE); // clean stale file

  process.stderr.write('[*] Starting browser daemon (first time ~15s)...\n');

  const child = spawn(process.execPath, [__filename, '--daemon-internal'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + DAEMON_START_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1_000));
    state = readDaemonState();
    if (state) {
      await new Promise(r => setTimeout(r, 300)); // let HTTP server bind
      process.stderr.write('[*] Daemon ready.\n');
      return state.port;
    }
  }

  throw new Error(`Daemon did not start. Check log: ${DAEMON_LOG}`);
}

// ─── Login (one-time setup, no daemon) ───────────────────────────────────────

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function login() {
  console.log('[*] Opening browser for manual login...');
  spawn(CHROME_PATH, [
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    parseProjectRef(DEFAULT_PROJECT)?.url || CHATGPT_URL,
  ], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  console.log('');
  console.log('  Log in to chatgpt.com in the browser window that opened.');
  console.log('  This login window is not controlled by Puppeteer, so Google OAuth');
  console.log('  is less likely to reject it as an insecure browser.');
  console.log('  When fully logged in and the chat interface is visible, close the browser window.');
  await waitForEnter('  Then press Enter here: ');
  console.log('[*] Done. Run: node chatgpt.js "your prompt here"');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    login: false, file: null, upload: [],
    git: false, context: null, stop: false, status: false, raw: false,
    saveToFile: false, sessionID: null, daemonInternal: false, cwd: null, workspace: null, prompt: [],
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--login':           opts.login          = true;  break;
      case '--git':             opts.git            = true;  break;
      case '--stop':            opts.stop           = true;  break;
      case '--status':          opts.status         = true;  break;
      case '--raw':             opts.raw            = true;  break;
      case '--save-to-file':    opts.saveToFile     = true;  break;
      case '--daemon-internal': opts.daemonInternal = true;  break;
      case '--file':            opts.file    = args[++i];    break;
      case '--upload':          opts.upload.push(args[++i]); break;
      case '--session-id':      opts.sessionID = args[++i];  break;
      case '--context':         opts.context = args[++i];    break;
      case '--cwd':             opts.cwd     = args[++i];    break;
      case '--workspace':       opts.workspace = args[++i];  break;
      default:                  opts.prompt.push(args[i]);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage:
  node chatgpt.js --login                               # first-time setup
  node chatgpt.js "prompt"                              # create a new #xxxxxx session
  node chatgpt.js --session-id #4fa92c "prompt"         # continue a session
  node chatgpt.js --file <path> "prompt"                # paste file content as text in prompt
  node chatgpt.js --upload <path> [--upload <path>] "prompt" # upload one or more files
  node chatgpt.js --save-to-file "prompt"               # save response under .opencode/cache/chatgpt
  node chatgpt.js --raw "prompt"                         # print response text only
  node chatgpt.js --git "write a commit message"        # attach git diff/status
  node chatgpt.js --context "we use Fiber v2" "prompt"  # inline context
  cat error.log | node chatgpt.js "what is wrong"       # pipe input
  node chatgpt.js --status                              # check if daemon is running
  node chatgpt.js --stop                                # shut down the daemon
`);
}

(async () => {
  const opts = parseArgs(process.argv);

  if (opts.daemonInternal) {
    await startDaemonProcess(); // never returns
    return;
  }

  if (opts.login) {
    await login().catch(err => { console.error('[ERROR]', err.message); process.exit(1); });
    return;
  }

  if (opts.stop) {
    const state = readDaemonState();
    if (!state) { console.log('[*] No daemon running.'); return; }
    try {
      await httpPost(state.port, '/stop', {});
      console.log('[*] Daemon stopped.');
    } catch {
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      console.log('[*] Daemon stopped.');
    }
    return;
  }

  if (opts.status) {
    const state = readDaemonState();
    if (!state) { console.log('[*] Daemon not running.'); return; }
    console.log(`[*] Daemon running — PID ${state.pid}, port ${state.port}`);
    return;
  }

  if (opts.prompt.length === 0) {
    printHelp();
    process.exit(1);
  }

  const userPrompt  = opts.prompt.join(' ');
  const stdinData   = await readStdin();
  const fileData    = opts.file    ? readFile(opts.file)  : null;
  const gitData     = opts.git     ? getGitContext(opts.cwd || process.cwd()) : null;
  const contextData = opts.context || null;

  const fullPrompt = buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData });

  try {
    const port   = await ensureDaemon();
    const result = await httpPost(port, '/ask', {
      fullPrompt,
      uploadPaths: opts.upload,
      workspaceDir: opts.workspace || opts.cwd || process.cwd(),
      sessionID: opts.sessionID || null,
      saveToFile: opts.saveToFile,
    });
    if (!result.ok) throw new Error(result.error || 'Daemon returned an error');
    const responseText = formatResponse(result);
    if (opts.raw) {
      console.log(responseText);
    } else {
      console.log('\n--- RESPONSE ---');
      console.log(responseText);
      console.log('--- END ---\n');
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    process.exit(1);
  }
})();
