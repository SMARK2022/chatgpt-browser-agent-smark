'use strict';

/**
 * chatgpt-dom.js — ChatGPT Web 页面适配器
 *
 * 这个文件集中处理 ChatGPT DOM、selector、网页下载按钮和 estuary 图片节点。
 * core 只拿普通对象，不拿 ElementHandle；这样页面 frame 重建、React 重渲染或后台 tab
 * 延迟渲染时，坏掉的是一次 DOM 读取，而不是整个 daemon 的业务状态。
 *
 * 适配器边界：
 *   - submit：上传附件、填写 composer、点击当前 page 的 send button。
 *   - waitForResponse：观察 assistant/user/copy/stop/image 状态，必要时返回 generating。
 *   - extractAssistant：把最后一条 assistant DOM 转成较完整的 Markdown。
 *   - collectArtifacts：保存 sandbox 下载文件和原生图片，统一返回本地路径。
 */

const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const MAX_ARTIFACTS = 16;
const MAX_UPLOAD_BYTES = positiveIntEnv('CHATGPT_MAX_UPLOAD_BYTES', 400 * 1024 * 1024);
const MAX_TOTAL_UPLOAD_BYTES = positiveIntEnv('CHATGPT_MAX_TOTAL_UPLOAD_BYTES', 800 * 1024 * 1024);
const MAX_ARTIFACT_BYTES = positiveIntEnv('CHATGPT_MAX_ARTIFACT_BYTES', 4 * 1024 * 1024 * 1024);
// sandbox 文件和原生图片共享同一个总数预算；ChatGPT 生成产物按原名保存，不额外改扩展名。
// 产物不按类型裁剪，也不额外做固定下载超时；只保留总量护栏和外层 ask 取消信号。

function positiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function uploadRoots(workspaceDir) {
  const explicit = (process.env.CHATGPT_UPLOAD_ROOTS || '').split(path.delimiter).map(item => item.trim()).filter(Boolean).map(item => path.resolve(item));
  return [...explicit, path.join(path.resolve(workspaceDir || process.cwd()), '.opencode', 'cache', 'chatgpt', 'uploads')];
}

