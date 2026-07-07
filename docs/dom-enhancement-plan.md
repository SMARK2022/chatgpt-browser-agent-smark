# DOM 方案改造增强方案

> 仅针对现有 DOM 路径。基于完整代码审计,修复全部 CRITICAL + MEDIUM + 用户请求改进。
> 包含页面生命周期管理、voice/ask 冲突协调、避免不必要重载、模块化分离。

---

## 0. 调研确认声明

### 0.1 已阅读的文件

| 文件 | 相关性 |
| --- | --- |
| chatgpt-dom.js 1-210, 279-397, 508-660, 975-1250, 1419-1660 | adapter 全部 hot path:focus/foregroundPulse/waitForResponse/voice/download |
| chatgpt-core.js 31-75, 209-215, 561-572, 801-803, 986-1090, 1089-1305, 1309-1328, 1339-1521, 1570-1731, 1763-1860 | daemon 全部业务路径:config/locks/voice/ask/startup/shutdown/handlers |
| chatgpt.js 56-59, 785-808 | CLI 层 timeouts + transcribeFile |
| test-mcp.js 1-110, 455-545, 700-755 | 测试组织 |
| projects.json | URL 缓存(已手动修复为 /c/new) |

### 0.2 通过搜索确认的调用点

- `parseProjectRef`(core.js:569)被 `resolveCachedProject`(904)、`resolveProject`(921)、`projectIdFromUrl`(574)调用——所有 project URL 经过此函数。
- `foregroundPulse`(dom.js:1161)在 `waitUntilResponseStarts`(1094)和 `Settles`(1130)中调用。
- `focus`(dom.js:71)被 `finishAsk`(core.js:1490)和 `recoverCurrentAssistant`(core.js:1054)调用。
- `waitForDownloadedFile`(dom.js:1625)被 `downloadSandboxFiles`(1469)调用,无超时。
- `transcribeAudioFile`(dom.js:162)被 `runVoiceTranscribe`(core.js:1312)调用;fallback 导航到 `voiceUrl=project.url`(dom.js:190)。
- /voice handler(core.js:1763)无 `res.on('close')`;/ask handler(1799)有。
- `foregroundPulseMs: 4_000`(core.js:1284)硬编码。
- `voiceLock`(core.js:1103)全局串行;`withSession`(1254)per-sessionID 串行。
- voice 页面(`persistentVoicePage`)和 ask 页面(`sessionPages`)是不同 page,但同一 browser window 内只能一个 tab 前台。

### 0.3 必须保持的既有行为

1. 完成判定语义(`responseStableMs`/`fullyRendered`/`doneStableMs`/`!state.generating`)。
2. deadline 模型(540s)。
3. cancel 语义(ask: `shouldCancel=()=>clientClosed`)。
4. voiceLock/withSession 串行 + `.catch(()=>{})`/`.finally` 保证释放。
5. pending recovery(session URL + DOM 检查兜底)。
6. stalePageTimer(60s 清理 untracked)。
7. collectArtifacts(`focus(page)` 后读 DOM 下载按钮)。

### 0.4 已确认的边界/安全问题

| 编号 | 问题 | 确认 |
| --- | --- | --- |
| C1 | `/project` 是设置页 | 实验验证 |
| C2 | foregroundPulse/focus 不滚动 | 代码确认 |
| V1 | voice fallback 导航到项目页,干扰 ask | 代码确认:dom.js:189-190 导航到 `voiceUrl=project.url` |
| V2 | voice fallback 的 bringToFront 与 ask foregroundPulse 互相抢前台 | 同一 browser window 只能一个 tab 前台 |
| M1 | waitForDownloadedFile 无超时 | 代码确认:`for(;;)` 无 deadline |
| M2 | /voice 无 cancel | 代码确认 |
| M3 | focus 不滚动 | 代码确认 |
| URL | `/c/new` 是正确聊天入口 | 实验验证:不重定向,composer 为空 |

### 0.5 不确定点及确认

