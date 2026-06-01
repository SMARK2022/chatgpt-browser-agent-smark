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
 *   node chatgpt.js --new "prompt"                        # start fresh chat
 *   node chatgpt.js --code "write fizzbuzz in Go"         # extract code only
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
const { execSync, spawn } = require('child_process');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ─── Constants ────────────────────────────────────────────────────────────────

const CHROME_PATH      = process.env.CHATGPT_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const STATE_DIR        = path.resolve(process.env.CHATGPT_STATE_DIR || path.join(__dirname, '.chatgpt-poc'));
const PROFILE_DIR      = path.join(STATE_DIR, 'profile');
const SESSION_FILE     = path.join(STATE_DIR, 'session');
const DAEMON_FILE      = path.join(STATE_DIR, 'daemon.json');
const DAEMON_LOG       = path.join(STATE_DIR, 'daemon.log');
const CHATGPT_URL      = 'https://chatgpt.com';
const PROJECT_URL      = process.env.CHATGPT_PROJECT_URL || 'https://chatgpt.com/g/g-p-6a1b384bc3688191b5e2c522d45fbe20/project';
const RESPONSE_TIMEOUT = positiveIntEnv('CHATGPT_RESPONSE_TIMEOUT_MS', 300_000); // 5 min — file analysis can be slow
const DAEMON_START_TIMEOUT = positiveIntEnv('CHATGPT_DAEMON_START_TIMEOUT_MS', 60_000);

fs.mkdirSync(STATE_DIR, { recursive: true });

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

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```[\w]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trimEnd());
  return blocks.length > 0 ? blocks.join('\n\n') : text;
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
async function uploadFileToChatGPT(page, uploadPath, log) {
  const abs = path.resolve(uploadPath);
  if (!fs.existsSync(abs)) throw new Error(`Upload file not found: ${abs}`);
  log(`Uploading file: ${abs}`);

  await page.bringToFront();

  // Wait for the hidden file input to be present in the DOM
  const inputHandle = await page.waitForSelector('#upload-files', { timeout: 8_000 });

  // CDP-level file injection — no dialog needed
  await inputHandle.uploadFile(abs);

  // Notify React that the input's FileList changed
  await page.evaluate(() => {
    const el = document.getElementById('upload-files');
    if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Give ChatGPT's React handler a moment to process the file and render a preview
  await new Promise(r => setTimeout(r, 2_000));

  // ChatGPT may show a "You've already uploaded this file" warning dialog when
  // the same file has been uploaded recently.  Dismiss it so the flow continues.
  const dialog = await page.$('[role="dialog"]');
  if (dialog) {
    const dialogText = await page.evaluate(el => el.textContent.trim().slice(0, 120), dialog);
    log(`Dismissing dialog: "${dialogText}"`);
    const okBtn = await page.$('[role="dialog"] button');
    if (okBtn) await okBtn.click();
    await new Promise(r => setTimeout(r, 800));
  }

  log('Upload complete.');
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
  });
}

function positiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isProjectEntryUrl(url) {
  return url.startsWith(PROJECT_URL);
}

function isChatSessionUrl(url) {
  return url.startsWith(`${CHATGPT_URL}/c/`);
}

function isAllowedChatUrl(url) {
  return isProjectEntryUrl(url) || isChatSessionUrl(url);
}

function readChatSessionUrl() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  const url = fs.readFileSync(SESSION_FILE, 'utf8').trim();
  return isAllowedChatUrl(url) ? url : null;
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

async function waitForStreamingDone(page, log, beforeCount) {
  // beforeCount must be measured BEFORE the message is sent so we don't
  // accidentally measure it after ChatGPT has already started responding.
  // The caller passes it in; fall back to measuring now only for text-only paths.
  if (beforeCount === undefined) {
    beforeCount = await page.evaluate(
      () => document.querySelectorAll('[data-message-author-role="assistant"]').length
    );
  }
  log(`waitForStreamingDone: beforeCount=${beforeCount}`);

  // Phase 1 — wait for a new assistant message to appear (ChatGPT started replying).
  // polling:1000 reduces CDP round-trips on heavy pages and avoids
  // "Runtime.callFunctionOn timed out" errors that occur with the default 100ms poll.
  await page.waitForFunction(
    before => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (msgs.length <= before) return false;
      // Also ensure the last message has at least some text
      return (msgs[msgs.length - 1].innerText || '').trim().length > 0;
    },
    { timeout: RESPONSE_TIMEOUT, polling: 1_000 },
    beforeCount
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
    throw err;
  });

  // Phase 2 — wait for the final answer to stop growing. New ChatGPT UIs can
  // render a stable "Thinking" placeholder before the final text exists, so
  // don't treat that placeholder as a complete assistant response.
  let lastLen = -1;
  let lastChangedAt = Date.now();
  const deadline = Date.now() + RESPONSE_TIMEOUT;
  while (true) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ChatGPT response to finish');
    await new Promise(r => setTimeout(r, 750));
    const state = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const text = msgs.length > 0 ? msgs[msgs.length - 1].innerText : '';
      const labels = [...document.querySelectorAll('button')]
        .map(button => `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim())
        .filter(Boolean);
      return {
        len: text.length,
        text: text.replace(/\s+/g, ' ').trim(),
        generating: labels.some(label => /stop|interrupt|cancel|停止|中止|取消/i.test(label)),
      };
    });
    const placeholder = /^(thinking|thinking\.\.\.|思考中|正在思考)$/i.test(state.text);
    if (state.len !== lastLen) {
      lastLen = state.len;
      lastChangedAt = Date.now();
      continue;
    }
    const stableMs = state.len < 1_000 ? 2_500 : state.len < 4_000 ? 5_000 : 8_000;
    if (!state.generating && !placeholder && state.len > 0 && Date.now() - lastChangedAt >= stableMs) break;
  }
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
      return cleanup([...root.childNodes].map(node => block(node, 0)).join('')) || root.innerText.trim();
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
      if (tag === 'br') return '\n';
      if (tag === 'button' || tag === 'svg') return '';
      if (tag === 'code' && !el.closest('pre')) return `\`${el.textContent || ''}\``;
      if (tag === 'strong' || tag === 'b') return `**${inlineChildren(el).trim()}**`;
      if (tag === 'em' || tag === 'i') return `*${inlineChildren(el).trim()}*`;
      if (tag === 'a') {
        const text = inlineChildren(el).trim() || el.href;
        return el.href ? `[${text}](${el.href})` : text;
      }
      return inlineChildren(el);
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
  if (!result.downloads || result.downloads.length === 0) return result.response;
  return [
    result.response,
    'Downloaded files:',
    ...result.downloads.map(file => `- ${file.name}: ${file.path}`),
  ].join('\n\n');
}

