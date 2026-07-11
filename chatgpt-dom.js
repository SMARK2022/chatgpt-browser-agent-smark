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
const { isOfficialURL: isOfficialChatGPTURL } = require('./chatgpt-project');

const MAX_ARTIFACTS = 16;
const MAX_UPLOAD_BYTES = positiveIntEnv('CHATGPT_MAX_UPLOAD_BYTES', 400 * 1024 * 1024);
const MAX_TOTAL_UPLOAD_BYTES = positiveIntEnv('CHATGPT_MAX_TOTAL_UPLOAD_BYTES', 800 * 1024 * 1024);
const MAX_ARTIFACT_BYTES = positiveIntEnv('CHATGPT_MAX_ARTIFACT_BYTES', 4 * 1024 * 1024 * 1024);
const VOICE_DICTATION_TIMEOUT_MS = positiveIntEnv('CHATGPT_VOICE_DICTATION_TIMEOUT_MS', 45_000);
const VOICE_STOP_DELAY_MS = positiveIntEnv('CHATGPT_VOICE_STOP_DELAY_MS', 6_000);
const VOICE_STREAM_CHUNK_MS = positiveIntEnv('CHATGPT_VOICE_STREAM_CHUNK_MS', 250);
// sandbox 文件和原生图片共享同一个总数预算；ChatGPT 生成产物按原名保存，不额外改扩展名。
// 产物不按类型裁剪；总量、外层取消与无进展中止共同防止单个产物占住共享队列。

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
      // 恢复读取前把目标页切到前台并滚动到最下方,降低后台 tab 延迟渲染导致的"文本已生成但 DOM 不完整"。
      // ChatGPT 虚拟化视口外的消息;不滚动时最新 assistant 节点可能不在 DOM 中。
      await page.bringToFront().catch(() => {});
      await scrollToEnd(page);
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
      // discovery 返回候选集合，不负责选择目标；唯一性与显式 ID 优先级由纯 Project policy 决定。
      // 展开操作使用可信 ElementHandle click，React 菜单不会因 DOM .click() 静默失效。
      // 名称歧义属于安全错误，必须带稳定 code 穿过 core fallback，不能降级到旧 cache。
      // 项目发现属于 ChatGPT Web DOM 适配，而不是 daemon 状态机。

      // 根页提供最完整的 Project section；conversation/Project 页的响应式侧栏可能只渲染一个裁剪副本。
      if (!/^https:\/\/chatgpt\.com\/?(?:[?#].*)?$/i.test(page.url())) {
        await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await sleep(1_000);
      }

      for (let i = 0; i < 5; i++) {
        if (!await clickProjectListExpander(page)) break;
        await sleep(700);
      }

      const sidebar = await readSidebarProjects(page);
      const duplicate = sidebar.names.find((name, index, names) => names.findIndex(item => item.normalize('NFKC').toLowerCase() === name.normalize('NFKC').toLowerCase()) !== index);
      if (duplicate) {
        const error = new Error(`Multiple ChatGPT projects are named "${duplicate}"; configure CHATGPT_PROJECT with the exact Project URL or id.`);
        error.code = 'PROJECT_AMBIGUOUS';
        throw error;
      }
      const projects = sidebar.links
        // 响应式侧栏可能保留重复链接；按 URL 去重后再交给 core 做身份/同名裁决。
        .filter((project, index, all) => all.findIndex(item => item.href === project.href) === index);
      log(`Discovered ChatGPT project links: ${projects.map(project => project.name).join(', ') || 'none'}`);
      return projects;
    },

    /** 读取 Project 首页事实，core 用它验证缓存 URL，而不是把“导航成功”误当成 Project 可用。 */
    async projectHomeState(page, name) {
      return readProjectHomeState(page, name);
    },

    /** 只在 Work 已激活时切回 Chat；正常 Chat 页面保持原状，不探索或点击 Work。 */
    async ensureChatMode(page, log) {
      return ensureProjectChatMode(page, log);
    },

    /** 新侧边栏不再暴露 Project href；按显示名点击首页按钮并返回网页实际采用的 URL。 */
    async openProjectHome(page, name, log) {
      return openProjectHomeFromSidebar(page, name, log);
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
            // core 需要发送前 turn 基线，pending recovery 才能证明后续文本属于本轮而非历史回答。
            beforeSend(before);
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

    async transcribeAudioFile(page, file, voiceUrl, log, shouldCancel = () => false, onFallbackStart = () => {}) {
      // Node 侧只读取一次文件；direct upload 和 fallback fake mic 共用同一份 base64，避免两次磁盘读取产生 TOCTOU 窗口。
      const audioBase64 = fs.readFileSync(file).toString('base64');
      // direct path 零页面操作：不 bringToFront、不 goto、不依赖任何 DOM 状态。
      // 它只在 runtime 专属 voice page 的 JS 上下文中 fetch，不会与 ask session 共用 composer。
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
        if (/timed out|timeout|abort|target closed|protocol error|official ChatGPT origin/i.test(err.message)) throw err;
        // 客户端已断开时不需要进入 ~90s 的 fallback 听写 UI。
        if (shouldCancel()) throw new Error('Voice transcription cancelled before fallback');
        // ChatGPT Web 的私有 endpoint/header 可能随前端版本调整；fallback 继续用已验证的听写 UI，避免一次网页变更让语音输入彻底不可用。
        // fallback 日志只记录错误信息，不记录 token、请求体或音频内容，避免把登录态材料写进 daemon.log。
        log(`Direct voice transcription failed, falling back to dictation UI: ${err.message}`);
      }
      // fallback 需要 composer 和听写按钮;通知 caller 开始 fallback(让 ask foregroundPulse 跳过)。
      onFallbackStart();
      // fallback 需要项目页的 composer；direct 复用的页面可能不在项目页上。
      await page.bringToFront().catch(() => {});
      // 听写 UI 在任何 chatgpt.com 聊天页都可用;不导航到项目页(避免创建多余对话和干扰 ask 会话)。
      if (!isOfficialChatGPTURL(page.url())) {
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
        const files = await downloadSandboxFiles(page, downloadDir, log, MAX_ARTIFACTS, MAX_ARTIFACT_BYTES, shouldCancel, beforeState?.count).catch(err => ({ downloads: [], notices: [`Sandbox artifact collection failed: ${err.message}`] }));
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

  /**
   * 展开侧边栏 Project 区域，但不依赖“查看更多”的当前语言。
   * 优先使用 Project section 与 row 的结构关系；旧文案 selector 只承担兼容，不参与身份选择。
   */
  async function clickProjectListExpander(page) {
    const handle = await page.evaluateHandle(() => {
      const row = document.querySelector('[class*="project-unfurl-row"], a[href*="/g/g-p-"]');
      const section = row?.closest('[class*="sidebar-expando-section"], section')
        || [...document.querySelectorAll('[class*="sidebar-expando-section"], section')]
          .find(item => item.querySelector('[class*="project-unfurl-row"], a[href*="/g/g-p-"]'));
      const collapsed = [...(section?.querySelectorAll('button[aria-expanded="false"], [role="button"][aria-expanded="false"]') || [])][0];
      if (collapsed) return collapsed;
      // 当前“查看更多”没有稳定文案；它是 Project section 内唯一不属于具体 project row 的 sidebar button。
      const structural = [...(section?.querySelectorAll('button[data-sidebar-item], [role="button"][data-sidebar-item]') || [])]
        .find(item => !item.closest('[class*="project-unfurl-row"]'));
      if (structural) return structural;
      // 旧页面没有 section 结构，只把本地化文案作为最后兼容层，不能让它成为当前 UI 的唯一发现依据。
      return [...document.querySelectorAll('button, div.group.__menu-item, a.group.__menu-item, [role="button"]')]
        .find(item => /^(show more|more|显示更多|更多|展开)$/i.test((item.innerText || item.textContent || '').trim())) || null;
    });
    const element = handle.asElement();
    if (!element) {
      await handle.dispose().catch(() => {});
      return false;
    }
    try { await element.click(); }
    finally { await handle.dispose().catch(() => {}); }
    return true;
  }

  /**
   * 读取 Project 首页可验证事实，不在 DOM 层猜测 URL 身份。
   * Chat/Work 只认自身标签和属性；全页其它 radio 可能属于模型或推理级别，绝不能参与模式判断。
   * name 为空表示显式 ID/URL 路径，此时返回网页真实 h1 供 core 建立可信标题。
   */
  async function readProjectHomeState(page, name) {
    // 这里只报告页面事实，不决定 URL 是否属于目标 Project；core 会用纯 policy 做 origin/path/id 检查。
    // 已知 Chat/Work 标签可跨语言匹配，未知组只有具备 Project mode 专属属性时才触发 fail-closed。
    // 没有专属 mode 控件就是 Chat-only，即使页面存在任意数量的模型或 reasoning radiogroup。
    return page.evaluate(expectedName => {
      const norm = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      const radios = [...document.querySelectorAll('[role="radio"]')];
      const labels = item => [item.textContent, item.getAttribute('aria-label'), item.getAttribute('data-value'), item.getAttribute('value')].map(norm);
      const chat = radios.find(item => labels(item).some(label => /^(chat|聊天|对话|会話|チャット)$/.test(label)));
      const work = radios.find(item => labels(item).some(label => /^(work|工作|作業|ワーク)$/.test(label)));
      const active = item => item?.getAttribute('aria-checked') === 'true' || item?.getAttribute('data-state') === 'on';
      const unknownModeGroup = document.querySelector('[data-project-mode-switch], [data-testid="project-mode-switch"]');
      // 没有明确 Project mode group 时是旧版 Chat-only；孤立的模型/reasoning radio 不应让页面失效。
      const hasModeSwitch = !!chat || !!work || !!unknownModeGroup;
      const titles = [...document.querySelectorAll('h1')].map(item => ({ item, name: String(item.textContent || '').trim() })).filter(item => item.name);
      const title = expectedName ? titles.find(item => norm(item.name) === norm(expectedName)) : titles[0];
      return {
        url: location.href,
        composer: !!document.querySelector('#prompt-textarea'),
        title: !!title,
        titleName: title?.name || null,
        chatAvailable: !!chat || !hasModeSwitch,
        // 只读取已识别的 Chat/Work 控件；模型和推理级别的 radio 不能被扩大解释成 Work。
        // 没有任何 radio 仍代表旧版 Chat-only 页面；有 radio 但模式标签未知时 fail-closed。
        chatActive: !hasModeSwitch || !!chat && active(chat),
        workActive: !!work && active(work),
      };
    }, name);
  }

  async function openProjectHomeFromSidebar(page, name, log) {
    await page.bringToFront().catch(() => {});
    const current = await readProjectHomeState(page, name).catch(() => null);
    if (current?.composer && current.title) {
      // ambient tab 只证明当前页标题匹配；展开完整列表后仍须拒绝同名 Project，不能按用户碰巧打开的页猜身份。
      for (let attempt = 0; attempt < 7; attempt++) {
        const matches = await projectSidebarMatchCount(page, name);
        if (matches > 1) {
          const error = new Error(`Multiple ChatGPT projects are named "${name}"; configure CHATGPT_PROJECT with the exact Project URL or id.`);
          error.code = 'PROJECT_AMBIGUOUS';
          throw error;
        }
        if (!await clickProjectListExpander(page)) break;
        await sleep(500);
      }
      await ensureProjectChatMode(page, log);
      return page.url();
    }
    for (let attempt = 0; attempt < 7; attempt++) {
      const matches = await projectSidebarMatchCount(page, name);
      // 名称不是稳定身份；同名时拒绝猜测，交由显式 Project URL/ID 消除数据归属歧义。
      if (matches > 1) {
        const error = new Error(`Multiple ChatGPT projects are named "${name}"; configure CHATGPT_PROJECT with the exact Project URL or id.`);
        error.code = 'PROJECT_AMBIGUOUS';
        throw error;
      }
      const handle = await page.evaluateHandle(expectedName => {
        const norm = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
        const visible = item => !!(item.offsetWidth || item.offsetHeight || item.getClientRects().length);
        const row = [...document.querySelectorAll('[data-sidebar-item][role="button"]')]
          .find(item => norm(item.textContent) === norm(expectedName) && visible(item)
            && [...(item.closest('li')?.querySelectorAll('button[data-trailing-button]') || [])]
              .some(button => !button.hasAttribute('aria-haspopup') && visible(button)));
        if (!row) return null;
        const buttons = [...(row.closest('li')?.querySelectorAll('button[data-trailing-button]') || [])];
        // 首页按钮没有 menu popup；排除 aria-haspopup 后无需依赖中英文 aria-label。
        return buttons.find(button => !button.hasAttribute('aria-haspopup')) || null;
      }, name);
      const button = handle.asElement();
      if (button) {
        const previous = page.url();
        try { await button.click(); }
        finally { await handle.dispose().catch(() => {}); }
        await page.waitForFunction(({ previous, name }) => {
          const norm = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
          return location.href !== previous
            && !!document.querySelector('#prompt-textarea')
            && [...document.querySelectorAll('h1')].some(item => norm(item.textContent) === norm(name));
        }, { timeout: 15_000, polling: 200 }, { previous, name });
        await ensureProjectChatMode(page, log);
        log?.(`Opened ChatGPT Project from live sidebar: ${name}`);
        return page.url();
      }
      await handle.dispose().catch(() => {});

      // Project 列表可能折叠或只展示前几项；每轮只展开一个控件，避免一次 evaluate 连点导致 React 丢事件。
      if (!await clickProjectListExpander(page)) break;
      await sleep(500);
    }
    return null;
  }

  function projectSidebarMatchCount(page, name) {
    const key = String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    return readSidebarProjects(page).then(sidebar => sidebar.names.filter(item => item.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() === key).length);
  }

  function readSidebarProjects(page) {
    return page.evaluate(() => {
      // discover 与 fallback 必须共享同一结构规则；旧 class 只是兼容证据，不能成为唯一入口。
      const visible = item => !!(item.offsetWidth || item.offsetHeight || item.getClientRects().length);
      const links = [...document.querySelectorAll('a[href*="/g/g-p-"]')]
        .filter(visible)
        .map(anchor => ({ name: (anchor.innerText || anchor.textContent || '').trim().split('\n')[0], href: anchor.href }))
        .filter(project => project.name && project.href);
      const dataItems = [...document.querySelectorAll('[data-sidebar-item][role="button"]')]
        .filter(visible)
        .filter(item => {
          const row = item.closest('li, [class*="project-unfurl-row"]');
          if (!row) return false;
          const legacy = /project-unfurl-row/.test(row.className || '');
          const home = [...row.querySelectorAll('button[data-trailing-button]')]
            .some(button => !button.hasAttribute('aria-haspopup') && visible(button));
          return legacy || home || !!row.querySelector('a[href*="/g/g-p-"]');
        });
      // 无 data-sidebar-item 的旧链接仍要进入名称全集；已被结构化 row 包含的链接不能重复计数。
      const linkItems = [...document.querySelectorAll('a[href*="/g/g-p-"]')]
        .filter(anchor => visible(anchor) && !anchor.closest('li, [class*="project-unfurl-row"]')?.querySelector('[data-sidebar-item][role="button"]'));
      const names = [...dataItems, ...linkItems]
        .map(item => (item.innerText || item.textContent || '').trim().split('\n')[0])
        .filter(Boolean);
      return { links, names };
    });
  }

  async function ensureProjectChatMode(page, log) {
    const state = await readProjectHomeState(page, '');
    if (!state.chatAvailable || state.chatActive && !state.workActive) return;
    const handle = await page.evaluateHandle(() => {
      const norm = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      const labels = item => [item.textContent, item.getAttribute('aria-label'), item.getAttribute('data-value'), item.getAttribute('value')].map(norm);
      return [...document.querySelectorAll('[role="radio"]')]
        .find(item => labels(item).some(label => /^(chat|聊天|对话|会話|チャット)$/.test(label))) || null;
    });
    const chat = handle.asElement();
    if (!chat) {
      await handle.dispose().catch(() => {});
      return;
    }
    try { await chat.click(); }
    finally { await handle.dispose().catch(() => {}); }
    await page.waitForFunction(() => {
      const norm = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      return [...document.querySelectorAll('[role="radio"]')].some(item => {
        const labels = [item.textContent, item.getAttribute('aria-label'), item.getAttribute('data-value'), item.getAttribute('value')].map(norm);
        return labels.some(label => /^(chat|聊天|对话|会話|チャット)$/.test(label))
          && (item.getAttribute('aria-checked') === 'true' || item.getAttribute('data-state') === 'on');
      });
    }, { timeout: 5_000 });
    log?.('Selected Chat mode; Work was not used.');
  }

  // ─── Upload and Submit ────────────────────────────────────────────────────

  async function selectComposerMode(page, mode, log) {
    const options = mode === 'image' ? ['创建图片', 'Create image'] : null;
    if (!options) return;
    const plus = await page.waitForSelector('#composer-plus-btn', { timeout: 10_000 });
    try { await plus.click(); }
    finally { await plus.dispose().catch(() => {}); }
    await sleep(600);
    const handle = await page.evaluateHandle(options => {
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], button, div.__menu-item')]
        .filter(element => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length))
        .find(element => {
          const titles = [...element.querySelectorAll('span')].map(span => norm(span.textContent)).filter(Boolean);
          const text = norm(element.innerText || element.textContent || element.getAttribute('aria-label'));
          return options.some(label => titles.includes(norm(label)) || text === norm(label));
        }) || null;
    }, options);
    const item = handle.asElement();
    if (!item) {
      await handle.dispose().catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      log(`ChatGPT composer mode entry unavailable for ${mode}; using workflow prompt fallback.`);
      return;
    }
    try {
      const box = await item.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      else await item.click();
    } finally {
      await handle.dispose().catch(() => {});
    }
    const active = await page.waitForFunction(options => {
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const input = document.querySelector('#prompt-textarea');
      const form = input?.closest('form') || input?.parentElement?.parentElement;
      const text = norm(`${input?.innerText || input?.textContent || ''} ${form?.innerText || form?.textContent || ''}`);
      return options.some(label => text.includes(norm(label)));
    }, { timeout: 3_000, polling: 100 }, options).then(() => true, () => false);
    await page.keyboard.press('Escape').catch(() => {});
    if (!active) {
      log(`ChatGPT composer mode click was not confirmed for ${mode}; using workflow prompt fallback.`);
      return;
    }
    log(`Selected ChatGPT composer mode: ${mode}`);
  }

  async function selectImageAspectRatio(page, mode, ratio, log) {
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
    const openerHandle = await page.evaluateHandle(() => {
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
      const input = document.querySelector('#prompt-textarea');
      const form = input?.closest('form') || input?.parentElement?.parentElement;
      return [...(form?.querySelectorAll('button, [role="button"]') || [])]
        .find(item => /选择图片宽高比|image aspect ratio|aspect ratio|ratio|1:1|3:4|9:16|4:3|16:9|方形|正方形|square|竖版|portrait|故事版|story|横版|landscape|宽屏|wide/i.test(`${norm(item.innerText || item.textContent)} ${norm(item.getAttribute('aria-label'))}`)) || null;
    });
    const opener = openerHandle.asElement();
    if (!opener) {
      await openerHandle.dispose().catch(() => {});
      log(`Image aspect ratio control unavailable; using workflow prompt fallback: ${ratio || 'auto'}`);
      return;
    }
    const openerText = await opener.evaluate(element => `${element?.innerText || element?.textContent || ''} ${element?.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim()).catch(() => 'unknown');
    try { await opener.click(); }
    catch (err) { await openerHandle.dispose().catch(() => {}); throw err; }
    await sleep(1_000);
    const itemHandle = await page.evaluateHandle(options => {
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
      const numerics = options.map(label => norm(label).match(/\d+:\d+/)?.[0]).filter(Boolean);
      return [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], div.__menu-item')]
        .filter(element => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length))
        .find(element => {
          const text = [element.innerText, element.textContent, element.getAttribute('aria-label')].map(value => norm(value).toLowerCase()).join(' ');
          return options.some(label => text.includes(norm(label).toLowerCase())) || numerics.some(numeric => text.includes(numeric));
        }) || null;
    }, options);
    const item = itemHandle.asElement();
    if (!item) {
      await itemHandle.dispose().catch(() => {});
      await openerHandle.dispose().catch(() => {});
      log(`Could not select image aspect ratio ${ratio || 'auto'}; using workflow prompt fallback. Opener: ${openerText || 'unknown'}`);
      await page.keyboard.press('Escape').catch(() => {});
      return;
    }
    let active = false;
    try {
      const box = await item.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      else await item.click();
      await sleep(500);
      active = await opener.evaluate((button, options) => {
        const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const text = `${norm(button.innerText || button.textContent)} ${norm(button.getAttribute('aria-label'))}`;
        return options.some(label => {
          const [name, numeric] = norm(label).split(' ');
          return text.includes(norm(label)) || text.includes(name) || numeric && text.includes(numeric);
        });
      }, options);
    } finally {
      await itemHandle.dispose().catch(() => {});
      await openerHandle.dispose().catch(() => {});
    }
    await page.keyboard.press('Escape').catch(() => {});
    if (!active) {
      log(`Image aspect ratio UI did not confirm ${ratio || 'auto'}; workflow prompt fallback remains active.`);
      return;
    }
    log(`Selected image aspect ratio: ${ratio || 'auto'}`);
  }

  /**
   * 通过隐藏的 file input 上传一个或多个文件。
   *
   * ChatGPT Web 在重复文件、frame 重建或大文件解析时会出现短暂 toast/dialog。
   * 这里不把 toast 文案当成功标准，只等待 send button 重新可用；如果 frame 已 detached，
   * 对 frame/context 重建保留两次有界重试，避免瞬态恢复刚好跨过单次重试窗口。
   */
  async function uploadFiles(page, files, workspaceDir, log, shouldCancel = () => false) {
    // 上传失败不能降级成无附件发送；先校验本地文件存在，再碰 ChatGPT 页面。
    for (const file of files) {
      if (!fs.existsSync(file)) throw new Error(`Upload file not found: ${file}`);
    }
    if (files.length === 0) return;

    // Chromium 在 detached frame 与 file chooser 重建时可能连续失败两次；保留第三次有界恢复机会。
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        log(`Uploading ${files.length} file(s), attempt ${attempt}: ${files.map(file => path.basename(file)).join(', ')}`);
        await page.waitForSelector('#prompt-textarea', { timeout: 15_000 });
        if (shouldCancel()) throw new Error('Ask cancelled during upload preparation');
        const names = files.map(file => path.basename(file));
        // 任意既有 chip 都可能是上次 partial batch；必须整体清空，不能只在所有文件名齐全时清理。
        if (await attachmentCount(page) > 0) {
          await clearComposerAttachments(page, log);
          await sleep(500);
          await assertNoComposerAttachments(page);
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
    // direct 请求按音频大小扩展预算，但始终受外层 voice 总 deadline 约束。
    // 上限 45s：必须低于外层 VOICE_TRANSCRIBE_TIMEOUT_MS(60s)，留余量给 session fetch + 开销。
    const fetchTimeoutMs = Math.min(45_000, Math.max(15_000, audioBase64.length * 0.005));
    return page.evaluate(async (config) => {
      const startedAt = performance.now();
      // 必须在页面任务内部检查；Node 的 page.url() 与 evaluate 之间存在导航竞态，不能保护录音字节。
      if (location.origin !== config.requiredOrigin) throw new Error('Voice page left the official ChatGPT origin');
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
      // 私有 direct endpoint 当前接受 file 字段；结构漂移时抛错并回退到 UI dictation。
      // 这里复用 ChatGPT 前端 batch fallback 的 /backend-api/transcribe 语义：上传一个 File，由网页会话 bearer token 授权。
      // 只传文件名和 MIME，不传本地绝对路径；token 只用于当前请求，永远不返回到 Node 日志。
      form.append('file', new File([bytes], config.name, { type: config.mimeType }));
      // session fetch 后仍可能发生 SPA/外部导航；POST 音频前再次在同一 execution context 核验 origin。
      if (location.origin !== config.requiredOrigin) throw new Error('Voice page left the official ChatGPT origin');
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
      // daemon 入口只接受 RIFF/WAVE；不维护当前不可达的其它音频 MIME 分支。
      mimeType: 'audio/wav',
      // fetch 超时传给页面侧 AbortController
      fetchTimeoutMs,
      requiredOrigin: 'https://chatgpt.com',
    });
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
    // 上传解析继承 responseTimeout，但 60 秒没有进入可发送态视为网页退化，避免永久占住 session lock。
    const startedAt = Date.now();
    for (;;) {
      if (shouldCancel()) throw new Error('Ask cancelled while waiting for upload readiness');
      if (Date.now() - startedAt > Math.min(responseTimeout, 60_000)) throw new Error('Upload did not become ready within the browser progress window');
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
    return (await attachmentState(page)).texts.length;
  }

  function attachmentState(page, names = []) {
    // cleanup、计数和 ready 判断共用同一 DOM 解释，避免 ChatGPT chip 结构漂移时三处分别更新。
    return page.evaluate(names => {
      const texts = attachmentTexts();
      const haystack = texts.join(' ');
      return { texts, namesPresent: names.every(name => haystack.includes(normalize(name))) };

      function attachmentTexts() {
        const input = document.querySelector('#prompt-textarea');
        const root = input?.closest('form') || input?.parentElement?.parentElement;
        if (!root) return [];
        const texts = new Set();
        // 当前文件 tile 优先暴露 role=group + 文件名 aria-label；data-testid 只作后备。
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
    }, names);
  }

  async function waitForAttachmentCount(page, expected, names, shouldCancel) {
    // 上传结束以“预期数量的附件 chip 可见”为准，而不是以 toast 或 send button 状态为准。
    // 同时校验文件名，是为了挡住一种很隐蔽的失败：历史附件或页面其它 file 卡片让数量达标，
    // 但本次真正要发的附件并未挂到 composer 上。这里宁可等待外层取消，也不要发送“缺附件”的 prompt。
    // basename 可以包含空格、中文或没有扩展名；比较前统一 NFKC/空白/大小写，避免 UI 文本形态差异导致误判。
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let lastSnapshot = '';
    for (;;) {
      if (shouldCancel()) throw new Error('Ask cancelled while waiting for attachment chips');
      if (Date.now() - startedAt > responseTimeout || Date.now() - lastProgressAt > 30_000) throw new Error('Attachment chips made no progress after upload');
      const state = await attachmentState(page, names);
      if (state.texts.length >= expected && state.namesPresent) return;
      const snapshot = state.texts.join('\0');
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        lastProgressAt = Date.now();
      }
      await sleep(1_000);
    }
  }

  function isRecoverableBrowserError(err) {
    // 只重试同一 page 上可恢复的 frame/context/node 重建；Target closed 和泛化协议错误需要上层换页。
    return /detached Frame|Execution context was destroyed|Cannot find context|Node is detached/i.test(err.message || '');
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
    // 可信点击只解决浏览器事件语义，不能单独证明远端接受；user turn 或路由变化才是接受证据。
    // core 的 beforeClick 回调在同一个同步栈中复核页面身份，因此 URL 漂移会阻止鼠标事件发出。
    // 点击后的路由仍可能错误，core 随后用 conversation policy 再验证，DOM 层不擅自写 registry。
    // 发送具有远端副作用：点击前失败可以安全重试，点击开始后则必须先写 lost/pending 防重发标记。
    // 接受证据只认新增 user turn；composer 清空和 URL 变化都可能由手动导航造成，不能单独证明提交成功。
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
    const before = await page.evaluate(value => {
      const input = document.querySelector('#prompt-textarea');
      const form = input?.closest('form');
      const button = form?.querySelector('button[data-testid="send-button"]');
      return {
        valid: !!button && !button.disabled && composerText(input) === value,
        userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
        url: location.href,
      };

      function composerText(input) {
        return normalize((input?.innerText || input?.textContent || '').replace(/\r\n?/g, '\n'));
      }

      function normalize(value) {
        return String(value || '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
      }
    }, expectedPrompt);
    if (!before.valid) throw new Error('Send button verification failed before click');

    // Project 首页忽略 DOM button.click() 的非可信事件；ElementHandle.click 才会产生浏览器级鼠标事件。
    // 句柄仍从当前 composer form 内获取，避免全局 selector 点到隐藏或历史 composer。
    const handle = await page.evaluateHandle(() => document.querySelector('#prompt-textarea')?.closest('form')?.querySelector('button[data-testid="send-button"]'));
    const button = handle.asElement();
    if (!button) {
      await handle.dispose();
      throw new Error('Send button disappeared before trusted click');
    }
    // waitForFunction 已通过且句柄已取得后才布置 tombstone；pre-click 失败不会污染 session registry。
    beforeClick();
    try { await button.click(); }
    finally { await handle.dispose(); }

    // composer 清空或路由变化都可能来自手动导航；只有本轮 user turn 真正进入 DOM 才算网页接受。
    await page.waitForFunction(userCount => {
      return document.querySelectorAll('[data-message-author-role="user"]').length > userCount;
    }, { timeout: 10_000, polling: 100 }, before.userCount);
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
    options.foreground = foregroundPulse(page, options.foregroundPulseMs || 0, options.shouldSkipForeground);
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
        if (submitted && current.emptyAssistantTurn && current.turnCount > (before.turnCount || 0)) return;
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
      const hasNewEmptyAssistant = state.emptyAssistantTurn && state.turnCount > (before.turnCount || 0);
      if (responseLen !== lastLen || state.nativeImageCount !== lastImageCount) {
        lastLen = responseLen;
        lastImageCount = state.nativeImageCount;
        lastChangedAt = Date.now();
        continue;
      }

      // Copy/Regenerate 等操作只在完整 assistant turn hydrate 后出现；它是安全的加速信号，不替代 stop 与本轮归属检查。
      const stableMs = state.completionControls || hasNewEmptyAssistant ? 750 : responseStableMs(responseLen, options.slow);
      if (!state.generating && !state.placeholder && (hasNewText || hasNewNativeImage || hasNewEmptyAssistant) && Date.now() - lastChangedAt >= stableMs) {
        return { status: 'completed', reason: 'stable' };
      }
    }
  }

  function foregroundPulse(page, intervalMs, shouldSkip) {
    // ChatGPT Web 有些内容在后台 tab 不会完整 hydrate；等待期间低频轮流激活页面并滚动到最下方,避免只抽到引用/空 assistant。
    // 频率不能太高，否则并发会话会互相抢前台；8s 级别足够触发渲染,又不会像 polling 一样打扰用户。
    // shouldSkip:voice fallback 活跃时跳过 pulse,避免抢前台干扰听写 UI。
    let last = 0;
    return async () => {
      if (!intervalMs || Date.now() - last < intervalMs) return;
      if (shouldSkip?.()) return;
      last = Date.now();
      await page.bringToFront().catch(() => {});
      await scrollToEnd(page);
      await sleep(150);
    };
  }

  async function assistantState(page, count) {
    // 外层只需要普通状态对象；不要把 DOM 节点句柄泄漏给 core，frame 重建时节点句柄很容易失效。
    return page.evaluate(existingCount => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
      const lastText = msgs.length > 0 ? (msgs[msgs.length - 1].innerText || '').trim() : '';
      const turns = [...document.querySelectorAll('[data-testid^="conversation-turn"]')];
      const emptyAssistantTurn = emptyUnroleAssistantTurn(turns);
      const stopButton = !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]');
      const latestAssistant = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const completionControls = [...(latestAssistant?.querySelectorAll('button') || [])]
        .filter(button => !!(button.offsetWidth || button.offsetHeight || button.getClientRects().length))
        .some(button => /copy|复制|regenerate|重新生成|share|分享|read aloud|朗读|like|点赞|dislike|踩/i.test(`${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`));
      // 图片 URL 快照既用于完成判定，也用于下载阶段过滤旧图；复用同一 session 时不能把历史图片当本轮产物。
      // 原生绘图回答会生成 image-turn，而不是 assistant role；全页快照才能让 image-only 任务从 pending 恢复。
      const nativeImageURLs = generatedImageURLs(document);
      return {
        count: existingCount ?? msgs.length,
        userCount,
        nativeImageCount: nativeImageURLs.length,
        nativeImageURLs,
        turnCount: turns.length,
        lastText,
        generating: stopButton,
        placeholder: /^(thinking|thinking\.\.\.|思考中|正在思考)$/i.test(lastText.replace(/\s+/g, ' ').trim()),
        completionControls,
        emptyAssistantTurn,
        url: location.href,
      };

      function emptyUnroleAssistantTurn(turns) {
        // Deep Research 实测会留下一个只有“ChatGPT 说：”的 turn，但没有 assistant role 节点。
        // 只检查最新 turn；历史里是否已有普通 assistant 不影响本轮空完成判定。
        const latest = turns.at(-1);
        return !!latest
          && !latest.querySelector('[data-message-author-role="assistant"]')
          && !latest.querySelector('[data-message-author-role="user"]')
          && /^(ChatGPT\s*说[:：]?|ChatGPT said[:：]?)$/.test((latest.innerText || latest.textContent || '').replace(/\s+/g, ' ').trim());
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
  async function downloadSandboxFiles(page, downloadDir, log, limit, byteBudget, shouldCancel, previousAssistantCount) {
    // 候选发现仅限最后一条 assistant，避免历史回答中的同名按钮被当成本轮生成文件。
    // 按钮和 card 可能指向同一 DOM 控件，必须先按元素索引去重再应用数量/字节预算。
    // 预览下载与直接下载共用落盘观察；按钮点击、dialog 出现都不能替代实际稳定文件。
    // Browser.setDownloadBehavior 是整个浏览器上下文的状态，不属于单页；外层队列保证同一时间只有一个目录生效。
    // 每个候选再使用独占 workDir，把“本轮唯一新文件”变成可验证事实，而不是信任模型给出的文件名。
    // CDP 默认状态必须在 finally 恢复，否则用户后续手动下载也会被静默导入 OpenCode cache。
    if (limit <= 0) return { downloads: [], notices: [] };
    ensurePrivateDir(downloadDir);
    const client = await page.target().createCDPSession();
    try {
      const files = await page.evaluate(({ limit, previousAssistantCount }) => {
        const messages = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
        // image-only/空 turn 不新增标准 assistant 节点；此时不能把上一轮 sandbox 文件重新归属给本轮。
        if (Number.isInteger(previousAssistantCount) && messages.length <= previousAssistantCount) return [];
        const msg = messages.at(-1);
        if (!msg) return [];
        const buttons = [...msg.querySelectorAll('button')];
        const inlineButtons = buttons
          .map((button, index) => {
            // 有些 sandbox 卡片按钮只叫 Download，没有文件名；先记录按钮位置，落盘后再以真实文件名为准。
            const label = (button.innerText || button.textContent || button.getAttribute('aria-label') || '').trim();
            const namedText = label.replace(/^(download|下载)(?:\s+|$)/i, '').trim();
            return { kind: 'button', index, text: namedText || `artifact-${index + 1}`, named: !!namedText, label };
          })
          .filter(button => /download|下载/i.test(button.label) || /\.[a-z0-9]{1,16}$/i.test(button.text));
        const cardElements = [...msg.querySelectorAll('.group.my-4')];
        const cards = cardElements
          .map((card, index) => {
            const buttonIndex = buttons.indexOf(card.querySelector('button:not([disabled])'));
            const namedText = ((card.innerText || '').match(/[^\s]+\.[a-z0-9]{1,16}\b/i) || [])[0];
            return { kind: 'card', index, buttonIndex, text: namedText || `artifact-card-${index + 1}`, named: !!namedText };
          })
          // 同一个 card button 可能同时满足 inline 与 card 规则；按 DOM 身份只保留一次，避免重复下载占预算。
          .filter(card => card.buttonIndex >= 0 && !inlineButtons.some(button => button.index === card.buttonIndex));
        return [...inlineButtons, ...cards].slice(0, limit);
      }, { limit, previousAssistantCount });

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
          // 新版文件预览从 Browser 域触发下载；旧 Page.setDownloadBehavior 不再控制其落盘目录。
          await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: workDir });
          // 每个 artifact 都落在独立临时目录，失败或超时也不会把裸文件混入最终 downloads 根目录。
          const before = snapshotDownloadDir(workDir);
          const beforeTemp = snapshotTempFiles(workDir);
          const clicked = await clickSandboxArtifact(page, file);
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
          // 新版文件卡片会打开全屏预览；下载完成或失败后退出，避免遮住 composer 和下一份产物。
          await page.keyboard.press('Escape').catch(() => {});
          cleanupDownloadWorkDir(workDir);
        }
      }
      return { downloads, notices };
    } finally {
      // 下载目录是浏览器上下文级状态；用完立即恢复并 detach，避免后续手动下载落到会话 cache。
      await client.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
      await client.detach().catch(() => {});
    }
  }

  async function clickSandboxArtifact(page, target) {
    // 预览可能复用旧 portal；先记录可见 dialog 的签名计数，后续只操作新增或内容已变化的实例。
    const dialogsBefore = await page.evaluate(() => {
      const visible = item => !!(item.offsetWidth || item.offsetHeight || item.getClientRects().length);
      return [...document.querySelectorAll('[role="dialog"]')].filter(visible)
        .map(dialog => `${dialog.getAttribute('aria-label') || ''}\u0000${dialog.innerText || dialog.textContent || ''}`.replace(/\s+/g, ' ').trim());
    });
    const handle = await page.evaluateHandle(target => {
      const msg = [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
      if (!msg) return null;
      const clean = value => (value || '').trim().replace(/^(download|下载)\s+/i, '');
      return target.kind === 'card'
        ? (target.named
            ? [...msg.querySelectorAll('.group.my-4')].find(card => (card.innerText || '').includes(target.text))
            : [...msg.querySelectorAll('.group.my-4')][target.index])?.querySelector('button:not([disabled])') || null
        : target.named
          ? [...msg.querySelectorAll('button')].find(button => clean(button.innerText || button.textContent || button.getAttribute('aria-label') || '') === target.text) || null
          : [...msg.querySelectorAll('button')][target.index] || null;
    }, target);
    const artifact = handle.asElement();
    if (!artifact) {
      await handle.dispose().catch(() => {});
      return false;
    }
    try {
      await page.bringToFront().catch(() => {});
      await artifact.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await sleep(100);
      const box = await artifact.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      else await artifact.click();
    } finally {
      await handle.dispose().catch(() => {});
    }

    // 旧版会直接下载；新版可能先开预览。这里只尝试最新可见 dialog，最终仍以文件落盘为准。
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const downloadHandle = await page.evaluateHandle(dialogsBefore => {
        const visible = item => !!(item.offsetWidth || item.offsetHeight || item.getClientRects().length);
        const counts = new Map();
        dialogsBefore.forEach(signature => counts.set(signature, (counts.get(signature) || 0) + 1));
        const dialog = [...document.querySelectorAll('[role="dialog"]')].filter(visible).find(item => {
          const signature = `${item.getAttribute('aria-label') || ''}\u0000${item.innerText || item.textContent || ''}`.replace(/\s+/g, ' ').trim();
          const remaining = counts.get(signature) || 0;
          if (!remaining) return true;
          counts.set(signature, remaining - 1);
          return false;
        });
        return [...(dialog?.querySelectorAll('button:not([disabled])') || [])]
          .find(button => /^(download|下载)$/i.test(`${button.getAttribute('aria-label') || button.textContent || ''}`.replace(/\s+/g, ' ').trim()) && visible(button)) || null;
      }, dialogsBefore);
      const download = downloadHandle.asElement();
      if (download) {
        try { await download.click(); }
        finally { await downloadHandle.dispose().catch(() => {}); }
        break;
      }
      await downloadHandle.dispose().catch(() => {});
      await sleep(200);
    }
    return true;
  }

  /**
   * 保存 ChatGPT 原生绘图结果。
   *
   * 原生图片不走 sandbox，也通常没有下载按钮；页面里的 estuary/content URL 需要登录态 cookie。
   * 因此只在 page.evaluate 内发现 URL，实际 fetch/write 由 Node stream 完成。
   */
  async function downloadNativeImages(page, downloadDir, log, limit, byteBudget, shouldCancel, previousURLs = []) {
    // 原生图片不在 sandbox，发现范围必须覆盖 image-generation turn，但发送前 URL 快照仍排除历史图片。
    // fetch 复用登录 cookie，origin 候选已由页面侧过滤；Node 侧只负责流式字节与磁盘预算。
    // headers/body 共享无进展 abort，确保一个挂起 estuary 响应不会占住全局 artifact 队列数分钟。
    // 每张图失败只清理自己的 partial file 并记录 notice，其它候选仍继续，保留部分成功语义。
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
        let lastProgressAt = Date.now();
        // headers 和 body 共用无进展窗口；每个 stream chunk 刷新时间，慢速但持续传输的图片不会被误杀。
        cancelPoll = setInterval(() => { if (shouldCancel() || Date.now() - lastProgressAt > 30_000) controller.abort(); }, 500);
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
        if (response.body) await pipeline(Readable.fromWeb(response.body), byteLimitStream(byteBudget - usedBytes, () => { lastProgressAt = Date.now(); }), fs.createWriteStream(file, { mode: 0o600 }));
        else {
          const buffer = Buffer.from(await response.arrayBuffer());
          lastProgressAt = Date.now();
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

  function byteLimitStream(limit, onProgress = () => {}) {
    // Node fetch 能 streaming；无 content-length 时也能在写盘过程中及时停止，而不是等磁盘写满。
    let size = 0;
    return new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > limit) return callback(new Error(`artifact byte budget exceeded (${limit} bytes)`));
        onProgress();
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
    // 硬上限继承外层 responseTimeout，不另造更短的“文件大小”预算；30 秒无任何字节/文件变化才判定卡死。
    // 这样慢速大文件只要持续增长就继续，而失效按钮不会永久占住浏览器级 artifact 队列。
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let lastSignature = '';
    // 先找期望文件；只允许 Chrome 对同名文件追加 "(1)" 这类重命名，不接受任意变化文件。
    for (;;) {
      if (shouldCancel()) throw new Error('caller cancelled while waiting for generated file download');
      if (Date.now() - startedAt > responseTimeout) throw new Error(`Artifact download timed out with the outer response budget: ${expectedName}`);
      if (Date.now() - lastProgressAt > 30_000) throw new Error(`Artifact download made no progress for 30000ms: ${expectedName}`);
      await sleep(500);
      const tempFiles = fs.readdirSync(downloadDir).filter(name => name.endsWith('.crdownload') || name.endsWith('.tmp'));
      const signature = fs.readdirSync(downloadDir).flatMap(name => {
        // 文件名、大小或 mtime 任一变化都算进展；仅 wall-clock 变长不会替卡死下载续命。
        try {
          const stat = fs.statSync(path.join(downloadDir, name));
          return [`${name}:${stat.size}:${stat.mtimeMs}`];
        } catch { return []; }
      }).sort().join('|');
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastProgressAt = Date.now();
      }
      if (tempFiles.some(name => !beforeTemp.has(name))) continue;
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

// 滚动到对话最下方,确保最新 assistant 消息在视口内渲染。
// ChatGPT 虚拟化视口外的消息;后台恢复前台后必须滚动,否则 assistantState 读到空/过期文本。
// 同步 JS 操作(scrollTop/scrollIntoView),不依赖 rAF,后台也能执行。
function scrollToEnd(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (msgs.length > 0) msgs[msgs.length - 1].scrollIntoView({ block: 'end' });
  }).catch(() => {});
}

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