| 不确定 | 确认 |
| --- | --- |
| voice fallback 是否必须在项目页 | 否——听写按钮和 composer 在 `chatgpt.com/` 主页也有 |
| `voiceFallbackActive` 标志是否必要 | 是——voice fallback ~90s,foregroundPulse 8s 一次会多次抢前台,导致听写 UI 冻结 |
| `scrollToEnd` 在后台是否工作 | 是——`scrollTop`/`scrollIntoView` 是同步 JS,不依赖 rAF |
| `foregroundPulse` 8s 是否影响完成判定 | 否——`!state.generating` 在生成期防护;pulse 只影响 DOM 刷新频率 |

---

## 1. 推荐最小实现方案

### C1. URL 修复

- `core.js:569`: `${CHATGPT_URL}/g/${token}/project` → `${CHATGPT_URL}/g/${token}/c/new`
  - **必须保留 `/g/${token}/` 前缀**(项目上下文 + `isChatSessionUrlForProject` + `rememberCurrentSessionUrl` 依赖此路径)
  - 实验验证:`/g/{token}/c/new` 不重定向,composer 为空,会话 URL 保留 `/g/{token}/c/{convId}` 格式
- **不改 `cachedProjectsFromPage`(dom.js:270)**:href 用于 token 提取(`/g/(g-p-[^/]+)` regex),改为 `/c/new` 会破坏 token 提取。href 是身份标识,不是导航目标。
- **`isChatSessionUrlForProject` 加 `/c/new` 拒绝**(core.js:578):`/c/new` 含 `/c/` 会被误匹配为有效会话 URL,导致 `rememberCurrentSessionUrl` 在 ChatGPT 尚未将 URL 改为 `/c/{convId}` 时就记录 `/c/new`。修复:在 `isChatSessionUrlForProject` 开头加 `if (/\/c\/new(?:[?#]|$)/.test(url)) return false;`——拒绝 transient `/c/new`,只接受真正的 `/c/{convId}`。

### C2+U2+M3+S1. scrollToEnd helper + foregroundPulse/focus 滚动

新增模块级 `scrollToEnd(page)`(dom.js,紧邻 `sleep`):
```js
// 滚动到对话最下方,确保最新 assistant 消息在视口内渲染。
// ChatGPT 虚拟化视口外的消息;后台恢复前台后必须滚动,否则 assistantState 读到空/过期文本。
function scrollToEnd(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (msgs.length > 0) msgs[msgs.length - 1].scrollIntoView({ block: 'end' });
  }).catch(() => {});
}
```

`foregroundPulse` 改为:
```js
function foregroundPulse(page, intervalMs, shouldSkip) {
  let last = 0;
  return async () => {
    if (!intervalMs || Date.now() - last < intervalMs) return;
    if (shouldSkip?.()) return; // voice fallback 活跃时跳过,避免抢前台(V2 修复)
    last = Date.now();
    await page.bringToFront().catch(() => {});
    await scrollToEnd(page);
    await sleep(150);
  };
}
```

`focus` 改为:
```js
async focus(page) {
  await page.bringToFront().catch(() => {});
  await scrollToEnd(page);
  await sleep(1_000);
},
```

`waitForResponse` 传递 `shouldSkip`:
```js
options.foreground = foregroundPulse(page, options.foregroundPulseMs || 0, options.shouldSkipForeground);
```

### U1. foregroundPulseMs 4s → 8s

- `core.js:1284`: `foregroundPulseMs: 8_000`

### V1. voice fallback 不导航到项目页

`transcribeAudioFile`(dom.js:189-190)改为:
```js
// 听写 UI 在任何 chatgpt.com 聊天页都可用;不导航到项目页,避免创建多余对话和干扰 ask 会话
if (!/^https:\/\/chatgpt\.com/i.test(page.url())) {
  await page.goto(voiceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
}
```
- 将 `/g/` 检查改为 `chatgpt.com`——voice 页已在 chatgpt.com 上时不再导航
- `runVoiceTranscribe` 传 `CHATGPT_URL` 替代 `runtime.project.url` 作为 `voiceUrl`

### V2. voice/ask 前台协调

runtime 新增共享标志 holder(core.js createDaemonRuntime 内):
```js
// 用对象持有,避免闭包变量和 runtime 属性不匹配(B1 修复)
const flags = { voiceFallbackActive: false };
```