// ─── Daemon process ───────────────────────────────────────────────────────────

async function startDaemonProcess() {
  const logStream = fs.createWriteStream(DAEMON_LOG, { flags: 'a' });
  const log = msg => logStream.write(`[${new Date().toISOString()}] ${msg}\n`);

  log('Daemon starting...');

  let browser, page;
  try {
    browser = await launchBrowser();
    page    = await browser.newPage();

    const initUrl = readChatSessionUrl() || PROJECT_URL;

    log(`Navigating to ${initUrl}`);
    await page.goto(
      isAllowedChatUrl(initUrl) ? initUrl : PROJECT_URL,
      { waitUntil: 'networkidle2', timeout: 30_000 }
    );

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
        const { fullPrompt, codeOnly, newChat, uploadPath, downloadDir } = JSON.parse(body);
        log(`ask: newChat=${newChat} codeOnly=${codeOnly} upload=${uploadPath||'none'} download=${downloadDir||'none'} len=${fullPrompt.length}`);

        try {
          const currentUrl = page.url();

          if (newChat) {
            log('Starting new project chat...');
            await page.goto(PROJECT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
          } else if (!isAllowedChatUrl(currentUrl)) {
            // Tab drifted (e.g. browser opened a link) — restore to the last ChatGPT conversation or project entry.
            const sessionUrl = readChatSessionUrl() || PROJECT_URL;
            log(`Restoring tab to ${sessionUrl}`);
            await page.goto(sessionUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
          }
          // else: already on the right chat page, skip navigation entirely

          if (uploadPath) await uploadFileToChatGPT(page, uploadPath, log);

          await fillTextarea(page, fullPrompt);

          // If a file was uploaded, wait until the send button is enabled.
          // ChatGPT uploads the file to its servers in the background; the send
          // button stays disabled until that upload finishes.  Clicking a disabled
          // button does nothing, which is what caused the previous silent failures.
          if (uploadPath) {
            log('Waiting for send button to become enabled (file upload in progress)...');
            await page.waitForFunction(
              () => {
                const btn = document.querySelector('button[data-testid="send-button"]');
                return btn && !btn.disabled;
              },
              { timeout: 60_000 }
            );
            log('Send button is now enabled.');
          }

          // Snapshot assistant count BEFORE submitting so waitForStreamingDone
          // can reliably detect the new response even if ChatGPT replies instantly.
          const beforeCount = await page.evaluate(
            () => document.querySelectorAll('[data-message-author-role="assistant"]').length
          );

          // Submit by pressing Enter in the focused textarea.
          // Clicking the send button is unreliable when text is selected or when
          // a file attachment is present — React handles keyboard Enter more robustly.
          await page.focus('#prompt-textarea');
          await page.keyboard.press('Enter');
          log('Submitted via Enter key');

          log('Prompt sent, waiting for response...');
          await waitForStreamingDone(page, log, beforeCount);

          const finalUrl = page.url();
          if (isAllowedChatUrl(finalUrl)) {
            fs.writeFileSync(SESSION_FILE, finalUrl, 'utf8');
          }

          const raw = await extractLastAssistantMessage(page);
          if (!raw) throw new Error('Could not extract response from page');

          const downloads = downloadDir ? await downloadAssistantFiles(page, path.resolve(downloadDir), log) : [];

          const output = codeOnly ? extractCodeBlocks(raw) : raw;
          log(`Done: ${output.length} chars`);
          send(200, { ok: true, response: output, downloads });
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
    PROJECT_URL,
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
    login: false, codeOnly: false, file: null, upload: null, save: null,
    git: false, context: null, newChat: false, stop: false, status: false, raw: false, downloadDir: null,
    daemonInternal: false, cwd: null, prompt: [],
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--login':           opts.login          = true;  break;
      case '--code':            opts.codeOnly       = true;  break;
      case '--git':             opts.git            = true;  break;
      case '--new':             opts.newChat        = true;  break;
      case '--stop':            opts.stop           = true;  break;
      case '--status':          opts.status         = true;  break;
      case '--raw':             opts.raw            = true;  break;
      case '--daemon-internal': opts.daemonInternal = true;  break;
      case '--file':            opts.file    = args[++i];    break;
      case '--upload':          opts.upload  = args[++i];    break;
      case '--save':            opts.save    = args[++i];    break;
      case '--download-dir':    opts.downloadDir = args[++i]; break;
      case '--context':         opts.context = args[++i];    break;
      case '--cwd':             opts.cwd     = args[++i];    break;
      default:                  opts.prompt.push(args[i]);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage:
  node chatgpt.js --login                               # first-time setup
  node chatgpt.js "prompt"                              # continue last chat (daemon auto-starts)
  node chatgpt.js --new "prompt"                        # force a new chat
  node chatgpt.js --code "write fizzbuzz in Go"         # extract code blocks only
  node chatgpt.js --file <path> "prompt"                # paste file content as text in prompt
  node chatgpt.js --upload <path> "prompt"              # upload file via ChatGPT attachment button
  node chatgpt.js --download-dir <dir> "prompt"          # download generated ChatGPT files
  node chatgpt.js --save <path> "prompt"                # save response to a file
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
      fullPrompt, codeOnly: opts.codeOnly, newChat: opts.newChat,
      uploadPath: opts.upload || null,
      downloadDir: opts.downloadDir || null,
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
    if (opts.save) {
      fs.writeFileSync(path.resolve(opts.save), responseText, 'utf8');
      console.error(`[*] Response saved to: ${path.resolve(opts.save)}`);
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    process.exit(1);
  }
})();
