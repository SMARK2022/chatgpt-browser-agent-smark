# Voice Cancel Daemon 崩溃修复方案

> 仅调研,不改代码。基于当前代码库完整审计。

---

## 0. 调研确认

### 0.1 已阅读文件

| 文件 | 行范围 | 相关性 |
| --- | --- | --- |
| chatgpt-core.js | 217-230(cancelSignal), 1265-1271(withVoice), 1339-1340(begin/endVoiceFallback), 1346-1375(runVoiceTranscribe), 1790-1794(send), 1820-1836(/voice handler), 1842-1860(/ask reply+res.on close) | voice cancel 完整链路 + send/reply 对比 |
| chatgpt-dom.js | 71-75(focus), 164-195(transcribeAudioFile shouldCancel+onFallbackStart), 1163-1174(foregroundPulse shouldSkip) | DOM adapter voice/focus 路径 |

### 0.2 通过搜索确认的调用点

- `send`(core.js:1791)被 /ping、/status、/stop、/voice、/ask 的 error catch 共用。
- `reply`(core.js:1848)是 /ask 专用,有 `res.destroyed || res.writableEnded` 守卫。
- `/voice` handler(core.js:1833)在 catch 中调 `send(500,...)` —— **无守卫**。
- voice cancel 链路:res.on('close') → voiceClientClosed → cancelSignal reject → runVoiceTranscribe throw → catch → send(500) → **res.writeHead() 抛异常** → daemon 崩溃。

### 0.3 必须保持的既有行为

1. `send` 正常路径(客户端未断开)必须正常回复。
2. `/ask` 的 `reply` 守卫不变(已有 `res.destroyed || res.writableEnded`)。
3. voice cancel 基础设施(cancelSignal/shouldCancel/invalidateVoicePage)不变——已就位且正确。

### 0.4 已确认的边界

| 问题 | 确认 |
| --- | --- |
| `send` 无 res 守卫 | 代码确认:line 1791-1794 直接 `res.writeHead()` |
| `/ask` reply 有守卫 | 代码确认:line 1849 `if (replied \|\| clientClosed \|\| res.destroyed \|\| res.writableEnded) return;` |
| voice cancel 触发 send(500) | 代码确认:line 1833 catch 块调 send |
| res.writeHead 在 destroyed res 上抛异常 | Node.js HTTP 规范:destroyed socket 上 writeHead 抛 ERR_HTTP_HEADERS_SENT 或 stream error |
| daemon 崩溃后 voiceLock 不释放 | withVoice(core.js:1265)的锁在 daemon 进程崩溃时随进程消亡;但如果 daemon 没崩溃而是进入异常状态,voiceLock 可能卡住 |

### 0.5 不确定点

| 不确定 | 确认方式 |
| --- | --- |
| daemon 是崩溃(process.exit)还是只是异常状态 | 需要实测:voice cancel 后检查 daemon PID 是否存活、/status 是否响应 |
| voiceLock 在 daemon 崩溃后是否自动释放 | daemon 崩溃 = 进程退出 = 所有内存状态丢失;重启后 voiceLock 是新的空 Promise;但 CLI 侧可能重连到死端口 |

---

## 1. 问题分析

### 1.1 voice cancel → daemon 崩溃链路

```
TUI 发起 voice 转录 → POST /voice/transcribe-file
→ daemon 收到请求,设置 res.on('close') → voiceClientClosed
→ runVoiceTranscribe 开始(cancelSignal 500ms 轮询 shouldCancel)
→ TUI 取消(req.destroy())
→ res 'close' 事件 → voiceClientClosed = true
→ cancelSignal 500ms 内检测 → reject('Voice transcription cancelled')
→ Promise.race reject → runVoiceTranscribe catch 块
→ invalidateVoicePage(page) + throw
→ /voice handler catch 块(line 1830-1833)
→ send(500, { ok: false, error: '...' })   ← 关键崩溃点
→ send 调 res.writeHead(500, ...)          ← res 已 destroyed!
→ Node.js 抛异常                            ← daemon 崩溃或异常
→ voiceLock 可能不释放                      ← 后续 voice/ask 永久阻塞
```

### 1.2 对比:/ask handler 不崩溃的原因

`/ask` 的 `reply` 函数(line 1848-1849):
```js
const reply = (status, obj) => {
  if (replied || clientClosed || res.destroyed || res.writableEnded) return;
  // ...
};
```
有 `res.destroyed || res.writableEnded` 守卫,客户端断开后静默返回。

`/voice` 用共享的 `send`(line 1791-1794):
```js
const send = (status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
```
**无任何守卫**。

---

## 2. 推荐最小实现方案

### 修复:`send` 加 res 守卫

**改动**(chatgpt-core.js line 1791-1794,1 行新增):

```js
const send = (status, obj) => {
  if (res.destroyed || res.writableEnded) return;  // 新增:客户端断开后静默返回
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
```