`runtime.waitForResponse` 传递 `shouldSkipForeground`:
```js
async waitForResponse(page, beforeState, waitOptions, log) {
  return CHATGPT_DOM.waitForResponse(page, beforeState, {
    ...waitOptions,
    foregroundPulseMs: 8_000,
    shouldSkipForeground: () => flags.voiceFallbackActive,
  }, log);
},
```

runtime 暴露 `beginVoiceFallback`/`endVoiceFallback` 方法:
```js
beginVoiceFallback() { flags.voiceFallbackActive = true; },
endVoiceFallback() { flags.voiceFallbackActive = false; },
```

`transcribeAudioFile` 加 `onFallbackStart` 回调(dom.js):
```js
async transcribeAudioFile(page, file, voiceUrl, log, shouldCancel = () => false, onFallbackStart = () => {}) {
  // ... direct path 不变 ...
  } catch (err) {
    if (/timed out|timeout|abort|target closed|protocol error/i.test(err.message)) throw err;
    if (shouldCancel()) throw new Error('Voice transcription cancelled before fallback');
    onFallbackStart(); // 通知 caller:fallback 开始,需要独占前台
    log(`Direct voice transcription failed, falling back to dictation UI: ${err.message}`);
  }
  // ... fallback 不变 ...
}
```

`runVoiceTranscribe` 通过 runtime 方法设置/清除标志(core.js):
```js
async function runVoiceTranscribe(runtime, input, log, shouldCancel = () => false) {
  const page = await runtime.voicePage();
  const transcribePromise = CHATGPT_DOM.transcribeAudioFile(page, input.file, CHATGPT_URL, log, shouldCancel, () => {
    runtime.beginVoiceFallback(); // flags.voiceFallbackActive = true
  });
  const cancel = cancelSignal(shouldCancel, 500);
  try {
    const text = await Promise.race([
      withTimeout(transcribePromise, VOICE_TRANSCRIBE_TIMEOUT_MS, ...),
      cancel,
    ]);
    return { ok: true, text };
  } catch (err) {
    if (/Voice transcription cancelled|timed out|timeout|abort|target closed|protocol error/i.test(err.message)) {
      transcribePromise.catch(() => {});
      runtime.invalidateVoicePage(page);
    }
    throw err;
  } finally {
    runtime.endVoiceFallback(); // flags.voiceFallbackActive = false
    cancel.stop();
  }
}
```

**效果**: voice fallback 运行时(~90s),ask 的 foregroundPulse 跳过(不抢前台);fallback 结束后自动恢复。voice direct path(2-8s)不设标志(不需要前台)。

### M1. waitForDownloadedFile 加 progress-aware 超时(B5 修复)

```js
async function waitForDownloadedFile(downloadDir, before, beforeTemp, expectedName, shouldCancel) {
  const MAX_WAIT = 120_000; // 最长等 120s(对齐大文件场景,原设计无固定超时)
  const start = Date.now();
  let lastProgressAt = start;
  let lastTempSize = 0;
  for (;;) {
    if (shouldCancel()) throw new Error('caller cancelled while waiting for generated file download');
    const elapsed = Date.now() - start;
    const stalled = Date.now() - lastProgressAt;
    // 总超时 120s(硬上限,防止无限等待)或停滞 30s(临时文件大小不变,区分"下载中"和"卡住")
    if (elapsed > MAX_WAIT || stalled > 30_000) throw new Error(`Artifact download ${elapsed > MAX_WAIT ? 'timed out' : 'stalled'}: ${expectedName}`);
    await sleep(500);
    // 检测临时文件增长(progress-aware)
    const tempFiles = fs.readdirSync(downloadDir).filter(name => name.endsWith('.crdownload') || name.endsWith('.tmp'));
    let currentTempSize = 0;
    for (const name of tempFiles) { try { currentTempSize += fs.statSync(path.join(downloadDir, name)).size; } catch {} }
    if (currentTempSize !== lastTempSize) { lastTempSize = currentTempSize; lastProgressAt = Date.now(); }
    // ... 原有文件检测不变 ...
  }
}
```
- **总超时 120s**(不是 30s):对齐大文件(MAX_ARTIFACT_BYTES=4GiB)场景
- **停滞检测 30s**:临时文件大小不变超过 30s 才判定卡死(区分"下载中"和"卡住")
- 保留 dom.js:31-32 设计意图("不额外做固定下载超时")——改为 progress-aware,不是盲目固定超时