function realUploadRoots(workspaceDir) {
  // 上传 root 在最后一跳重新 realpath；staging 目录若被移动/替换，直接失败而不是沿用启动时旧判断。
  return uploadRoots(workspaceDir).map(root => fs.realpathSync.native(root));
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 创建 DOM adapter。
 *
 * 这里保留一个 artifact 下载队列，因为 Chrome 的 downloadPath 是 browser context 级副作用，
 * 不是单个 page 的局部状态。多个会话可以并发生成文本，但下载阶段必须串行，否则一个会话
 * 设置的下载目录可能被另一个会话覆盖。
 */
function createChatGPTDom({ responseTimeout, asyncDetachMs }) {
  let artifactDownloadQueue = Promise.resolve();

  // ─── Public Adapter Surface ────────────────────────────────────────────────

  return {
    async state(page, count) {
      return assistantState(page, count);
    },

    async focus(page) {
      // 恢复读取前把目标页切到前台，降低后台 tab 延迟渲染导致的“文本已生成但 DOM 不完整”。
      await page.bringToFront().catch(() => {});
      await sleep(1_000);
    },

    async isLoggedOut(page) {
      // 登录态判断只返回页面事实；guest 首页也有 composer，但上传/项目会话能力并不可用。
      return page.evaluate(() => {
        const body = document.body?.innerText || '';
        const hasLoginBtn = [...document.querySelectorAll('button, a')]
          .some(el => /\b(log in|sign in)\b|登录|登入/i.test((el.textContent || '').trim()));
        const hasInput = !!document.querySelector('#prompt-textarea');
        // ChatGPT guest 首页允许输入，但不能稳定使用 Project、附件和历史会话；这里仍按 logged out 处理。
        const guestComposer = hasInput && hasLoginBtn && /log in to get answers|sign up for free|登录即可开始聊天|使用 .* 账户继续/i.test(body);
        return guestComposer || !hasInput && (hasLoginBtn || /\/auth|login|signin|登录|登入/i.test(location.href));
      });
    },

    async discoverProjects(page, log) {
      // 项目发现属于 ChatGPT Web DOM/localStorage 适配，而不是 daemon 状态机。
      // 先读 localStorage，避免依赖侧边栏是否展开；失败后再点击 Show more 并扫描 project 链接。
      await page.goto('https://chatgpt.com', { waitUntil: 'networkidle2', timeout: 30_000 });
      await sleep(1_000);
      const cached = await cachedProjectsFromPage(page);
      if (cached.length > 0) {
        log(`Discovered cached ChatGPT projects: ${cached.map(project => project.name).join(', ')}`);
        return cached;
      }

      for (let i = 0; i < 5; i++) {
        const clicked = await page.evaluate(() => {
          const items = [...document.querySelectorAll('button, div.group.__menu-item, a.group.__menu-item, [role="button"]')];
          const item = items.find(item => {
            const text = (item.innerText || item.textContent || '').trim();
            return /^(show more|more|显示更多|更多|展开)$/i.test(text) && (String(item.className).includes('__menu-item') || item.getAttribute('role') === 'button');
          });
          if (!item) return false;
          item.click();
          return true;
        });
        if (!clicked) break;
        await sleep(700);
      }

      const projects = await page.evaluate(() => [...document.querySelectorAll('a[href*="/g/g-p-"]')]
        .map(anchor => ({ name: (anchor.innerText || anchor.textContent || '').trim().split('\n')[0], href: anchor.href }))
        .filter(project => project.name && project.href));
      log(`Discovered ChatGPT project links: ${projects.map(project => project.name).join(', ') || 'none'}`);
      return projects;
    },

    /** 提交 prompt 前总是 bringToFront，降低后台 tab “已生成但 DOM 未刷新”的概率。 */
    async submit(page, prompt, files, workspaceDir, mode = 'auto', imageAspectRatio = null, log, shouldCancel = () => false, beforeSend = () => {}) {
      await page.bringToFront().catch(() => {});
      let sent = false;
      try {
        // 每次提交都从“无附件 composer”开始；新附件随后重新上传，避免任何上一轮 stale chip 串入本轮。
        await clearComposerAttachments(page, log);
        await assertNoComposerAttachments(page);
        await selectComposerMode(page, mode, log);
        await selectImageAspectRatio(page, mode, imageAspectRatio, log);
        await uploadFiles(page, files, workspaceDir, log, shouldCancel);
        if (shouldCancel()) throw new Error('Ask cancelled before prompt fill');
        const expectedPrompt = await fillPrompt(page, prompt);
        if (shouldCancel()) throw new Error('Ask cancelled before prompt submit');
        const before = await assistantState(page);
        if (shouldCancel()) throw new Error('Ask cancelled before send click');
        try {
          // click 后的 frame/navigation 异常属于“可能已提交”；core 会用 lost tombstone 阻止重发。
          await clickSend(page, expectedPrompt, () => {
            beforeSend();
            sent = true;
          });
        } catch (err) {
          if (sent) err.promptMayHaveBeenSent = true;
          throw err;
        }
        log('Submitted via send button');
        return before;
      } catch (err) {
        if (!sent && files.length > 0) await clearComposerAttachments(page, log).catch(cleanup => log(`Attachment cleanup failed: ${cleanup.message}`));
        throw err;
      }
    },

    /** 等待只返回状态，不保存文本；core 会基于状态决定 completed/pending 的落盘策略。 */
    async waitForResponse(page, before, options, log) {
      return waitForResponse(page, before, options || {}, log);
    },

    /** Markdown 抽取只读最后一条 assistant；历史消息由 ChatGPT 会话本身保存。 */
    async extractAssistant(page) {
      return extractAssistant(page);
    },

    /** artifact 收集必须在 adapter 内串行化，防止 Chrome downloadPath 串会话。 */
    async collectArtifacts(page, downloadDir, log, shouldCancel = () => false) {
      return withArtifactDownloadLock(async () => {
        // sandbox 与原生图片共用 artifact 数量/字节预算；耗时由外层 ask/MCP 生命周期决定。
        const files = await downloadSandboxFiles(page, downloadDir, log, MAX_ARTIFACTS, MAX_ARTIFACT_BYTES, shouldCancel).catch(err => ({ downloads: [], notices: [`Sandbox artifact collection failed: ${err.message}`] }));
        const images = await downloadNativeImages(page, downloadDir, log, Math.max(0, MAX_ARTIFACTS - files.downloads.length), Math.max(0, MAX_ARTIFACT_BYTES - downloadedBytes(files.downloads)), shouldCancel).catch(err => ({ downloads: [], notices: [`Native image collection failed: ${err.message}`] }));
        // 返回值保留成功产物和失败说明，core 可以展示部分成功结果而不是把整次回答判失败。
        return {
          downloads: [...files.downloads, ...images.downloads],
          notices: [...files.notices, ...images.notices],
        };
      });
    },
  };

  // ─── Project Discovery ────────────────────────────────────────────────────

  async function withArtifactDownloadLock(task) {
    // 队列失败也要吞掉并继续链下一个任务，否则一次下载错误会永久阻塞后续会话产物保存。
    const run = artifactDownloadQueue.then(task, task);
    artifactDownloadQueue = run.catch(() => {});
    return run;
  }

  async function cachedProjectsFromPage(page) {
    // localStorage 结构可能很深且有循环引用；WeakSet 防止递归扫描项目缓存时重复访问对象。
    return page.evaluate(() => {
      const found = [];
      const seen = new WeakSet();
      for (const key of Object.keys(localStorage)) {
        if (!/(snorlax-history|pinned-items|gizmo)/.test(key)) continue;
        try { visit(JSON.parse(localStorage.getItem(key))); }
        catch {}
      }
      return found.filter((project, index, all) => all.findIndex(item => item.href === project.href) === index);

      function visit(value) {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        const candidate = value.gizmo && value.gizmo.id ? value.gizmo : value;
        if (typeof candidate.id === 'string' && candidate.id.startsWith('g-p-')) {
          const name = candidate.display?.name || candidate.name;
          if (name) found.push({ name, href: `https://chatgpt.com/g/${candidate.short_url || candidate.id}/project` });
        }
        for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
      }
    });
  }

  // ─── Upload and Submit ────────────────────────────────────────────────────

  async function selectComposerMode(page, mode, log) {
    // mode 选择必须发生在 fillPrompt 之前；ChatGPT 切模式会重排 composer，晚选可能清空已填文本。
    const labels = {
      auto: null,
      search: '网页搜索',
      image: '创建图片',
    };
    const label = labels[mode || 'auto'];
    if (!label) return;
    // plus 菜单的模式项是 role=menuitemradio，而不是 button；这是实机 DOM 探测得到的稳定入口。
    await page.waitForSelector('#composer-plus-btn', { timeout: 10_000 });
    await page.click('#composer-plus-btn');
    await sleep(600);
    const clicked = await page.evaluate(label => {
      const item = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')]
        .find(el => (el.innerText || el.textContent || '').trim() === label);
      if (!item) return false;
      item.click();
      return true;
    }, label);
    if (!clicked) throw new Error(`Could not select ChatGPT composer mode: ${mode}`);
    await sleep(800);
    await page.keyboard.press('Escape').catch(() => {});
    const active = await page.evaluate(mode => {
      // 选中状态没有固定 data-testid，只能读 composer pill 的本地化文本/aria。
      // 这里用“可见 pill + 点击以重试”而不是菜单状态，避免菜单关闭后丢失判断依据。
      const input = document.querySelector('#prompt-textarea');
      const form = input?.closest('form') || input?.parentElement?.parentElement;
      if (!form) return false;
      const text = [...form.querySelectorAll('button, [role="button"]')]
        .map(el => `${el.innerText || el.textContent || ''} ${el.getAttribute('aria-label') || ''}`)
        .join(' ');
      if (mode === 'search') return /搜索，点击以重试|\b搜索\b/.test(text);
      if (mode === 'image') return /图片，点击以重试|选择图片宽高比|\b图片\b/.test(text);
      return true;
    }, mode);
    if (!active) throw new Error(`ChatGPT composer mode did not become active: ${mode}`);
    log(`Selected ChatGPT composer mode: ${mode}`);
  }

  async function selectImageAspectRatio(page, mode, ratio, log) {
    // 图片比例是“创建图片”模式下的二级 popover。每次 image ask 都显式选一次，避免沿用上次手动选择。
    if (mode !== 'image') return;
    const labels = {
      auto: '自动',
      square: '方形 1:1',
      portrait: '竖版 3:4',
      story: '故事版 9:16',
      landscape: '横版 4:3',
      wide: '宽屏 16:9',
    };
    const label = labels[ratio || 'auto'];
    if (!label) throw new Error(`Unsupported imageAspectRatio: ${ratio}`);
    // 先用真实鼠标事件打开 popover：实测 DOM .click() 有时只切 pill，不展开宽高比菜单。
    await page.waitForSelector('button[aria-label="选择图片宽高比"]', { timeout: 10_000 });
    await page.click('button[aria-label="选择图片宽高比"]');
    await sleep(1_000);
    const clicked = await page.evaluate(label => {
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
      const item = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')]
        .find(el => [el.innerText, el.textContent, el.getAttribute('aria-label')].some(value => norm(value) === label));
      if (!item) return false;
      item.click();
      return true;
    }, label);
    if (!clicked) throw new Error(`Could not select image aspect ratio: ${ratio || 'auto'}`);
    await sleep(500);
    const active = await page.evaluate(label => {
      // 选中后按钮可能只显示“方形/宽屏”而不显示完整比例；名称或数值命中任一即可确认。
      const text = (document.querySelector('button[aria-label="选择图片宽高比"]')?.innerText || '').replace(/\s+/g, ' ').trim();
      const [name, numeric] = label.split(' ');
      return text === label || text.includes(name) || numeric && text.includes(numeric);
    }, label);
    if (!active) throw new Error(`Image aspect ratio did not become active: ${ratio || 'auto'}`);
    await page.keyboard.press('Escape').catch(() => {});
    log(`Selected image aspect ratio: ${ratio || 'auto'}`);
  }

  /**
   * 通过隐藏的 file input 上传一个或多个文件。
   *
   * ChatGPT Web 在重复文件、frame 重建或大文件解析时会出现短暂 toast/dialog。
   * 这里不把 toast 文案当成功标准，只等待 send button 重新可用；如果 frame 已 detached，
   * 最多重试三次同一上传动作。
   */
  async function uploadFiles(page, files, workspaceDir, log, shouldCancel = () => false) {
    // 上传失败不能降级成无附件发送；先校验本地文件存在，再碰 ChatGPT 页面。
    for (const file of files) {
      if (!fs.existsSync(file)) throw new Error(`Upload file not found: ${file}`);
    }
    if (files.length === 0) return;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        log(`Uploading ${files.length} file(s), attempt ${attempt}: ${files.map(file => path.basename(file)).join(', ')}`);
        await page.waitForSelector('#prompt-textarea', { timeout: 15_000 });
        if (shouldCancel()) throw new Error('Ask cancelled during upload preparation');
        const names = files.map(file => path.basename(file));
        // 重试不能把“同名 chip 已存在”当作成功：它可能是上次取消/崩溃留下的旧附件。
        // 发现同名 chip 时先清理再重传，宁可多走一次 upload，也不要把旧文件发给新 prompt。
        if (await hasAttachmentNames(page, names)) {
          await clearComposerAttachments(page, log);
          await sleep(500);
        }
        const prepared = prepareUploadFiles(files, workspaceDir);
        try {
          const input = await page.waitForSelector('#upload-files', { timeout: 15_000 });
          const beforeCount = await attachmentCount(page);

          // CDP 只接收 path；先复制到 daemon 私有目录，再把稳定副本交给 Chromium，切断 staging 目录 TOCTOU。
          await input.uploadFile(...prepared.files);
          if (shouldCancel()) throw new Error('Ask cancelled after uploadFile');
          await page.evaluate(() => document.getElementById('upload-files')?.dispatchEvent(new Event('change', { bubbles: true })));
          await dismissUploadDialog(page, log);
          await waitForUploadReady(page, log, shouldCancel);
          if (shouldCancel()) throw new Error('Ask cancelled while upload was finalizing');
          // send button 可用只表示 composer 能发送；仍要确认本轮文件名出现在 composer 附件区域。
          await waitForAttachmentCount(page, beforeCount + files.length, names, shouldCancel);
          log('Upload complete.');
          return;
        } finally {
          cleanupUploadWorkDir(prepared.dir);
        }
      } catch (err) {
        log(`Upload attempt ${attempt} failed: ${err.message}`);
        if (attempt === 3 || !isRecoverableBrowserError(err)) throw err;
        await sleep(1_500);
      }
    }
  }

  function prepareUploadFiles(files, workspaceDir) {
    // 最后一跳不把 staging 路径直接交给 Chromium：先复制到 0700 临时目录，
    // 这样外部进程即使随后替换 staging 文件，也影响不到浏览器实际读取的副本。
    // 这里仍保留原 basename，保证 ChatGPT composer 上展示的附件名和用户传入文件一致。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-upload-'));
    ensurePrivateDir(dir);
    try {
      let total = 0;
      const prepared = files.map(file => {
        // lstat 拒绝 symlink，realpath 再确认最终目标仍在 upload root 内。
        const resolved = path.resolve(file);
        const linkStat = fs.lstatSync(resolved);
        if (!linkStat.isFile()) throw new Error(`Upload target is not a regular file at final check: ${file}`);
        const real = fs.realpathSync.native(resolved);
        if (!realUploadRoots(workspaceDir).some(root => pathInside(root, real))) throw new Error(`Upload file escaped allowed roots before browser upload: ${file}`);
        const stat = fs.statSync(real);
        if (!stat.isFile()) throw new Error(`Upload target changed before browser upload: ${file}`);
        if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`Upload file grew beyond ${MAX_UPLOAD_BYTES} bytes before browser upload`);
        total += stat.size;
        if (total > MAX_TOTAL_UPLOAD_BYTES) throw new Error(`Upload batch grew beyond ${MAX_TOTAL_UPLOAD_BYTES} bytes before browser upload`);
        const target = path.join(dir, path.basename(file));
        fs.copyFileSync(real, target);
        makePrivateFile(target);
        if (fs.statSync(target).size !== stat.size) throw new Error(`Upload copy size changed during final staging: ${file}`);
        return target;
      });
      return { dir, files: prepared };
    } catch (err) {
      cleanupUploadWorkDir(dir);
      throw err;
    }
  }

  function cleanupUploadWorkDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch { try { fs.renameSync(dir, nextAvailablePath(`${dir}.abandoned`)); } catch {} }
  }

  async function clearComposerAttachments(page, log) {
    // 取消发生在“附件已挂到 composer、prompt 尚未发送”的窗口时，必须清掉 chip，防止下次 prompt 串附件。
    // 只点 remove/delete 类按钮，不碰 send/菜单按钮；清理失败会作为日志，不自动继续发送。
    const removed = await page.evaluate(() => {
      const input = document.querySelector('#prompt-textarea');
      if (!input) return 0;
      const root = input.closest('form') || input.parentElement?.parentElement;
      if (!root) return 0;
      const buttons = [...root.querySelectorAll('button[aria-label], button')]
        .filter(button => /remove file|remove attachment|移除|删除|取消上传/i.test(`${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`));
      for (const button of buttons) button.click();
      return buttons.length;
    });
    if (removed) {
      log(`Cleared ${removed} uploaded attachment chip(s) after cancellation.`);
      await sleep(500);
    }
  }

  async function assertNoComposerAttachments(page) {
    const count = await attachmentCount(page);
    if (count > 0) throw new Error(`Composer still has ${count} attachment(s) after cleanup; refusing to send prompt`);
  }

  async function dismissUploadDialog(page, log) {
    // ChatGPT 可能弹出“文件已上传过”等对话；只点击明确的关闭/确认按钮，避免误触危险动作。
    await sleep(1_000);
    const dialog = await page.$('[role="dialog"]');
    if (!dialog) return;
    const text = await page.evaluate(el => el.textContent.trim().slice(0, 160), dialog).catch(() => 'unknown dialog');
    log(`Dismissing dialog: "${text}"`);
    const clicked = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const buttons = [...dialog.querySelectorAll('button')];
      const button = buttons.find(button => /close|cancel|ok|done|关闭|取消|确定|知道了/i.test(`${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`));
      if (!button) return false;
      button.click();
      return true;
    });
    if (!clicked) throw new Error(`Upload dialog requires manual handling: ${text}`);
    await sleep(800);
  }

  async function waitForUploadReady(page, log, shouldCancel) {
    // 大文件上传后前端会解析一段时间，send button disabled 是解析中信号，不应提前点击发送。
    // 不再给上传解析单独设固定超时；外层 MCP/CLI 取消才是统一生命周期边界。
    for (;;) {
      if (shouldCancel()) throw new Error('Ask cancelled while waiting for upload readiness');
      if (await page.evaluate(() => {
        const input = document.querySelector('#prompt-textarea');
        const button = input?.closest('form')?.querySelector('button[data-testid="send-button"]');
        return button && !button.disabled;
      })) {
        log('Send button is enabled after upload.');
        return;
      }
      await sleep(1_000);
    }
  }

  async function attachmentCount(page) {
    // 不再假设文件名一定有扩展名；计数只用于 cleanup 后的 sanity check，真正上传成功看期望 basename。
    // 只认 attachment/file chip 容器；普通按钮 aria-label（进阶、语音、项目菜单）不能算附件。
    return page.evaluate(() => {
      return attachmentTexts().length;

      function attachmentTexts() {
        const input = document.querySelector('#prompt-textarea');
        const root = input?.closest('form') || input?.parentElement?.parentElement;
        if (!root) return [];
        const texts = new Set();
        // 2026 版 ChatGPT 文件 tile 没有稳定 data-testid；真正稳定的是 role=group + 文件名 aria-label。
        // 先读 tile 容器可以避免把“移除文件”按钮和同一个文件名重复计数成两份附件。
        for (const el of root.querySelectorAll('[role="group"][aria-label]')) {
          const text = normalize(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`);
          if (text) texts.add(text);
        }
        if (texts.size > 0) return [...texts];
        for (const el of root.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"]')) {
          if (isUploadControl(el)) continue;
          const text = normalize(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`);
          if (text && !/^(send|stop|attach files?|upload files?|发送|停止|上传文件|添加文件等)$/.test(text)) texts.add(text);
        }
        return [...texts];
      }

      function isUploadControl(el) {
        return /^(input|textarea)$/i.test(el.tagName) || /^(upload-files|upload-photos|upload-camera)$/.test(el.id || '') || /upload-photos-input|composer-plus-btn/.test(el.getAttribute('data-testid') || '');
      }

      function normalize(value) {
        return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      }
    });
  }

  async function hasAttachmentNames(page, names) {
    return page.evaluate(names => {
      const haystack = attachmentHaystack();
      // basename 可能重复；用计数而不是 every/includes，避免一个 chip 伪装成两份同名附件。
      return names.every(name => haystack.includes(normalize(name)));

      function attachmentHaystack() {
        const input = document.querySelector('#prompt-textarea');
        const root = input?.closest('form') || input?.parentElement?.parentElement;
        if (!root) return '';
        // ChatGPT chip 文本不稳定：文件名可能在 aria-label 或可见文本里，统一拼接后按 basename 搜索。
        const parts = [];
        // role=group 是当前文件卡片的语义容器；data-testid 只作为旧版/变体 UI 的后备。
        for (const el of root.querySelectorAll('[role="group"][aria-label]')) {
          parts.push(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`);
        }
        for (const el of root.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"]')) {
          if (isUploadControl(el)) continue;
          parts.push(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`);
        }
        return normalize(parts.join(' '));
      }

      function isUploadControl(el) {
        return /^(input|textarea)$/i.test(el.tagName) || /^(upload-files|upload-photos|upload-camera)$/.test(el.id || '') || /upload-photos-input|composer-plus-btn/.test(el.getAttribute('data-testid') || '');
      }

      function normalize(value) {
        return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      }
    }, names);
  }

  async function waitForAttachmentCount(page, expected, names, shouldCancel) {
    // 上传结束以“预期数量的附件 chip 可见”为准，而不是以 toast 或 send button 状态为准。
    // 同时校验文件名，是为了挡住一种很隐蔽的失败：历史附件或页面其它 file 卡片让数量达标，
    // 但本次真正要发的附件并未挂到 composer 上。这里宁可等待外层取消，也不要发送“缺附件”的 prompt。
    // basename 可以包含空格、中文或没有扩展名；比较前统一 NFKC/空白/大小写，避免 UI 文本形态差异导致误判。
    for (;;) {
      if (shouldCancel()) throw new Error('Ask cancelled while waiting for attachment chips');
      if (await page.evaluate(({ count, names }) => {
        const texts = attachmentTexts();
        const haystack = texts.join(' ');
        return texts.length >= count && names.every(name => haystack.includes(normalize(name)));

        function attachmentTexts() {
          const input = document.querySelector('#prompt-textarea');
          const root = input?.closest('form') || input?.parentElement?.parentElement;
          if (!root) return [];
          const texts = new Set();
          // 等待上传完成时同样优先按 tile 容器计数；否则同一附件的标题、类型、删除按钮会制造假数量。
          for (const el of root.querySelectorAll('[role="group"][aria-label]')) {
            const text = normalize(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`);
            if (text) texts.add(text);
          }
          if (texts.size > 0) return [...texts];
          for (const el of root.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"]')) {
            if (isUploadControl(el)) continue;
            const text = normalize(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`);
            if (text && !/^(send|stop|attach files?|upload files?|发送|停止|上传文件|添加文件等)$/.test(text)) texts.add(text);
          }
          return [...texts];
        }

        function isUploadControl(el) {
          return /^(input|textarea)$/i.test(el.tagName) || /^(upload-files|upload-photos|upload-camera)$/.test(el.id || '') || /upload-photos-input|composer-plus-btn/.test(el.getAttribute('data-testid') || '');
        }

        function normalize(value) {
          return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
        }
      }, { count: expected, names })) return;
      await sleep(1_000);
    }
  }

  function isRecoverableBrowserError(err) {
    // 这些错误通常来自 React/Frame 重建，重试同一次上传动作比直接失败更符合浏览器实际行为。
    return /detached Frame|Execution context was destroyed|Cannot find context|Node is detached|Target closed|Protocol error|Runtime\.callFunctionOn timed out/i.test(err.message || '');
  }

  async function fillPrompt(page, text) {
    // execCommand('insertText') 能触发 contenteditable/React 的输入路径，比直接改 innerText 更稳定。
    // 插入后必须读回 composer 内容：ChatGPT 页面重渲染、焦点丢失或隐藏 composer 都可能让 insertText 静默失败。
    const expected = normalizeComposerText(text);
    await page.waitForSelector('#prompt-textarea', { timeout: 10_000 });
    const actual = await page.evaluate(value => {
      const el = document.querySelector('#prompt-textarea');
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, value);
      return composerText(el);

      function composerText(input) {
        return normalize((input?.innerText || input?.textContent || '').replace(/\r\n?/g, '\n'));
      }

      function normalize(value) {
        return String(value || '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
      }
    }, text);
    if (actual !== expected) throw new Error(`Composer fill verification failed: expected ${expected.length} chars, got ${actual.length}`);
    return expected;
  }

  async function clickSend(page, expectedPrompt, beforeClick) {
    // send button 必须来自当前 composer 的 form；全局 querySelector 可能点到隐藏/历史 composer。
    // 这里和 fillPrompt 做两次文本校验：第一次验证填充成功，第二次验证点击瞬间没有被 React 重置或用户焦点切换。
    await page.waitForFunction(value => {
      const input = document.querySelector('#prompt-textarea');
      const form = input?.closest('form');
      const button = form?.querySelector('button[data-testid="send-button"]');
      return button && !button.disabled && composerText(input) === value;

      function composerText(input) {
        return normalize((input?.innerText || input?.textContent || '').replace(/\r\n?/g, '\n'));
      }

      function normalize(value) {
        return String(value || '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
      }
    }, { timeout: 10_000, polling: 250 }, expectedPrompt);
    // waitForFunction 已通过后才布置 tombstone；这样 pre-click 校验失败不会污染 session registry。
    beforeClick();
    const clicked = await page.evaluate(value => {
      const input = document.querySelector('#prompt-textarea');
      const form = input?.closest('form');
      const button = form?.querySelector('button[data-testid="send-button"]');
      if (!button || button.disabled || composerText(input) !== value) return false;
      button.click();
      return true;

      function composerText(input) {
        return normalize((input?.innerText || input?.textContent || '').replace(/\r\n?/g, '\n'));
      }

      function normalize(value) {
        return String(value || '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
      }
    }, expectedPrompt);
    if (!clicked) throw new Error('Send button verification failed before click');
  }

  function normalizeComposerText(text) {
    // Windows 文本和 ChatGPT contenteditable 的换行表示不同；校验比较语义文本而不是 CRLF 字节形态。
    // ProseMirror 会把纯文本换行渲染为多个段落，innerText 读回时可能额外插入空行；发送前只校验字符顺序与语义空白。
    return String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
  }

  // ─── Response Waiting ─────────────────────────────────────────────────────

  /**
   * 等待回答开始并稳定。
   *
   * ChatGPT 的“完成”不是一个稳定 API 事件，只能综合 DOM 迹象：assistant 文本长度、
   * stop button、placeholder、copy button、原生图片数量。并发模式下，如果已确认用户消息
   * 提交但文本还没出现，会返回 generating，让 core 保存 pending 并释放本地调用。
   */
  async function waitForResponse(page, before, options, log) {
    // 等待拆成“开始”和“稳定”两段：先确认远端收下 prompt，再判断回答是否完成。
    before = before || await assistantState(page);
    log(`waitForResponse: beforeCount=${before.count}`);
    const startedAt = Date.now();
    // responseTimeout 是整次浏览器等待总预算；start/settle 共享同一个 deadline，避免外层 CLI 先超时。
    const deadline = startedAt + responseTimeout;
    const early = await waitUntilResponseStarts(page, before, options, startedAt, deadline, log);
    if (early) return early;
    return waitUntilResponseSettles(page, before, options, startedAt, deadline, log);
  }

  async function waitUntilResponseStarts(page, before, options, startedAt, deadline, log) {
    while (true) {
      const current = await assistantState(page).catch(() => null);
      if (current) {
        const submitted = current.userCount > before.userCount;
        if (options.shouldCancel?.() && submitted) return { status: 'generating', reason: 'client-disconnected' };
        // 原生图片可能没有 assistant 文本；图片数量增长也说明回答已经开始出现。
        if (submitted && current.nativeImageCount > before.nativeImageCount) return;
        if (submitted && ((current.count > before.count && current.lastText) || (current.lastText && current.lastText !== before.lastText))) return;
        if (shouldDetach(options, startedAt) && submitted) {
          // 并发生成时只要确认用户消息已提交，就允许本地先返回 generating，后续再 recovery。
          log('waitForResponse: detaching submitted session before assistant text appears');
          return { status: 'generating', reason: 'concurrent-detach-no-assistant' };
        }
      }
      if (Date.now() > deadline) {
        // 超时日志保存页面摘要，定位是 selector 漂移、未提交、仍在生成还是无 assistant 节点。
        log(`waitForResponse TIMEOUT dump: ${JSON.stringify(await domDump(page))}`);
        if (current && current.userCount > before.userCount) return { status: 'generating', reason: 'submitted-no-assistant' };
        throw new Error('Timed out waiting for ChatGPT response to start');
      }
      await sleep(1_000);
    }
  }

  async function waitUntilResponseSettles(page, before, options, startedAt, deadline, log) {
    let lastLen = -1;
    let lastImageCount = before.nativeImageCount;
    let lastChangedAt = Date.now();
    while (true) {
      if (Date.now() > deadline) {
        const current = await assistantState(page).catch(() => null);
        if (current?.userCount > before.userCount && current?.lastText && current.lastText !== before.lastText) {
          // 超时时已有文本则返回最佳快照，交给 core 保存 partial，而不是丢掉远端已生成内容。
          log('waitForResponse: deadline reached, returning best available assistant text');
          return { status: current.generating || current.placeholder ? 'generating' : 'completed', reason: 'response-timeout' };
        }
        if (current && current.userCount > before.userCount) return { status: 'generating', reason: 'submitted-no-assistant' };
        throw new Error('Timed out waiting for ChatGPT response to finish');
      }

      await sleep(750);
      const state = await assistantState(page);
      const submitted = state.userCount > before.userCount;
      // 未看到新 user 消息前，任何 assistant DOM 变化都可能是旧回答重排，不能归属给本轮请求。
      if (!submitted) continue;
      // 断连后如果用户消息已进入页面，尽快返回 generating，让 core 落 pending，而不是继续占住页面。
      if (options.shouldCancel?.()) return { status: 'generating', reason: 'client-disconnected' };
      const len = state.lastText.length;
      // lastText 可能仍是上一条 assistant；必须先证明文本或图片相对 before 发生了本轮新增。
      const hasNewText = (state.count > before.count && len > 0) || (state.lastText && state.lastText !== before.lastText);
      const responseLen = hasNewText ? len : 0;
      const hasNewNativeImage = state.nativeImageCount > before.nativeImageCount;
      if (shouldDetach(options, startedAt)) {
        if (!hasNewText && !hasNewNativeImage) return { status: 'generating', reason: 'concurrent-detach-no-assistant' };
        if (hasNewText || hasNewNativeImage) return { status: 'generating', reason: 'concurrent-detach-partial' };
      }
      if (responseLen !== lastLen || state.nativeImageCount !== lastImageCount) {
        lastLen = responseLen;
        lastImageCount = state.nativeImageCount;
        lastChangedAt = Date.now();
        continue;
      }

      const stableMs = responseStableMs(responseLen, options.slow);
      // copy button 出现且 stop/placeholder 消失时通常已完成；仍留短稳定窗口防最后一帧 DOM 更新。
      const doneStableMs = responseLen > 0 && state.copyButton && !state.generating && !state.placeholder ? Math.min(stableMs, 2_000) : stableMs;
      if (!state.generating && !state.placeholder && (hasNewText || hasNewNativeImage) && Date.now() - lastChangedAt >= doneStableMs) {
        return { status: 'completed', reason: 'stable' };
      }
    }
  }

  function shouldDetach(options, startedAt) {
    return options.detachWhenBusy && options.detachWhenBusy() && Date.now() - startedAt > asyncDetachMs;
  }

  async function assistantState(page, count) {
    // 外层只需要普通状态对象；不要把 DOM 节点句柄泄漏给 core，frame 重建时节点句柄很容易失效。
    return page.evaluate(existingCount => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
      const lastText = msgs.length > 0 ? (msgs[msgs.length - 1].innerText || '').trim() : '';
      const lastAssistant = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const emptyAssistantTurn = emptyUnroleAssistantTurn();
      const assistantLabels = [...(lastAssistant?.querySelectorAll('button') || [])]
        .map(button => `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim())
        .filter(Boolean);
      const stopButton = !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]');
      // 图片计数单独保留，覆盖“只有原生绘图结果、没有 assistant 文本”的完成路径。
      // 原生绘图回答会生成 image-turn，而不是 assistant role；全页计数才能让 image-only 任务从 pending 恢复。
      const nativeImageCount = generatedImageCount(document);
      return {
        count: existingCount ?? msgs.length,
        userCount,
        nativeImageCount,
        lastText,
        copyButton: assistantLabels.some(label => /copy|复制/i.test(label)),
        generating: stopButton,
        placeholder: /^(thinking|thinking\.\.\.|思考中|正在思考)$/i.test(lastText.replace(/\s+/g, ' ').trim()),
        emptyAssistantTurn,
        url: location.href,
      };

      function emptyUnroleAssistantTurn() {
        // Deep Research 实测会留下一个只有“ChatGPT 说：”的 turn，但没有 assistant role 节点。
        // stop button 已消失时，它不应让同一个 session 永久 pending。
        const turns = [...document.querySelectorAll('[data-testid^="conversation-turn"]')];
        return msgs.length === 0 && turns.some(turn => /^(ChatGPT\s*说[:：]?|ChatGPT said[:：]?)$/.test((turn.innerText || turn.textContent || '').replace(/\s+/g, ' ').trim()));
      }

      function generatedImageCount(root) {
        if (!root) return 0;
        return [...root.querySelectorAll('img')].filter(img => {
          const src = img.currentSrc || img.src || '';
          return /\/backend-api\/estuary\/content/.test(src) &&
            (/generated image/i.test(img.alt || '') || img.naturalWidth >= 256 || img.naturalHeight >= 256);
        }).length;
      }
    }, count);
  }

  // ─── Markdown Extraction ──────────────────────────────────────────────────

  async function domDump(page) {
    // dump 不记录正文片段；timeout 往往发生在私有材料分析时，日志只保留结构状态。
    return page.evaluate(() => {
      const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
        .map(el => ({ length: (el.innerText || '').trim().length, buttons: el.querySelectorAll('button').length }));
      const allRoles = [...document.querySelectorAll('[data-message-author-role]')]
        // 只记录角色和长度，不记录正文；daemon.log 不是回答归档。
        .map(el => ({ role: el.getAttribute('data-message-author-role'), length: (el.innerText || '').trim().length }));
      const buttons = [...document.querySelectorAll('button')]
        .map(button => button.getAttribute('aria-label') || button.textContent.trim().slice(0, 30))
        .filter(Boolean);
      return { assistants, allRoles, buttons: buttons.slice(0, 15), url: location.href };
    }).catch(() => ({ error: 'page.evaluate failed' }));
  }

  function responseStableMs(length, slow) {
    // 大文件和长 prompt 的回答通常会经历更长工具调用，稳定窗口相应拉长以减少早停。
    if (slow) return length < 1_000 ? 15_000 : length < 4_000 ? 18_000 : 22_000;
    return length < 1_000 ? 6_000 : length < 4_000 ? 8_000 : 12_000;
  }

  /**
   * 把最后一条 assistant 回答转换成 Markdown。
   *
   * 直接 innerText 会丢掉代码块语言、表格结构和链接语义；完全模拟复制按钮又依赖浏览器
   * clipboard 权限。这里做的是“信息量等价”的本地转换：保留正文结构，过滤按钮/SVG，
   * 同时把网页 citation pill 转成 `[Ref n]`，并在末尾补全本地 References 清单。
   */
  async function extractAssistant(page) {
    // 不直接返回 innerText：需要保留代码块、表格、列表和链接，同时过滤按钮/SVG/citation pill 噪音。
    return page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const root = msgs.length > 0
        ? msgs[msgs.length - 1].querySelector('.markdown, .prose') || msgs[msgs.length - 1]
        : [...document.querySelectorAll('.markdown, .prose')].at(-1);
      if (!root) return null;
      const citations = citationRegistry();
      const text = cleanup([...root.childNodes].map(node => block(node, 0)).join(''));
      return appendCitationReferences(normalizeReferences(text, root), citations.items()) || root.innerText.trim();

      function cleanup(value) {
        return value.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      }
      function inlineChildren(el) { return [...el.childNodes].map(inline).join(''); }
      function inline(node) {
        // inline 层只处理行内语义；citation pill 不是正文文字，但它承载来源 URL，必须转成稳定引用占位。
        if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const el = node;
        const tag = el.tagName.toLowerCase();
        const pill = el.getAttribute('data-testid') === 'webpage-citation-pill' ? el : el.closest('[data-testid="webpage-citation-pill"]');
        if (pill) return citationRef(pill);
        if (tag === 'br') return '\n';
        if (tag === 'button' || tag === 'svg') return '';
        if (tag === 'code' && !el.closest('pre')) return inlineCode(el.textContent || '');
        if (tag === 'strong' || tag === 'b') return `**${inlineChildren(el).trim()}**`;
        if (tag === 'em' || tag === 'i') return `*${inlineChildren(el).trim()}*`;
        if (tag === 'a') {
          const text = inlineChildren(el).trim() || el.href;
          return el.href ? `[${text}](${cleanHref(el.href, text)})` : text;
        }
        return inlineChildren(el);
      }
      function block(node, depth) {
        // block 层负责保留段落级结构；未知容器递归展开，避免 ChatGPT 改一层 div 就丢正文。
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
        if (tag === 'div' || tag === 'section' || tag === 'article') return [...el.childNodes].map(child => block(child, depth)).join('');
        return `${inline(el).trim()}\n\n`;
      }
      function codeBlock(el) {
        // 代码块必须单独处理，不能让 inline 的反引号规则破坏多行代码和语言标签。
        const code = el.querySelector('code');
        const codeText = (code ? code.innerText || code.textContent : el.innerText || el.textContent || '').trimEnd();
        const language = ((code?.className || el.className || '').match(/(?:language-|lang-)([a-zA-Z0-9_+#.-]{1,30})/) || [])[1] || '';
        const fence = fenceFor(codeText);
        return `${fence}${language.toLowerCase()}\n${codeText}\n${fence}\n\n`;
      }
      function inlineCode(text) { return `${fenceFor(text)}${text}${fenceFor(text)}`; }
      function fenceFor(text) { return '`'.repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map(match => match[0].length + 1))); }
      function quoteBlock(el, depth) {
        return `${cleanup([...el.childNodes].map(child => block(child, depth)).join('')).split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
      }
      function listBlock(el, depth, ordered) {
        return `${[...el.children].filter(child => child.tagName.toLowerCase() === 'li').map((item, index) => listItem(item, depth, ordered ? `${index + 1}.` : '*')).join('')}\n`;
      }
      function listItem(el, depth, marker) {
        // 嵌套列表先拆出子 ul/ol，再把当前 li 的普通文本合并，防止缩进层级塌掉。
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
        const rows = [...el.querySelectorAll('tr')].map(row => [...row.children].map(cell => tableCell(cell.innerText || '')));
        if (rows.length === 0) return '';
        return `${[rows[0], rows[0].map(() => '---'), ...rows.slice(1)].map(row => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
      }
      function tableCell(value) {
        // ChatGPT 的表格经常包含竖线或换行；转 Markdown 时不转义会把单元格拆坏。
        return cleanup(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
      }
      function normalizeReferences(markdown, root) {
        // 只归一化末尾 reference 行；正文中的普通链接保留原样，避免过度改写 ChatGPT 的表达。
        const labels = new Map([...root.querySelectorAll('[data-testid="webpage-citation-pill"] a[href]')]
          .map(link => [cleanHref(link.href, link.textContent || ''), cleanup(link.textContent || '')])
          .filter(([, label]) => label));
        return markdown.replace(/^\[(\d+)\]\s+\[(https?:\/\/[^\]]+)\]\((https?:\/\/[^)]+)\)$/gm, (_, index, text, href) => {
          const clean = cleanHref(href, text);
          return `[${index}] [${labels.get(clean) || shortLinkLabel(clean)}](${clean})`;
        });
      }
      function citationRegistry() {
        // 引用编号必须由本地分配：ChatGPT UI 的 pill 只保证 URL，不保证正文里出现稳定 `[1]`。
        // 按首次出现顺序编号，能同时服务“正文旁标注”和末尾 References，且不会依赖远端文案格式。
        const refs = [];
        return {
          index(href, label) {
            const clean = cleanHref(href, label || '');
            const found = refs.findIndex(ref => ref.href === clean);
            if (found >= 0) return found + 1;
            refs.push({ href: clean, label: cleanup(label || '') || shortLinkLabel(clean) });
            return refs.length;
          },
          items() { return refs; },
        };
      }
      function citationRef(pill) {
        // pill 内层 anchor 才是真正来源；外层 span 的站点名只适合作展示标签，不能当作 URL。
        const link = pill.querySelector?.('a[href]') || (pill.tagName?.toLowerCase() === 'a' ? pill : null);
        return link?.href ? `[Ref ${citations.index(link.href, link.textContent || link.href)}]` : '';
      }
      function appendCitationReferences(markdown, refs) {
        if (!refs.length) return markdown;
        const missing = refs.filter(ref => !markdown.includes(ref.href));
        if (missing.length === 0) return markdown;
        // 不点击“复制回复”：Puppeteer 实测 clipboard 不稳定，还会污染用户系统剪贴板。
        // 直接从 DOM anchor 补表，信息量比复制按钮更可控，也更适合 OpenCode 工具输出。
        return `${markdown}\n\nReferences:\n${missing.map((ref, index) => `[Ref ${refs.indexOf(ref) + 1}] [${ref.label}](${ref.href})`).join('\n')}`;
      }
      function cleanHref(href, text) {
        try {
          const url = new URL(href);
          for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
          return url.toString();
        } catch { return href; }
      }
      function shortLinkLabel(href) {
        try { return new URL(href).hostname.replace(/^www\./, ''); }
        catch { return href; }
      }
    });
  }

  // ─── Artifact Downloading ─────────────────────────────────────────────────

  /**
   * 下载 ChatGPT sandbox 生成的文件。
   *
   * sandbox 产物可能表现为文本按钮，也可能是 hover 后才出现按钮的文件卡片；两者都只从
   * 最后一条 assistant 中收集。点击前后对下载目录做快照，是为了识别真实落盘文件名，而
   * 不是盲信按钮显示的文件名。
   */
  async function downloadSandboxFiles(page, downloadDir, log, limit, byteBudget, shouldCancel) {
    if (limit <= 0) return { downloads: [], notices: [] };
    ensurePrivateDir(downloadDir);
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    try {
      const files = await page.evaluate(limit => {
        const msg = [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
        if (!msg) return [];
        const inlineButtons = [...msg.querySelectorAll('button')]
          .map((button, index) => {
            // 有些 sandbox 卡片按钮只叫 Download，没有文件名；先记录按钮位置，落盘后再以真实文件名为准。
            const label = (button.innerText || button.textContent || button.getAttribute('aria-label') || '').trim();
            const text = label.replace(/^(download|下载)\s+/i, '');
            return { kind: 'button', index, text: text || `artifact-${index + 1}`, label };
          })
          .filter(button => /download|下载/i.test(button.label) || /\.[a-z0-9]{1,16}$/i.test(button.text));
        const cards = [...msg.querySelectorAll('.group.my-4')]
          .map((card, index) => ({ kind: 'card', index, text: ((card.innerText || '').match(/[^\s]+\.[a-z0-9]{1,16}\b/i) || [])[0] || `artifact-card-${index + 1}` }))
          .filter(card => [...msg.querySelectorAll('.group.my-4')][card.index].querySelector('button:not([disabled])'));
        return [...inlineButtons, ...cards].slice(0, limit);
      }, limit);

      const downloads = [];
      const notices = [];
      let usedBytes = 0;
      for (const file of files) {
        if (shouldCancel()) { notices.push('Sandbox artifact collection stopped because caller cancelled'); break; }
        // 先下载到一次性目录，再 move 到最终 cache：安全检查失败时不会留下“看似可用”的裸产物。
        const workDir = path.join(downloadDir, `.artifact-download-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
        try {
          log(`Downloading generated file: ${file.text}`);
          ensurePrivateDir(workDir);
          await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: workDir });
          // 每个 artifact 都落在独立临时目录，失败或超时也不会把裸文件混入最终 downloads 根目录。
          const before = snapshotDownloadDir(workDir);
          const beforeTemp = snapshotTempFiles(workDir);
          const clicked = await page.evaluate(target => {
            const msg = [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
            const clean = value => (value || '').trim().replace(/^(download|下载)\s+/i, '');
            // 不复用发现阶段的 DOM index；React 重排后按文件名重新定位，宁可失败也不点错按钮。
            const button = target.kind === 'card'
              ? ([...msg.querySelectorAll('.group.my-4')].find(card => (card.innerText || '').includes(target.text)) || [...msg.querySelectorAll('.group.my-4')][target.index])?.querySelector('button:not([disabled])')
              : [...msg.querySelectorAll('button')].find(button => clean(button.innerText || button.textContent || button.getAttribute('aria-label') || '') === target.text) || [...msg.querySelectorAll('button')][target.index];
            if (!button) return false;
            button?.scrollIntoView({ block: 'center' });
            button?.click();
            return true;
          }, file);
          if (!clicked) throw new Error('download control disappeared before click');
          const saved = await waitForDownloadedFile(workDir, before, beforeTemp, file.text, shouldCancel);
          const size = fs.statSync(saved).size;
          if (usedBytes + size > byteBudget) {
            // Chrome 下载无法边下边限流，只能在稳定文件出现后立即删除超预算产物。
            fs.unlinkSync(saved);
            throw new Error(`artifact byte budget exceeded (${byteBudget} bytes)`);
          }
          // 保留原扩展名，避免把 ChatGPT 生成的文档/代码/压缩包改成需要二次手动恢复的格式。
          const target = nextAvailablePath(path.join(downloadDir, provenanceFileName(path.basename(saved), 'artifact')));
          fs.renameSync(saved, target);
          makePrivateFile(target);
          usedBytes += size;
          downloads.push({ name: path.basename(target), path: target });
        } catch (err) {
          notices.push(`Sandbox artifact failed (${file.text}): ${err.message}`);
        } finally {
          cleanupDownloadWorkDir(workDir);
        }
      }
      return { downloads, notices };
    } finally {
      // 下载目录是浏览器上下文级状态；用完立即恢复并 detach，避免后续手动下载落到会话 cache。
      await client.send('Page.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
      await client.detach().catch(() => {});
    }
  }

  /**
   * 保存 ChatGPT 原生绘图结果。
   *
   * 原生图片不走 sandbox，也通常没有下载按钮；页面里的 estuary/content URL 需要登录态 cookie。
   * 因此只在 page.evaluate 内发现 URL，实际 fetch/write 由 Node stream 完成。
   */
  async function downloadNativeImages(page, downloadDir, log, limit, byteBudget, shouldCancel) {
    if (limit <= 0) return { downloads: [], notices: [] };
    ensurePrivateDir(downloadDir);
    // 只在页面里发现候选 URL；实际字节用 Node stream 写盘，避免大图经过 CDP/base64 双重放大。
    // 这样仍然复用浏览器 cookie，但大文件压力落在 Node stream/backpressure，而不是 Puppeteer 协议消息。
    const result = await page.evaluate(limits => {
      // 原生图片生成结果可能落在独立 image-generation turn，而不是 assistant role 节点。
      // 这里扫描当前 conversation page 的 estuary 图；跨会话隔离由 core 的 page/session 绑定保证。
      // 下载阶段仍按 URL 去重，避免响应式预览图、overlay 图和真实图三层 DOM 指向同一个远端对象时重复落盘。
      const seen = new Set();
      const candidates = [...document.querySelectorAll('img')]
        .map(img => ({ src: img.currentSrc || img.src || '', alt: img.alt || '', width: img.naturalWidth || 0, height: img.naturalHeight || 0 }))
        .filter(img => {
          // 只收 ChatGPT 自己的 estuary 图片；普通 markdown 图片即使路径相似，也不能当作原生绘图结果保存。
          try { const url = new URL(img.src); return url.origin === location.origin && url.pathname.includes('/backend-api/estuary/content'); }
          catch { return false; }
        })
        .filter(img => /generated image/i.test(img.alt) || img.width >= 256 || img.height >= 256)
        .filter(img => seen.has(img.src) ? false : (seen.add(img.src), true))
        .slice(0, limits.maxImages);
      const notices = [];
      // notices 只记录“看见了候选但没保存”的情况；没有候选图时保持空，避免制造噪声。
      return { images: candidates.map(image => ({ ...image, sourceID: image.src.match(/[?&]id=([^&]+)/)?.[1] || '' })), notices };
    }, { maxImages: limit });

    const notices = [...(result.notices || [])];
    const downloads = [];
    let usedBytes = 0;
    for (const [index, image] of result.images.entries()) {
      if (shouldCancel()) { notices.push('Native image collection stopped because caller cancelled'); break; }
      let cancelPoll;
      let file;
      try {
        const controller = new AbortController();
        cancelPoll = setInterval(() => { if (shouldCancel()) controller.abort(); }, 500);
        const cookies = await page.cookies(image.src).catch(() => []);
        const response = await fetch(image.src, { headers: cookies.length > 0 ? { cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } : {}, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') || '';
        if (!/^image\/(png|jpe?g|webp|gif)/i.test(contentType)) throw new Error(`unsupported content type ${contentType || 'unknown'}`);
        const length = Number(response.headers.get('content-length') || 0);
        if (length && usedBytes + length > byteBudget) throw new Error(`artifact byte budget exceeded (${byteBudget} bytes)`);
        const ext = extensionFromContentType(contentType);
        const label = safeFileName(image.alt, `native-image-${index + 1}`);
        // sourceID 标识远端对象；同名冲突用 nextAvailablePath 解决，不再为计算 hash 把图片整块载入内存。
        const stableID = safeFileName(image.sourceID, 'remote');
        // 不覆盖旧图：同一回答 recovery 多次运行时，保留每次实际落盘结果，便于人工对照。
        file = nextAvailablePath(path.join(downloadDir, provenanceFileName(`${label}-${stableID}.${ext}`, `native-image-${index + 1}.${ext}`)));
        // 从 Node 侧串流落盘，避免 page.evaluate 把大图转 base64 后通过 CDP 一次性传回。
        if (fs.existsSync(file)) {
          // cache hit 只能复用普通文件；workspace cache 若被 symlink 污染，本张图失败但其它图继续保存。
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`native image cache path is not a regular file: ${file}`);
        } else if (response.body) await pipeline(Readable.fromWeb(response.body), byteLimitStream(byteBudget - usedBytes), fs.createWriteStream(file, { mode: 0o600 }));
        else {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (usedBytes + buffer.length > byteBudget) throw new Error(`artifact byte budget exceeded (${byteBudget} bytes)`);
          fs.writeFileSync(file, buffer, { mode: 0o600 });
        }
        makePrivateFile(file);
        usedBytes += fs.statSync(file).size;
        log(`Saved native generated image: ${file} (${image.width}x${image.height}, ${contentType || 'unknown type'})`);
        downloads.push({ name: path.basename(file), path: file });
      } catch (err) {
        if (file) cleanupPartialFile(file);
        notices.push(`Native image ${index + 1} was not saved: ${err.message}`);
      } finally {
        if (cancelPoll) clearInterval(cancelPoll);
      }
    }
    return { downloads, notices };
  }

  function downloadedBytes(downloads) {
    // 以实际落盘大小计算剩余预算；按钮名或 content-length 都只能作为提示，不能作为最终账本。
    return downloads.reduce((sum, file) => {
      try { return sum + fs.statSync(file.path).size; }
      catch { return sum; }
    }, 0);
  }

  function byteLimitStream(limit) {
    // Node fetch 能 streaming；无 content-length 时也能在写盘过程中及时停止，而不是等磁盘写满。
    let size = 0;
    return new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > limit) return callback(new Error(`artifact byte budget exceeded (${limit} bytes)`));
        callback(null, chunk);
      },
    });
  }

  function cleanupPartialFile(file) {
    // Windows 上失败 stream 可能短暂持锁；删除失败时改名为 abandoned，避免误当成完整产物。
    try { fs.rmSync(file, { force: true }); }
    catch { try { fs.renameSync(file, nextAvailablePath(`${file}.abandoned`)); } catch {} }
  }

  function snapshotDownloadDir(downloadDir) {
    // Chrome 下载中间态会出现 .crdownload/.tmp；快照只记录稳定文件的 size/mtime。
    if (!fs.existsSync(downloadDir)) return new Map();
    return new Map(fs.readdirSync(downloadDir)
      .filter(name => !name.endsWith('.crdownload') && !name.endsWith('.tmp'))
      .flatMap(name => {
        try {
          const stat = fs.statSync(path.join(downloadDir, name));
          return [[name, `${stat.size}:${stat.mtimeMs}`]];
        } catch { return []; }
      }));
  }

  function snapshotTempFiles(downloadDir) {
    // 旧的 .crdownload/.tmp 可能来自上次失败下载；本轮只等待“点击之后新出现”的临时文件结束。
    // 这样陈旧 temp 文件不会把之后每一次 artifact 收集都拖到超时。
    if (!fs.existsSync(downloadDir)) return new Set();
    return new Set(fs.readdirSync(downloadDir).filter(name => name.endsWith('.crdownload') || name.endsWith('.tmp')));
  }

  async function waitForDownloadedFile(downloadDir, before, beforeTemp, expectedName, shouldCancel) {
    // 先找期望文件；只允许 Chrome 对同名文件追加 “(1)” 这类重命名，不接受任意变化文件。
    for (;;) {
      if (shouldCancel()) throw new Error('caller cancelled while waiting for generated file download');
      await sleep(500);
      if (fs.readdirSync(downloadDir).some(name => (name.endsWith('.crdownload') || name.endsWith('.tmp')) && !beforeTemp.has(name))) continue;
      const current = snapshotDownloadDir(downloadDir);
      const expected = current.get(expectedName);
      if (expected && expected !== before.get(expectedName)) return path.join(downloadDir, expectedName);
      // 只接受 Chrome 针对同名下载生成的 file (1).ext 形式；其它单文件变化也可能来自用户手动下载。
      const renamed = [...current.keys()].filter(name => current.get(name) !== before.get(name) && isChromeRenameOf(name, expectedName));
      if (renamed.length === 1) return path.join(downloadDir, renamed[0]);
      if (renamed.length > 1) throw new Error(`Ambiguous artifact download; renamed candidates: ${renamed.join(', ')}`);
      // workDir 是本次点击独占目录；UI label 和 Chrome 保存名不一致时，唯一新稳定文件仍可安全认领。
      const changed = [...current.keys()].filter(name => current.get(name) !== before.get(name));
      if (changed.length === 1) return path.join(downloadDir, changed[0]);
      if (changed.length > 1) throw new Error(`Ambiguous artifact download; candidates: ${changed.join(', ')}`);
    }
  }

  function cleanupDownloadWorkDir(workDir) {
    // 失败产物只允许留在隔离目录；若 Windows 文件锁阻止删除，就保留 abandoned 目录便于人工排查。
    try { fs.rmSync(workDir, { recursive: true, force: true }); }
    catch { try { fs.renameSync(workDir, nextAvailablePath(`${workDir}.abandoned`)); } catch {} }
  }
}

function isChromeRenameOf(name, expectedName) {
  // 下载 fallback 必须“窄”：同 stem、同 ext、仅允许 Chrome 的括号序号，避免把无关文件误归属给 ChatGPT。
  const parsed = path.parse(name.toLowerCase());
  const expected = path.parse(expectedName.toLowerCase());
  return parsed.ext === expected.ext && (parsed.name === expected.name || /^ \(\d+\)$/.test(parsed.name.slice(expected.name.length)) && parsed.name.startsWith(expected.name));
}

// ─── Node-side Filename Helpers ───────────────────────────────────────────────

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function makePrivateFile(file) {
  try { fs.chmodSync(file, 0o600); } catch {}
}

function safeFileName(value, fallback) {
  // 文件名清理刻意保留 ASCII 子集；空结果、隐藏名和 Windows 设备名都落回稳定 fallback。
  const name = String(value || '').toLowerCase().replace(/^generated image:?\s*/i, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const base = path.parse(name).name;
  if (!name || name.startsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) return fallback;
  return name;
}

function provenanceFileName(value, fallback) {
  // 不改扩展名，避免破坏用户打开文件；只加来源前缀，让后续工具和人工审阅能区分远端产物。
  const name = safeFileName(value, fallback);
  return name.startsWith('chatgpt-') ? name : `chatgpt-${name}`;
}

function extensionFromContentType(contentType) {
  // content-type 缺失时默认 png，宁可保留可打开的图片扩展名，也不要生成无扩展文件。
  if (/png/i.test(contentType || '')) return 'png';
  if (/jpe?g/i.test(contentType || '')) return 'jpg';
  if (/webp/i.test(contentType || '')) return 'webp';
  if (/gif/i.test(contentType || '')) return 'gif';
  return 'png';
}

function nextAvailablePath(file) {
  // quarantine 是安全动作，不应该牺牲可追溯性；同名不覆盖，按 Chrome 风格追加序号。
  if (!fs.existsSync(file)) return file;
  const parsed = path.parse(file);
  for (let index = 1; index < 10_000; index++) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot allocate unique artifact path: ${file}`);
}

module.exports = { createChatGPTDom };