**为什么这个方案最符合现有设计**:
- 与 `/ask` 的 `reply` 守卫完全一致(`res.destroyed || res.writableEnded`)。
- 不引入新函数、新抽象、新配置。
- 不影响 `send` 正常路径(客户端未断开时 `res.destroyed` 为 false,`res.writableEnded` 为 false)。
- 所有共用 `send` 的 handler(/ping、/status、/stop、/voice、/ask error)都受益。

### 不需要改动的部分

- `cancelSignal`(已就位,500ms 检测正确)
- `runVoiceTranscribe`(已就位,catch + invalidateVoicePage + finally 正确)
- `/voice` handler 的 `res.on('close')`(已就位)
- `transcribeAudioFile` 的 `shouldCancel`/`onFallbackStart`(已就位)
- `foregroundPulse` 的 `shouldSkip`(已就位)
- `beginVoiceFallback`/`endVoiceFallback`(已就位)

---

## 3. 预计修改文件

| 文件 | 改动 | 行数 |
| --- | --- | --- |
| chatgpt-core.js | `send` 函数加 `if (res.destroyed \|\| res.writableEnded) return;` | +1 行 |
| test-mcp.js | 新增 `testVoiceCancelSendSafeOnClosedRes` 测试 | +35 行 |

**总计:2 文件,净增 ~36 行,0 行改,0 删除。**

---

## 4. 正常路径/错误路径/并发/退出/清理/安全

### 正常路径
voice 转录完成 → `send(200, result)` → `res.destroyed=false, res.writableEnded=false` → 正常回复。

### 错误路径(voice cancel)
TUI 取消 → `res.on('close')` → `voiceClientClosed=true` → `cancelSignal` reject → `runVoiceTranscribe` throw → catch 调 `send(500,...)` → **`send` 检查 `res.destroyed=true` → 静默返回** → daemon 存活 → `voiceLock` 正常释放(withVoice 的 run 完成) → 后续请求正常。

### 并发
- `send` 守卫不影响并发(每个 HTTP 请求有自己的 `res`)。
- voiceLock 在 `runVoiceTranscribe` throw 后由 `withVoice` 的 `.catch(()=>{})` 释放。

### 退出/清理
- `cancelSignal.stop()` 在 `finally` 中调用(已就位)。
- `runtime.endVoiceFallback()` 在 `finally` 中调用(已就位)。
- `invalidateVoicePage` 关闭坏页面(已就位)。

### 安全边界
- `send` 守卫不引入新的文件/路径访问。
- 不影响 `send` 的正常回复逻辑。
- 无新 env var / config / 公共 API。

---

## 5. 行为级测试计划

### 先写的测试

**testVoiceCancelSendSafeOnClosedRes**:
1. 启动模拟 daemon 的 HTTP server(用与 chatgpt-core.js 相同的 `send` 逻辑)
2. 发起 `/voice/transcribe-file` 请求
3. 50ms 后 `req.destroy()`(模拟 TUI cancel)
4. 等 200ms 让 server 端处理 cancel
5. 发新请求 `/ping` 验证 server 仍存活
6. 断言:daemon(server)在 voice cancel 后不崩溃

### 当前缺口
- `send` 无 `res.destroyed` 守卫 → voice cancel 后 `writeHead` 抛异常 → daemon 崩溃

### 实现后验证
```bash
cd thirdparty/chatgpt-browser-agent
npm run test:syntax
node test-mcp.js testVoiceCancelSendSafeOnClosedRes
node test-mcp.js   # 全量非 E2E
```

---

## 6. 预估 git 体量

2 文件(chatgpt-core.js + test-mcp.js),净增 ~36 行,0 改,0 删除。无新文件/迁移/文档。

---

## 7. 真实风险与开放问题

### 已确认风险(有缓解)
- **无**:修复是 1 行守卫,与 `/ask` 的 `reply` 完全一致,零回归。

### 不构成风险(已排除)
- `send` 正常路径:守卫条件 `res.destroyed || res.writableEnded` 在正常路径下为 false,不影响回复。
- `send` 被 /stop 共用:/stop 先 `send(200,{ok:true})` 再 `shutdownOnce` → `process.exit(0)`;send 守卫不影响(此时 res 未关闭)。
- `send` 被 /status 共用:/status 是只读请求,客户端不会在回复前断开。

### 需用户决策:无。

---

## 8. 推荐方案摘要

**2 文件,净增 ~36 行,0 改,0 删除。**

| 问题 | 修复 | 文件 |
| --- | --- | --- |
| voice cancel → daemon 崩溃 | `send` 加 `if (res.destroyed \|\| res.writableEnded) return;`(与 /ask 的 reply 守卫一致) | chatgpt-core.js +1 |
| 测试 | `testVoiceCancelSendSafeOnClosedRes`:模拟 TUI cancel,验证 daemon 存活 | test-mcp.js +35 |

**核心安全属性:**
- voice cancel 后 `send` 静默返回,daemon 不崩溃。
- voiceLock 正常释放(withVoice 的 run 完成)。
- 后续 voice/ask 请求不阻塞。
- 零回归(守卫条件在正常路径下为 false)。