### M2. /voice cancel 检测

/voice handler 加 `res.on('close')` + `shouldCancel`(core.js:1763):
```js
let voiceClientClosed = false;
res.on('close', () => { if (!res.writableEnded) voiceClientClosed = true; });
// ... 传 () => voiceClientClosed 给 runVoiceTranscribe ...
```

新增 `cancelSignal` helper(core.js,紧邻 `withTimeout`):
```js
function cancelSignal(shouldCancel, pollMs) {
  let timer;
  const promise = new Promise((_, reject) => {
    const check = () => {
      if (shouldCancel()) reject(new Error('Voice transcription cancelled: client disconnected'));
      else timer = setTimeout(check, pollMs);
    };
    timer = setTimeout(check, pollMs);
  });
  promise.stop = () => clearTimeout(timer);
  return promise;
}
```

`transcribeAudioFile` 加 `shouldCancel` 参数 + fallback 前检查(dom.js:184):
```js
if (shouldCancel()) throw new Error('Voice transcription cancelled before fallback');
```

### L1. final-confirmation — 移除(B4 修复)

**原方案**: `waitUntilResponseSettles` 返回 completed 前加 bringToFront+300ms+re-check。
**移除原因**: bringToFront 不受 `shouldSkipForeground` 管控,会在 voice fallback 期间抢前台,破坏 V2 协调。现有 `!state.generating` + `doneStableMs` + foregroundPulse 滚动已足够防护截断。如果未来需要,可以加 `shouldSkipForeground` 门控后再引入。

### S2. 增强 restoreSessionPage——避免不必要重载(B6 修复)

