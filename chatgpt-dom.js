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
const VOICE_DICTATION_TIMEOUT_MS = positiveIntEnv('CHATGPT_VOICE_DICTATION_TIMEOUT_MS', 45_000);
const VOICE_STOP_DELAY_MS = positiveIntEnv('CHATGPT_VOICE_STOP_DELAY_MS', 6_000);
const VOICE_STREAM_CHUNK_MS = positiveIntEnv('CHATGPT_VOICE_STREAM_CHUNK_MS', 250);
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
function createChatGPTDom({ responseTimeout }) {
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
      const cached = await cachedProjectsFromPage(page);
      if (cached.length > 0) {
        log(`Discovered cached ChatGPT projects: ${cached.map(project => project.name).join(', ')}`);
        return cached;
      }

      // 如果启动页已经是 chatgpt.com，就不要再刷新；只有不在 ChatGPT 域或 localStorage 为空时才回首页扫侧边栏。
      if (!/^https:\/\/chatgpt\.com\/?(?:[?#].*)?$/i.test(page.url())) {
        await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await sleep(1_000);
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
        await waitForComposer(page, log);
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

    async transcribeAudioFile(page, file, voiceUrl, log) {
      // Node 侧只读取一次文件；direct upload 和 fallback fake mic 共用同一份 base64，避免两次磁盘读取产生 TOCTOU 窗口。
      const audioBase64 = fs.readFileSync(file).toString('base64');
      // direct path 零页面操作：不 bringToFront、不 goto、不依赖任何 DOM 状态。
      // 它只在页面 JS 上下文中做 fetch 调用，对正在使用该页面的 ask 会话无副作用。
      try {
        // direct upload 是性能优化路径：成功时不触碰听写按钮，也不污染 composer 文本。
        const direct = await transcribeAudioFileDirect(page, audioBase64, file);
        log(`Direct voice transcription finished in ${direct.elapsedMs}ms`);
        // direct 成功时直接返回文本，让 TUI 插入光标位置；不需要模拟 ChatGPT composer 的听写结果。
        return direct.text;
      } catch (err) {
        // AbortError/timeout/target closed 表示页面可能退化或已被 invalidateVoicePage 关闭。
        // 不在同一退化/已关闭页面上尝试 fallback（听写 UI 也会同样挂起或立即报错）；
        // 直接抛错让外层 withTimeout 捕获，下次 voicePage() 会创建新页面。
        // 注意：AbortController.abort() 在页面侧抛 DOMException，但跨 CDP 边界后 .name 会丢失，
        // err.message 中包含 "abort" 字样，因此用 /abort/i 而非 err.name === 'AbortError'。
        // "target closed"/"protocol error" 表示页面已被外部关闭（stale cleanup、浏览器断开等），
        // fallback 同样会立即失败，不应在此页面上尝试。
        if (/timed out|timeout|abort|target closed|protocol error/i.test(err.message)) throw err;
        // ChatGPT Web 的私有 endpoint/header 可能随前端版本调整；fallback 继续用已验证的听写 UI，避免一次网页变更让语音输入彻底不可用。
        // fallback 日志只记录错误信息，不记录 token、请求体或音频内容，避免把登录态材料写进 daemon.log。
        log(`Direct voice transcription failed, falling back to dictation UI: ${err.message}`);
      }
      // fallback 需要 composer 和听写按钮；此时才做 bringToFront + goto 等页面操作。
      // fallback 需要项目页的 composer；direct 复用的页面可能不在项目页上。
      await page.bringToFront().catch(() => {});
      if (!/^https:\/\/chatgpt\.com\/g\//i.test(page.url())) {
        await page.goto(voiceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      // fallback 才依赖 React composer 和听写按钮；把等待放在这里，避免 direct 成功路径浪费固定 3 秒。
      await sleep(3_000);
      await waitForComposer(page, log);
      // fallback 从这里才安装 getUserMedia patch；direct 成功时页面不会获得任何 mock 麦克风能力。
      await installVoiceAudioInput(page, audioBase64);
      // fallback 使用 ChatGPT composer 作为转写结果承载；进入前清空它，避免旧草稿和听写结果混在一起。
      await clearComposerText(page);
      const button = await clickDictationButton(page);
      // 找不到按钮时输出可见控件快照，便于定位 ChatGPT UI 文案漂移，而不是静默回空文本。
      if (!button) throw new Error(`Could not find ChatGPT dictation button. Visible controls: ${JSON.stringify(await voiceControlSnapshot(page))}`);
      log(`Clicked dictation control: ${button.label || button.index}`);
      await waitForInjectedVoiceAudio(page);
      log('Injected voice audio finished');
      // ChatGPT 听写不是本地同步解码：fake mic 音频结束后还要给页面/远端识别链路一点时间，
      // 否则过早点击 stop 会得到空 composer。默认值对齐此前 probe 中成功识别 hello-world 的观察窗口。
      await sleep(VOICE_STOP_DELAY_MS);
      const stop = await clickStopDictation(page);
      if (stop) log(`Clicked stop dictation control: ${stop.label || stop.index}`);
      const text = await waitForComposerText(page);
      // 成功后清空 composer，让 TUI 侧只接收返回文本，不把 probe/fallback 残留留给下一次 prompt。
      await clearComposerText(page);
      // 空白结果说明网页听写链路失败；抛错比把空字符串插入用户输入框更可诊断。
      if (!text.trim()) throw new Error('ChatGPT dictation returned empty text');
      return text;
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
    async collectArtifacts(page, downloadDir, log, shouldCancel = () => false, beforeState = null) {
      return withArtifactDownloadLock(async () => {
        // sandbox 与原生图片共用 artifact 数量/字节预算；耗时由外层 ask/MCP 生命周期决定。
        const files = await downloadSandboxFiles(page, downloadDir, log, MAX_ARTIFACTS, MAX_ARTIFACT_BYTES, shouldCancel).catch(err => ({ downloads: [], notices: [`Sandbox artifact collection failed: ${err.message}`] }));
        const images = await downloadNativeImages(page, downloadDir, log, Math.max(0, MAX_ARTIFACTS - files.downloads.length), Math.max(0, MAX_ARTIFACT_BYTES - downloadedBytes(files.downloads)), shouldCancel, beforeState?.nativeImageURLs || []).catch(err => ({ downloads: [], notices: [`Native image collection failed: ${err.message}`] }));
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
    // UI 文案会跟随账号语言变化；公开 API 不能要求用户把 ChatGPT 固定成中文界面。
    // 因此 adapter 只在这一层维护中英文 label，schema 仍暴露稳定的 `image` 语义。
    const labels = {
      auto: null,
      image: ['创建图片', 'Create image'],
    };
    const options = labels[mode || 'auto'];
    if (!options) return;
    // plus 菜单的模式项是 role=menuitemradio，而不是 button；这是实机 DOM 探测得到的稳定入口。
    await page.waitForSelector('#composer-plus-btn', { timeout: 10_000 });
    await page.click('#composer-plus-btn');
    await sleep(600);
    const clicked = await page.evaluate(options => {
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const item = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], button')]
        .find(el => options.some(label => norm(el.innerText || el.textContent || el.getAttribute('aria-label')) === norm(label)));
      if (!item) return false;
      item.click();
      return true;
    }, options);
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
      if (mode === 'image') return /图片，点击以重试|选择图片宽高比|\b图片\b|image, click to retry|select image aspect ratio|\bimage\b/i.test(text);
      return true;
    }, mode);
    if (!active) throw new Error(`ChatGPT composer mode did not become active: ${mode}`);
    log(`Selected ChatGPT composer mode: ${mode}`);
  }

  async function selectImageAspectRatio(page, mode, ratio, log) {
    // 图片比例是“创建图片”模式下的二级 popover。每次 image ask 都显式选一次，避免沿用上次手动选择。
    if (mode !== 'image') return;
    const labels = {
      auto: ['自动', 'Auto'],
      square: ['方形 1:1', '正方形 1:1', 'Square 1:1'],
      portrait: ['竖版 3:4', 'Portrait 3:4'],
      story: ['故事版 9:16', 'Story 9:16'],
      landscape: ['横版 4:3', 'Landscape 4:3'],
      wide: ['宽屏 16:9', 'Wide 16:9'],
    };
    const options = labels[ratio || 'auto'];
    if (!options) throw new Error(`Unsupported imageAspectRatio: ${ratio}`);
    // 宽高比按钮本身也本地化：先在 composer 内找“比例/ratio”按钮，再用页面侧真实 click 打开 popover。
    // 不直接依赖单个 aria-label，是因为中文界面显示“选择图片宽高比”，英文界面可能只保留 ratio 文案；
    // 但入口匹配不能只看 Auto：composer 里还有模型/工具的 Auto 按钮，点错会打开无关菜单。
    const openerSelector = () => {
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
      const input = document.querySelector('#prompt-textarea');
      const form = input?.closest('form') || input?.parentElement?.parentElement;
      return [...(form?.querySelectorAll('button, [role="button"]') || [])]
        .find(item => /选择图片宽高比|image aspect ratio|aspect ratio|ratio|1:1|3:4|9:16|4:3|16:9|方形|正方形|square|竖版|portrait|故事版|story|横版|landscape|宽屏|wide/i.test(`${norm(item.innerText || item.textContent)} ${norm(item.getAttribute('aria-label'))}`)) || null;
    };
    await page.waitForFunction(openerSelector, { timeout: 10_000 });
    const openerHandle = await page.evaluateHandle(openerSelector);
    const openerElement = openerHandle.asElement();
    if (!openerElement) throw new Error(`Could not open image aspect ratio menu`);
    const openerText = await openerElement.evaluate(el => `${el?.innerText || el?.textContent || ''} ${el?.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim()).catch(() => 'unknown');
    // 这里必须用 Puppeteer 的 ElementHandle.click() 走真实鼠标事件；ChatGPT 的 popover 绑定在交互事件链上，
    // 直接在 page.evaluate 里调用 DOM .click() 实测会出现“按钮被点了但菜单没有打开”的假成功。
    await openerElement.click();
    await openerHandle.dispose().catch(() => {});
    await sleep(1_000);
    const clicked = await page.evaluate(options => {
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
      const numerics = options.map(label => norm(label).match(/\d+:\d+/)?.[0]).filter(Boolean);
      const item = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')]
        .find(el => {
          const text = [el.innerText, el.textContent, el.getAttribute('aria-label')].map(value => norm(value).toLowerCase()).join(' ');
          return options.some(label => text.includes(norm(label).toLowerCase())) || numerics.some(numeric => text.includes(numeric));
        });
      if (!item) return false;
      item.click();
      return true;
    }, options);
    if (!clicked) {
      const available = await page.evaluate(() => [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], button')]
        .map(el => `${el.innerText || el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 12));
      throw new Error(`Could not select image aspect ratio: ${ratio || 'auto'}; opener: ${openerText || 'unknown'}; available: ${available.join(' | ') || 'none'}`);
    }
    await sleep(500);
    const active = await page.evaluate(options => {
      // 选中后按钮可能只显示“方形/宽屏”而不显示完整比例；名称或数值命中任一即可确认。
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const input = document.querySelector('#prompt-textarea');
      const form = input?.closest('form') || input?.parentElement?.parentElement;
      const text = [...(form?.querySelectorAll('button, [role="button"]') || [])]
        .map(button => `${norm(button.innerText || button.textContent)} ${norm(button.getAttribute('aria-label'))}`)
        .join(' ');
      return options.some(label => {
        const [name, numeric] = norm(label).split(' ');
        return text.includes(norm(label)) || text.includes(name) || numeric && text.includes(numeric);
      });
    }, options);
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

  async function waitForComposer(page, log) {
    // domcontentloaded 只保证 HTML 到达；ChatGPT 的 composer 是 React 后续 hydrate 的，慢网/后台 tab 下会晚很多。
    await page.bringToFront().catch(() => {});
    await page.waitForSelector('#prompt-textarea', { visible: true, timeout: 45_000 });
    log?.('Composer ready');
  }

  async function installVoiceAudioInput(page, audioBase64) {
    // getUserMedia patch 只装在当前 voice page：它不进入普通 session page，且每次转写都会覆盖上一次音频。
    // 音频以 data buffer 进入浏览器 AudioContext，避免把本地文件路径暴露给网页脚本。
    await page.evaluateOnNewDocument(applyVoiceInputPatch, { audioBase64, streamChunkMs: VOICE_STREAM_CHUNK_MS });
    await page.evaluate(applyVoiceInputPatch, { audioBase64, streamChunkMs: VOICE_STREAM_CHUNK_MS }).catch(() => {});
  }

  async function transcribeAudioFileDirect(page, audioBase64, file) {
    // fetchTimeoutMs 传给页面侧 AbortController；按文件大小缩放避免大文件误杀。
    // 最低 15s：实际转写 2-8s，15s 足够覆盖慢网络。每 100KB base64 额外给 0.5s 上传时间。
    // 上限 45s：必须低于外层 VOICE_TRANSCRIBE_TIMEOUT_MS(60s)，留余量给 session fetch + 开销。
    const fetchTimeoutMs = Math.min(45_000, Math.max(15_000, audioBase64.length * 0.005));
    return page.evaluate(async (config) => {
      const startedAt = performance.now();
      // 页面侧 fetch 超时：页面复用数小时后 Service Worker 或后端可能挂起 fetch。
      // AbortController 在超时后强制中断，让外层创建新页面重试而不是永久挂起。
      // 注意：如果页面事件循环本身冻结，此 timer 不会触发——由 Node 侧 withTimeout 兜底。
      const fetchWithTimeout = (url, options = {}, ms) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
      };
      const sessionResponse = await fetchWithTimeout('/api/auth/session', { credentials: 'include' }, 10_000);
      // session JSON 结构由 ChatGPT Web 控制；解析失败按无 token 处理，让外层走 fallback 而不是崩掉 daemon。
      const session = await sessionResponse.json().catch(() => null);
      const accessToken = session?.accessToken || session?.access_token || '';
      // 不把 accessToken 返回 Node：token 只在页面上下文当前请求中使用，降低日志和本地进程暴露面。
      // 缺 token 通常代表登录态过期或 ChatGPT session schema 漂移；此时 fallback 比猜 header 更安全。
      if (!accessToken) throw new Error(`ChatGPT session did not expose an access token: status=${sessionResponse.status}`);
      // base64 是从 Node 传入的音频字节；页面只看到 bytes/File，不知道本地绝对路径。
      const bytes = Uint8Array.from(atob(config.audioBase64), char => char.charCodeAt(0));
      const form = new FormData();
      // FormData 字段名必须是 file，保持和 ChatGPT 前端 Rlr.transcribe client 的请求形状一致。
      // 这里复用 ChatGPT 前端 batch fallback 的 /backend-api/transcribe 语义：上传一个 File，由网页会话 bearer token 授权。
      // 只传文件名和 MIME，不传本地绝对路径；token 只用于当前请求，永远不返回到 Node 日志。
      form.append('file', new File([bytes], config.name, { type: config.mimeType }));
      // credentials=include 保持和 ChatGPT 前端 client 一致；Authorization 负责真正的 backend-api 鉴权。
      const response = await fetchWithTimeout('/backend-api/transcribe', {
        method: 'POST',
        body: form,
        credentials: 'include',
        headers: {
          // accept/oai-language 对齐网页端 transcribe client，避免后端把请求当成非浏览器调用路径。
          accept: 'application/json',
          'oai-language': navigator.language || 'en-US',
          authorization: `Bearer ${accessToken}`,
        },
      }, config.fetchTimeoutMs);
      // 先取 text 再 JSON.parse：非 JSON 错误体也要能给外层一个稳定 fallback 错误。
      const body = await response.text();
      let json = null;
      // JSON parse 失败不记录完整 body，避免后端错误页里混入敏感账号或实验信息。
      try { json = JSON.parse(body); }
      catch {}
      // HTTP 失败多半是私有接口或鉴权漂移；抛错触发 fake mic fallback，保证功能可用优先于性能。
      if (!response.ok) throw new Error(`ChatGPT direct transcribe returned HTTP ${response.status}`);
      // direct API 返回 200 但 text 为空字符串时，代表音频确实没有可识别的语音内容（例如纯静音或纯噪声）。
      // 这是 API 的正常响应，不应触发慢速听写 UI fallback——fallback 会播放空音频并等满 dictation 超时，造成 ~90s 卡死。
      // 只有 API 结构异常（非 JSON、缺 text 字段）才视为失败并 fallback。
      if (!json || typeof json.text !== 'string') throw new Error('ChatGPT direct transcribe returned invalid response');
      // elapsedMs 只用于本地诊断日志；不参与业务判断，避免慢网下误判为失败。
      return { text: json.text, elapsedMs: Math.round(performance.now() - startedAt) };
    }, {
      // 传给 page.evaluate 的对象保持最小字段，避免把 Node 侧 workspace/path 结构暴露给网页。
      audioBase64,
      // basename 只用于 File.name；真实路径校验已经在 daemon/client 边界完成。
      name: path.basename(file),
      // MIME 单独传入，避免页面上下文重新推导本地路径扩展名。
      mimeType: audioMimeType(file),
      // fetch 超时传给页面侧 AbortController
      fetchTimeoutMs,
    });
  }

  function audioMimeType(file) {
    // MIME 只按扩展名声明上传格式；真正文件合法性仍由上游 voice file/WAV 校验负责。
    const ext = path.extname(file).toLowerCase();
    // ChatGPT 前端 bundle 明确接受这些音频类型；保留枚举比把任意扩展转成 audio/* 更安全。
    if (ext === '.wav') return 'audio/wav';
    // webm 是浏览器 MediaRecorder 常见输出，保留它便于未来复用已有录音文件测试。
    if (ext === '.webm') return 'audio/webm';
    if (ext === '.m4a') return 'audio/m4a';
    // mp3 用 audio/mpeg 而不是 audio/mp3，贴近浏览器和后端更通用的 MIME 识别。
    if (ext === '.mp3') return 'audio/mpeg';
    if (ext === '.ogg') return 'audio/ogg';
    if (ext === '.flac') return 'audio/flac';
    // 未知扩展交给后端判断；这里不猜测 MIME，避免错误声明导致转写结果不可预测。
    return 'application/octet-stream';
  }

  function applyVoiceInputPatch(config) {
    // __opencodeVoiceInput 只用于本次 page 的诊断事件；不跨页面持久化，避免长期保存音频注入状态。
    window.__opencodeVoiceInput = { events: [] };
    const push = event => {
      try { window.__opencodeVoiceInput.events.push({ at: Date.now(), ...event }); }
      catch {}
    };
    const originalPermissionsQuery = navigator.permissions?.query?.bind(navigator.permissions);
    if (originalPermissionsQuery) {
      // 只把 microphone 权限伪装成 granted；其它权限查询必须透传原始浏览器实现。
      navigator.permissions.query = descriptor => descriptor?.name === 'microphone'
        ? Promise.resolve({ state: 'granted', onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })
        : originalPermissionsQuery(descriptor);
    }
    const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (!original) throw new Error('getUserMedia is not available');
    navigator.mediaDevices.getUserMedia = async constraints => {
      push({ type: 'getUserMedia-called', constraints });
      // 非音频 getUserMedia 不是本功能的边界，必须交回原实现，避免影响 ChatGPT 其它媒体能力。
      if (!constraints?.audio) return original(constraints);
      const stream = await injectedAudioStream(config, push);
      // 记录 track 状态用于 fallback 诊断；不包含音频数据本身，避免日志泄露录音内容。
      push({ type: 'getUserMedia-resolved', tracks: stream.getTracks().map(track => ({ kind: track.kind, readyState: track.readyState })) });
      return stream;
    };

    async function injectedAudioStream(config, push) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('AudioContext is not available');
      const audioContext = new AudioContextClass();
      await audioContext.resume().catch(() => {});
      // decodeAudioData 在浏览器内解码 bytes，避免 Node 侧额外引入 ffmpeg/sox 这类外部工具。
      const bytes = Uint8Array.from(atob(config.audioBase64), char => char.charCodeAt(0));
      const audioBuffer = await audioContext.decodeAudioData(bytes.buffer.slice(0));
      const destination = audioContext.createMediaStreamDestination();
      // 静音 oscillator 保持 stream live；没有持续 track 时 ChatGPT 可能在音频播放前就认为麦克风结束。
      const silence = audioContext.createOscillator();
      const gain = audioContext.createGain();
      gain.gain.value = 0;
      silence.connect(gain).connect(destination);
      silence.start();
      const chunkFrames = Math.max(1, Math.round(audioBuffer.sampleRate * Math.max(1, config.streamChunkMs || 250) / 1000));
      const chunks = Math.ceil(audioBuffer.length / chunkFrames);
      for (let index = 0; index < chunks; index++) {
        // 分块调度保留真实时间轴，作为 direct upload 失效时的兼容 fallback，而不是性能优先路径。
        const startFrame = index * chunkFrames;
        const frameCount = Math.min(chunkFrames, audioBuffer.length - startFrame);
        // 每个 chunk 重新建 BufferSource，因为 Web Audio 的 BufferSource 只能 start 一次，不能循环复用。
        const chunk = audioContext.createBuffer(audioBuffer.numberOfChannels, frameCount, audioBuffer.sampleRate);
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
          chunk.copyToChannel(audioBuffer.getChannelData(channel).slice(startFrame, startFrame + frameCount), channel);
        }
        const source = audioContext.createBufferSource();
        source.buffer = chunk;
        source.connect(destination);
        source.onended = () => {
          source.disconnect();
          // 只在最后一个 chunk 报 ended，waitForInjectedVoiceAudio 才能把“音频播放完”作为单一同步点。
          if (index === chunks - 1) push({ type: 'injected-audio-ended', duration: audioBuffer.duration, sampleRate: audioBuffer.sampleRate, channels: audioBuffer.numberOfChannels, chunks });
        };
        source.start(audioContext.currentTime + 0.05 + startFrame / audioBuffer.sampleRate);
      }
      push({ type: 'injected-audio-started', duration: audioBuffer.duration, sampleRate: audioBuffer.sampleRate, channels: audioBuffer.numberOfChannels, chunks, chunkMs: config.streamChunkMs || 250 });
      return destination.stream;
    }
  }

  async function clickDictationButton(page) {
    const deadline = Date.now() + VOICE_DICTATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const clicked = await page.evaluate(() => {
        const controls = visibleControls(document);
        const dictation = controls.find(button => /dictat|speech to text|voice input|start voice input|microphone|\bmic\b|语音输入|语音识别|听写|麦克风/i.test(button.label) && !/voice mode|voice chat|conversation|call|通话|语音对话|实时对话|send|submit|发送|提交/i.test(button.label));
        const fallback = controls
          .filter(button => /voice|speech|microphone|\bmic\b|listen|语音|麦克风|听写/i.test(button.label) && !/voice mode|voice chat|conversation|call|通话|语音对话|实时对话|send|submit|发送|提交/i.test(button.label))
          .sort((a, b) => a.x - b.x || a.y - b.y)[0];
        const selected = dictation || fallback;
        if (!selected) return null;
        selected.element.scrollIntoView({ block: 'center', inline: 'center' });
        selected.element.click();
        return { index: selected.index, label: selected.label };

        function visibleControls(root) {
          return [...root.querySelectorAll('button, [role="button"]')]
            .map((element, index) => {
              const rect = element.getBoundingClientRect();
              return {
                element,
                index,
                label: normalize([element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid'), element.innerText, element.textContent].filter(Boolean).join(' ')),
                visible: rect.width > 0 && rect.height > 0 && !element.disabled && element.getAttribute('aria-disabled') !== 'true',
                x: Math.round(rect.x),
                y: Math.round(rect.y),
              };
            })
            .filter(item => item.visible);
        }

        function normalize(value) {
          return String(value || '').normalize('NFKC').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
        }
      });
      if (clicked) return clicked;
      await sleep(500);
    }
    return null;
  }

  async function voiceControlSnapshot(page) {
    return page.evaluate(() => {
      return [...document.querySelectorAll('button, [role="button"]')]
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          const label = normalize([element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid'), element.innerText, element.textContent].filter(Boolean).join(' '));
          return {
            index,
            label,
            visible: rect.width > 0 && rect.height > 0,
            disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
            x: Math.round(rect.x),
            y: Math.round(rect.y),
          };
        })
        .filter(item => item.visible && (item.x > 250 || /voice|speech|microphone|dictat|listen|talk|语音|麦克风|听写|朗读|说话|通话/i.test(item.label)))
        .slice(0, 80);

      function normalize(value) {
        return String(value || '').normalize('NFKC').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
      }
    });
  }

  async function waitForInjectedVoiceAudio(page) {
    const wait = page.waitForFunction(() => {
      const events = window.__opencodeVoiceInput?.events || [];
      return events.some(event => event.type === 'injected-audio-ended');
    }, { timeout: 0 });
    const timedOut = await Promise.race([
      wait.then(() => false),
      sleep(VOICE_DICTATION_TIMEOUT_MS).then(() => true),
    ]);
    if (timedOut) {
      wait.catch(() => {});
      const events = await page.evaluate(() => window.__opencodeVoiceInput?.events || []).catch(() => []);
      throw new Error(`Voice audio injection did not finish within ${VOICE_DICTATION_TIMEOUT_MS}ms: ${JSON.stringify(events)}`);
    }
  }

  async function clickStopDictation(page) {
    const deadline = Date.now() + VOICE_DICTATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const clicked = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('button, [role="button"]')]
          .map((element, index) => {
            const rect = element.getBoundingClientRect();
            return {
              element,
              index,
              label: normalize([element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid'), element.innerText, element.textContent].filter(Boolean).join(' ')),
              visible: rect.width > 0 && rect.height > 0 && !element.disabled && element.getAttribute('aria-disabled') !== 'true',
            };
          })
          .filter(item => item.visible);
        const stop = controls.find(item => /提交听写|完成听写|停止听写|结束听写|submit dictation|finish dictation|done dictation|stop dictation|stop listening|stop voice input|停止语音|结束语音/i.test(item.label) && !/stop generating|停止生成|send|发送/i.test(item.label));
        if (!stop) return null;
        stop.element.scrollIntoView({ block: 'center', inline: 'center' });
        stop.element.click();
        return { index: stop.index, label: stop.label };

        function normalize(value) {
          return String(value || '').normalize('NFKC').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
        }
      });
      if (clicked) return clicked;
      await sleep(500);
    }
    return null;
  }

  async function waitForComposerText(page) {
    const wait = page.waitForFunction(() => {
      const input = document.querySelector('#prompt-textarea');
      return normalize((input?.innerText || input?.textContent || '').replace(/\r\n?/g, '\n')).trim().length > 0;

      function normalize(value) {
        return String(value || '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
      }
    }, { timeout: 0 });
    const timedOut = await Promise.race([
      wait.then(() => false),
      sleep(VOICE_DICTATION_TIMEOUT_MS).then(() => true),
    ]);
    if (timedOut) {
      wait.catch(() => {});
      const events = await page.evaluate(() => window.__opencodeVoiceInput?.events || []).catch(() => []);
      const controls = await voiceControlSnapshot(page).catch(() => []);
      throw new Error(`ChatGPT dictation did not write composer text within ${VOICE_DICTATION_TIMEOUT_MS}ms: events=${JSON.stringify(events)} controls=${JSON.stringify(controls)}`);
    }
    return page.evaluate(() => {
      const input = document.querySelector('#prompt-textarea');
      return normalize((input?.innerText || input?.textContent || '').replace(/\r\n?/g, '\n'));

      function normalize(value) {
        return String(value || '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
      }
    });
  }

  async function clearComposerText(page) {
    await page.evaluate(() => {
      const input = document.querySelector('#prompt-textarea');
      if (!input) return;
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    });
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
    // 不能从空 composer 直接插入完整 prompt：ChatGPT/ProseMirror 会把 Markdown 风格的
    // “- item\n  continuation” 自动格式化，续行前两个普通空格会变成 “NBSP + space”。
    // 先提交一个短 sentinel，让编辑器进入普通文本替换事务，再整体替换成真实 prompt；
    // 这样修的是写入路径本身，而不是用“+2 也算通过”的宽松校验掩盖问题。
    const expected = normalizeComposerText(text);
    await page.waitForSelector('#prompt-textarea', { visible: true, timeout: 45_000 });
    await replaceComposerText(page, 'x');
    await page.waitForFunction(value => {
      const input = document.querySelector('#prompt-textarea');
      return composerText(input) === value;

      function composerText(input) {
        return normalize((input?.innerText || input?.textContent || '').replace(/\r\n?/g, '\n'));
      }

      function normalize(value) {
        return String(value || '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
      }
    }, { timeout: 5_000 }, 'x');
    const actual = await replaceComposerText(page, text);
    if (actual !== expected) throw new Error(`Composer fill verification failed: expected ${expected.length} chars, got ${actual.length}; ${promptDiff(expected, actual)}`);
    return expected;
  }

  async function replaceComposerText(page, text) {
    return page.evaluate(value => {
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
  }

  function promptDiff(expected, actual) {
    const max = Math.max(expected.length, actual.length);
    let index = 0;
    while (index < max && expected[index] === actual[index]) index++;
    if (index >= max) return 'no visible diff';
    return `first diff at ${index}: expected ${JSON.stringify(expected.slice(Math.max(0, index - 24), index + 48))}, got ${JSON.stringify(actual.slice(Math.max(0, index - 24), index + 48))}`;
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
    options.foreground = foregroundPulse(page, options.foregroundPulseMs || 0);
    const startedAt = Date.now();
    // responseTimeout 是整次浏览器等待总预算；start/settle 共享同一个 deadline，避免外层 CLI 先超时。
    const deadline = startedAt + responseTimeout;
    const early = await waitUntilResponseStarts(page, before, options, startedAt, deadline, log);
    if (early) return early;
    return waitUntilResponseSettles(page, before, options, startedAt, deadline, log);
  }

  async function waitUntilResponseStarts(page, before, options, startedAt, deadline, log) {
    while (true) {
      await options.foreground?.();
      const current = await assistantState(page).catch(() => null);
      if (current) {
        const submitted = current.userCount > before.userCount;
        if (options.shouldCancel?.() && submitted) return { status: 'generating', reason: 'client-disconnected' };
        // 原生图片可能没有 assistant 文本；图片数量增长也说明回答已经开始出现。
        if (submitted && current.nativeImageCount > before.nativeImageCount) return;
        if (submitted && ((current.count > before.count && current.lastText) || (current.lastText && current.lastText !== before.lastText))) return;
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
      await options.foreground?.();
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
      if (responseLen !== lastLen || state.nativeImageCount !== lastImageCount) {
        lastLen = responseLen;
        lastImageCount = state.nativeImageCount;
        lastChangedAt = Date.now();
        continue;
      }

      const stableMs = responseStableMs(responseLen, options.slow);
      // stop button 消失是必要条件；消息底部操作按钮（copy/regenerate 等）渲染到 DOM 才是安全完成的充分条件。
      // stop button 消失但操作按钮未出现时，DOM 可能仍在更新，不能提前返回。
      // 操作按钮出现时只需 750ms 稳定窗口（一个轮询周期）防最后一帧竞态。
      const fullyRendered = responseLen > 0 && !state.generating && !state.placeholder && state.actionButtons;
      const doneStableMs = fullyRendered ? Math.min(stableMs, 750) : stableMs;
      if (!state.generating && !state.placeholder && (hasNewText || hasNewNativeImage) && Date.now() - lastChangedAt >= doneStableMs) {
        return { status: 'completed', reason: 'stable' };
      }
    }
  }

  function foregroundPulse(page, intervalMs) {
    // ChatGPT Web 有些内容在后台 tab 不会完整 hydrate；等待期间低频轮流激活页面，避免只抽到引用/空 assistant。
    // 频率不能太高，否则并发会话会互相抢前台；4s 级别足够触发渲染，又不会像 polling 一样打扰用户。
    let last = 0;
    return async () => {
      if (!intervalMs || Date.now() - last < intervalMs) return;
      last = Date.now();
      await page.bringToFront().catch(() => {});
      await sleep(150);
    };
  }

  async function assistantState(page, count) {
    // 外层只需要普通状态对象；不要把 DOM 节点句柄泄漏给 core，frame 重建时节点句柄很容易失效。
    return page.evaluate(existingCount => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
      const lastText = msgs.length > 0 ? (msgs[msgs.length - 1].innerText || '').trim() : '';
      const lastAssistant = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const emptyAssistantTurn = emptyUnroleAssistantTurn();
      // 操作按钮（copy/regenerate 等）在 conversation-turn 容器底部，不在 assistant 消息元素内部。
      // 只搜索 assistant 元素会漏掉这些按钮；必须搜索整个 turn 容器。
      const lastTurn = lastAssistant?.closest('[data-testid^="conversation-turn-"]')
        || [...document.querySelectorAll('[data-testid^="conversation-turn-"]')].pop();
      const turnButtonLabels = [...(lastTurn?.querySelectorAll('button') || [])]
        .map(button => `${button.getAttribute('aria-label') || ''} ${button.getAttribute('data-testid') || ''} ${button.textContent || ''}`.trim())
        .filter(Boolean);
      const stopButton = !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]');
      // 图片 URL 快照既用于完成判定，也用于下载阶段过滤旧图；复用同一 session 时不能把历史图片当本轮产物。
      // 原生绘图回答会生成 image-turn，而不是 assistant role；全页快照才能让 image-only 任务从 pending 恢复。
      const nativeImageURLs = generatedImageURLs(document);
      return {
        count: existingCount ?? msgs.length,
        userCount,
        nativeImageCount: nativeImageURLs.length,
        nativeImageURLs,
        lastText,
        copyButton: turnButtonLabels.some(label => /copy|复制/i.test(label)),
        // actionButtons 是比 copyButton 更宽的完成信号：copy/regenerate/share/like 等任意操作按钮出现都说明 DOM 已完全渲染。
        // stop button 消失只表示生成停止，但 DOM 可能还在更新；操作按钮出现才是安全返回的条件。
        actionButtons: turnButtonLabels.some(label => /copy|复制|regenerate|重新生成|share|分享|read aloud|朗读|like|点赞|dislike|踩/i.test(label)),
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

      function generatedImageURLs(root) {
        if (!root) return [];
        const seen = new Set();
        return [...root.querySelectorAll('img')]
          .map(img => ({ src: img.currentSrc || img.src || '', alt: img.alt || '', width: img.naturalWidth || 0, height: img.naturalHeight || 0 }))
          .filter(img => /\/backend-api\/estuary\/content/.test(img.src) && (/generated image/i.test(img.alt) || img.width >= 256 || img.height >= 256))
          .filter(img => seen.has(img.src) ? false : (seen.add(img.src), true))
          .map(img => img.src);
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
    if (slow) return length < 1_000 ? 8_000 : length < 4_000 ? 12_000 : 18_000;
    // 短回答（如数学题）几秒就渲染完；6s 稳定窗口让用户多等好几秒。
    return length < 1_000 ? 3_000 : length < 4_000 ? 5_000 : 10_000;
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
        // 用 inlineChildren 替代 cell.innerText：让 citation pill、链接、粗体等行内语义
        // 在表格单元格中被正确转换，而不是被 innerText 拍平成纯文本。
        // tableCell 仍负责 pipe 转义和换行转 <br>，对 inlineChildren 的字符串输出安全。
        const rows = [...el.querySelectorAll('tr')].map(row => [...row.children].map(cell => tableCell(inlineChildren(cell))));
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
        const missing = refs.filter((ref, index) => !new RegExp(`^\\[Ref ${index + 1}\\]\\s+\\[`, 'm').test(markdown));
        if (missing.length === 0) return markdown;
        // 不点击“复制回复”：Puppeteer 实测 clipboard 不稳定，还会污染用户系统剪贴板。
        // 只看正文 URL 会误判：用户任务里常自带链接；必须看是否已有本地 Ref 清单行。
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
  async function downloadNativeImages(page, downloadDir, log, limit, byteBudget, shouldCancel, previousURLs = []) {
    if (limit <= 0) return { downloads: [], notices: [] };
    ensurePrivateDir(downloadDir);
    // 只在页面里发现候选 URL；实际字节用 Node stream 写盘，避免大图经过 CDP/base64 双重放大。
    // 这样仍然复用浏览器 cookie，但大文件压力落在 Node stream/backpressure，而不是 Puppeteer 协议消息。
    const result = await page.evaluate(limits => {
      // 原生图片生成结果可能落在独立 image-generation turn，而不是 assistant role 节点。
      // 所以仍扫描全页，但只保存发送前快照中不存在的 URL，避免复用 session 时把老图误报成本轮产物。
      // 这个“before snapshot -> new URL”策略比猜测 latest turn 更稳：ChatGPT 的图片 turn DOM 会变，
      // 但同一远端 estuary URL 不会因为布局重排变成本轮新增结果。
      // 下载阶段仍按 URL 去重，避免响应式预览图、overlay 图和真实图三层 DOM 指向同一个远端对象时重复落盘。
      const seen = new Set();
      const previous = new Set(limits.previousURLs || []);
      const candidates = [...document.querySelectorAll('img')]
        .map(img => ({ src: img.currentSrc || img.src || '', alt: img.alt || '', width: img.naturalWidth || 0, height: img.naturalHeight || 0 }))
        .filter(img => {
          // 只收 ChatGPT 自己的 estuary 图片；普通 markdown 图片即使路径相似，也不能当作原生绘图结果保存。
          try { const url = new URL(img.src); return url.origin === location.origin && url.pathname.includes('/backend-api/estuary/content'); }
          catch { return false; }
        })
        .filter(img => /generated image/i.test(img.alt) || img.width >= 256 || img.height >= 256)
        .filter(img => !previous.has(img.src))
        .filter(img => seen.has(img.src) ? false : (seen.add(img.src), true))
        .slice(0, limits.maxImages);
      const notices = [];
      // notices 只记录“看见了候选但没保存”的情况；没有候选图时保持空，避免制造噪声。
      return { images: candidates.map(image => ({ ...image, sourceID: image.src.match(/[?&]id=([^&]+)/)?.[1] || '' })), notices };
    }, { maxImages: limit, previousURLs });

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