```js
async function restoreSessionPage(page, project, session, sessionID, log) {
  const targetUrl = session?.url || project.url;
  if (sameUrl(page.url(), targetUrl)) return;
  // 新会话:当前页已在本项目(/g/{token}/)的对话页且无消息——复用,不导航
  if (!session && page.url().includes(`/g/${project.token}/c/`)) {
    // 先 bringToFront 让消息 hydrate,避免虚拟化导致 count=0 假阳性(B6 修复)
    await page.bringToFront().catch(() => {});
    await sleep(500);
    const reusable = await page.evaluate(() =>
      !!document.querySelector('#prompt-textarea') &&
      document.querySelectorAll('[data-message-author-role]').length === 0
    ).catch(() => false);
    if (reusable) { log(`Reusing current page for new session ${sessionID}`); return; }
  }
  log(session ? `Restoring session ${sessionID}` : `Starting session ${sessionID}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
}
```
- regex 改为 `page.url().includes(\`/g/${project.token}/c/\`)`——必须匹配本项目 token,不误用其他项目页(B6 修复)
- 先 `bringToFront + sleep(500)` 让消息 hydrate,避免虚拟化假阳性(B6 修复)

---

## 2. 预计修改文件

| 文件 | 改动 | 行数 |
| --- | --- | --- |
| chatgpt-dom.js | `scrollToEnd` helper(+7) | +7 |
| chatgpt-dom.js | `focus` 改用 scrollToEnd(+1,~2 改) | +1 |
| chatgpt-dom.js | `foregroundPulse` 加 shouldSkip + scrollToEnd(+2,~2 改) | +2 |
| chatgpt-dom.js | `waitForResponse` 传 shouldSkipForeground(1 行改) | ~1 改 |
| chatgpt-dom.js | `waitUntilResponseSettles` final-confirmation — **移除**(B4) | 0 |
| chatgpt-dom.js | `waitForDownloadedFile` progress-aware 超时(+12) | +12 |
| chatgpt-dom.js | `transcribeAudioFile` 加 shouldCancel+onFallbackStart(+2)+fallback 导航改(~2 改) | +2, ~2 改 |
| chatgpt-core.js | `parseProjectRef` URL + `isChatSessionUrlForProject` 加 `/c/new` 拒绝(~2 改) | ~2 改 |
| chatgpt-core.js | `foregroundPulseMs` 8_000+`shouldSkipForeground`(~2 改) | ~2 改 |
| chatgpt-core.js | `restoreSessionPage` 增强(+8) | +8 |
| chatgpt-core.js | /voice handler 加 res.on('close')(+3) | +3 |
| chatgpt-core.js | `runVoiceTranscribe` 加 shouldCancel+cancelSignal+beginVoiceFallback/endVoiceFallback(~15) | +15 |
| chatgpt-core.js | 新增 `cancelSignal` helper(+10) | +10 |
| chatgpt-core.js | runtime 加 `flags` 对象 + beginVoiceFallback/endVoiceFallback 方法(+5) | +5 |
| chatgpt-core.js | `restoreSessionPage` 增强(+10) | +10 |
| chatgpt-core.js | `parseProjectRef` URL /g/{token}/project → /g/{token}/c/new(~1 改) | ~1 改 |
| chatgpt-core.js | `foregroundPulseMs` 8_000 + `shouldSkipForeground`(~2 改) | ~2 改 |
| test-mcp.js | 测试(~50) | +50 |

**总计:2 文件 + 1 test,净增 ~127 行,~8 行改,0 删除。**

---

## 3. 正常路径/错误路径/并发/退出/清理/安全

### 正常路径
**ask**: /ask → shouldCancel → runAsk → pageFor → restoreSessionPage(智能复用) → submit(bringToFront+scroll+fill+send) → waitForResponse(foregroundPulse 8s+scroll+shouldSkipForeground) → settle → focus(scroll) → extractAssistant → collectArtifacts(progress-aware timeout) → persist → reply

**voice direct**: /voice → voiceClientClosed → withVoice → voicePage → transcribeAudioFile(direct fetch,无前台,无导航) → reply

**voice fallback**: /voice → withVoice → voicePage → transcribeAudioFile(direct 失败) → onFallbackStart(voiceFallbackActive=true,ask pulse 跳过) → bringToFront+不导航(已在 chatgpt.com) → 听写 UI → onFallbackStart 结束(voiceFallbackActive=false) → reply

### 错误路径
| 错误 | 处理 |
| --- | --- |
| ask client 断开 | shouldCancel → generating → partial+pending |
| voice client 断开 | cancelSignal 500ms → invalidateVoicePage → voiceLock 释放 |
| voice fallback 中 ask pulse | shouldSkipForeground=true → pulse 跳过 → voice 独占前台 |
| 下载超时(30s) | throw → per-artifact catch → 跳过+notice |
| URL /c/new 失效 | waitForComposer 45s timeout → error → 不标记 lost |
| 页面刷新 | waitForComposer 等 composer 重新出现;assistantState.catch 容忍瞬时失败 |
| 页面关闭 | pageFor 检查 isClosed;evaluate throws → finishAsk catch → partial+pending |
| browser disconnect | shutdownOnce → process.exit(0) → recovery DOM 检查兜底 |

### 并发
- foregroundPulse 8s + scroll,voice fallback 时跳过(voiceFallbackActive)。
- voice 用 chatgpt.com 主页(不导航到项目页),ask 用项目页——不同 URL 减少冲突。
- voiceLock/withSession/withNewConversationLock/pageCreateQueue 不变。

### 退出/清理
- cancelSignal: `finally { cancel.stop() }` + `voiceFallbackActive = false`
- waitForDownloadedFile: 120s 总超时 + 30s 停滞 → per-artifact catch
- scrollToEnd: `.catch(() => {})` 容忍 detached frame

### 安全边界
- voice shouldCancel 只检测 client disconnect
- scroll 只读+设置 scrollTop,不修改 DOM 内容
- URL /c/new 是 ChatGPT 原生 URL
- voiceFallbackActive 是 runtime 内部状态,不暴露给外部
- 无新 env var / config / 公共 API

---

## 4. 行为级测试计划

### 先写的测试
1. **testForegroundPulseScrolls**: pulse 后 `main.scrollTop === main.scrollHeight`
2. **testVoiceFallbackSkipsAskForeground**: voice fallback 期间 foregroundPulse 不触发 bringToFront
3. **testVoiceCancelReleasesLock**: /voice 500ms 断开 → 第二次 /voice <10s 返回
4. **testDownloadTimeout**: 下载不出现 → 120s 总超时 throw + notice;下载停滞(临时文件不变)→ 30s stall throw
5. **testRestoreSessionPageReuse**: 干净对话页 → 不导航

### 当前缺口
- C1: URL /project → 新会话失败
- C2: 不滚动 → 后台 assistantState 读空
- V1: voice 导航到项目页 → 干扰 ask
- V2: voice/ask 抢前台 → 互相干扰
- M1: 下载无超时 → 无限循环
- M2: /voice 无 cancel → 60s block

### 实现后验证
```bash
cd thirdparty/chatgpt-browser-agent
npm run test:syntax && npm run test:deps
node test-mcp.js testForegroundPulseScrolls testVoiceFallbackSkipsAskForeground testVoiceCancelReleasesLock
node test-mcp.js   # 全量非 E2E
node test-mcp.js testE2EAskBasic testE2EVoiceTranscribe testE2EConcurrentAsks
```

---

## 5. 预估 git 体量

3 文件(chatgpt-dom.js + chatgpt-core.js + test-mcp.js),净增 ~117 行,~12 行改,0 删除。无新文件/迁移/文档(本文件除外)。

---

## 6. 真实风险与开放问题

### 已确认风险(有缓解)
1. **foregroundPulse 8s**: DOM 滞后 4s→8s;`!state.generating` 防护生成期;scroll 确保最新消息在视口内。
2. **voiceFallbackActive**: direct path 不设标志(不需要前台);fallback ~90s 独占前台,ask pulse 跳过。如果 fallback 期间 ask 的 DOM 也冻结(同 window 其他 tab 后台)——但 ask 有自己的 pulse(8s),fallback 结束后恢复。
3. **scrollToEnd 在并发时**: scrollIntoView 改变视口但不改变 tab 可见性;不同 page 互不影响。
4. **M1 下载超时**: 120s 总超时 + 30s 停滞检测;大文件(>3GB)在 120s 内可能被中断,但停滞检测会区分"下载中"和"卡住"。注意 dom.js:32 注释"不额外做固定下载超时"的设计意图被改变——需更新注释。

### 不构成风险(已排除)
- URL `/g/{token}/c/new`:实验验证不重定向;`isChatSessionUrlForProject` 加 `/c/new` 拒绝防止 premature match
- voice fallback 用主页:听写按钮在主页也有
- cancelSignal: `.stop()` in finally,无泄漏
- 截断防护:`!state.generating` + `doneStableMs` + scroll 确保最新消息渲染,无需 final-confirmation

### 需用户决策:无。

---

## 7. 推荐方案摘要

**3 文件,净增 ~127 行,~8 行改,0 删除。**

| 问题 | 修复 |
| --- | --- |
| C1: URL /project | `parseProjectRef` → `/g/{token}/c/new` + `isChatSessionUrlForProject` 拒绝 `/c/new` |
| C2: 不滚动 | `scrollToEnd` helper;`foregroundPulse`/`focus` 调用 |
| U1: 4s→8s | `foregroundPulseMs: 8_000` |
| V1: voice 导航到项目页 | fallback 检查改为 `chatgpt.com`;传 `CHATGPT_URL` |
| V2: voice/ask 抢前台 | `flags.voiceFallbackActive` + `beginVoiceFallback`/`endVoiceFallback` + `shouldSkipForeground` |
| M1: 下载无超时 | `waitForDownloadedFile` 120s 总超时 + 30s 停滞检测 |
| M2: /voice 无 cancel | `res.on('close')` + `cancelSignal` + `shouldCancel` |
| S1: 模块化 | `scrollToEnd` 可复用 helper |
| S2: 不必要重载 | `restoreSessionPage` 智能复用干净对话页 |

**核心安全属性:** foregroundPulse 8s+scroll;voice fallback 独占前台(ask pulse 跳过);voice 不导航到项目页;下载 120s 总超时+30s 停滞检测;URL /g/{token}/c/new + isChatSessionUrlForProject 拒绝 /c/new;voice cancel 500ms;截断防护靠 !state.generating + doneStableMs + scroll;零回归(所有新增参数默认 false/不触发)。
