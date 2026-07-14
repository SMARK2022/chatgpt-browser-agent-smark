# Voice 逻辑理顺与效率增强方案

> 状态：已完成。方案审计第 3 轮和实现独立复核第 2 轮均 PASS；TDD、39 项离线测试、21 项 TUI voice 测试、typecheck 与真实 Edge E2E 已通过。
>
> 最终功能实现的 `git diff --numstat` additions + deletions 总和为 400 行，未超过硬上限；仅修改既定的 3 个生产/测试文件。

---

## 0. 推荐方案摘要

本次仅修改 `chatgpt-core.js`、`chatgpt-dom.js` 和 `test-mcp.js`，不新增依赖、配置、公共 API、daemon endpoint或并行 voice：

1. Project resolution 只把 exact-ID pin 提前到 15 秒 sidebar recovery 前；最终验证/自恢复仍只有现有 `ensureProjectHome()` 一套。
2. voice 与 ask 使用同一 request-context 接口但各自独立实例；voice 的 60 秒 absolute deadline覆盖queue，queued cancel在任何WAV I/O或页面分配前退出，ask不继承voice期限。
3. direct 可借用 runtime 管理的 idle session 页；页面侧 AbortController、session reservation和voice lock覆盖真实 fetch 生命周期。
4. endpoint/transport/page/cancel分类只在 Node DOM adapter边界生成，不依赖自定义字段跨 CDP 保留。
5. 保留现有 auth health/fresh-page自愈；deadline覆盖queue、newPage、goto、health、direct/fallback和late completion。
6. fallback、submit、运行期Project/focus、pulse和artifact通过一个非重入foreground queue串行；queue内部tail保持顺序，调用方可在取消时及时脱离，late entry轮到后只执行gate。
7. daemon-owned Edge的三处close统一有界；shared/spawn+connect始终只disconnect。

方案直接处理三类已确认主问题：正常profile cold start白等约15秒、已有idle ask页仍创建voice tab、TUI取消后旧页面任务可能继续并阻塞后续voice。同时完整覆盖用户明确要求的fallback前台互斥，不采用“跳过focus后继续DOM”的降级方案。

---

## 1. 调研范围与证据

### 1.1 已阅读的生产代码

| 文件 | 相关职责 |
| --- | --- |
| `chatgpt-core.js` | timeout/cancel、browser ownership、Project cache/resolve/ensure、voice input、runtime page/locks、voice state、ask submit/recovery、stale cleanup、HTTP handlers和三处owned close |
| `chatgpt-dom.js` | submit/upload/send、Project sidebar、direct fetch、fake mic/fallback、waitForComposer、pulse、artifact和全部7处实际bringToFront |
| `chatgpt-project.js` | Project origin、URL/ID、同名歧义和conversation identity |
| `chatgpt.js` | daemon startup、transcribe-file和结构化retry |
| `prompt-voice-input.ts` | TUI 90秒期限、AbortSignal、CLI终止和WAV删除 |

### 1.2 已阅读的测试与文档

| 文件 | 覆盖与缺口 |
| --- | --- |
| `test-mcp.js` | 已有Project state machine、session locks、voice health、direct fast path、cancel-before-fallback、fallback callback、pulse、closed response和stale daemon；缺少pin顺序、queued cancel零副作用、borrowed abort/settlement、全链deadline、完整foreground和owned close timeout |
| `prompt-voice-input.test.ts` | 21个TUI voice状态、cancel、cleanup和late completion测试；TUI无需修改 |
| `docs/voice-cancel-fix-plan.md` | response-close守卫已落地，但不覆盖底层page task和locks |
| `README.md` | Project cache、Edge/profile、shared connect和daemon ownership契约 |

### 1.3 搜索确认的当前链路

| 链路 | 当前行为 |
| --- | --- |
| cold startup | root → discovery none → sidebar 15s → cache → ensure → ready |
| queued voice | `withVoice()`前realpath/stat/open/read WAV header |
| direct | 无条件dedicated；health auth后direct再次auth |
| cancel | 外层race返回，底层evaluate不响应client cancel，invalidate不await |
| foreground | fallback外还有focus、submit、Project、waitForComposer、pulse、artifact可bringToFront；只有pulse有skip |
| close | login timeout、startup catch、runtime shutdown三处owned close无统一上限 |

### 1.4 真实 Edge证据

| 时间点 | 结果 |
| --- | ---: |
| CDP connected | 1007 ms |
| root | 1045 ms |
| Project | 20892 ms |
| daemon ready | 21895 ms |
| CLI | 23888 ms |
| direct | 1258 ms |

日志反复显示15秒sidebar timeout；另有多次WAV删除后ENOENT、真实direct AbortError和cancel后后续voice成功。20-30秒主要不是转录接口耗时。

### 1.5 已确认的不确定点

| 原不确定点 | 结论 |
| --- | --- |
| cold慢在转录 | 否，主要是Project顺序 |
| direct需要composer | 否，只有fallback操作DOM |
| disconnected都由daemon主动close | 否，日志无法完整归因 |
| auth health只是重复网络 | 否，它还承担network-context退化自愈 |
| pulse skip覆盖全部前台冲突 | 否，其它6个实际入口没有fallback互斥 |
| browser context自定义error.code可靠 | 否，分类必须在Node adapter边界归一化 |

---

## 2. 第一性职责边界与不变量

| 层 | 必须负责 | 不应负责 |
| --- | --- | --- |
| HTTP handler | body、deadline、client close、昂贵工作前gate | 页面fetch取消细节 |
| runtime/core | voice/session/foreground locks、page lease、deadline、discard/fatal、ownership | selector与页面响应解析 |
| DOM adapter | 页面fetch/abort、fallback DOM、Node侧错误归一化 | session lock和HTTP response |
| Project resolution | candidate顺序、pin、唯一ensure/recovery | 第二套sidebar恢复 |
| lifecycle | shared disconnect、owned有界close | kill用户browser |
| TUI | 用户取消、CLI/WAV | daemon清理 |

必须保持：

1. daemon仅在Project identity验证后ready；同名名称解析fail closed。
2. direct不导航、不focus、不清composer，保留locale并原样返回文本。
3. UI fallback永远不在ask/session页执行。
4. voice全局串行；ask同session串行、跨session并发。
5. borrowed direct实际task隔离/settle前不释放voice/session locks。
6. auth health的同请求fresh-page自愈不降级。
7. foreground敏感动作不在fallback中间抢前台；等待后重新检查cancel/deadline/fatal。
8. shared connect不kill；只kill真正launch-owned process。
9. voice文件安全边界、closed response守卫和CLI安全retry范围不弱化。
10. fatal后尚未开始的upload/send不得产生新远端副作用。

---

## 3. 推荐的最小实现

### 3.1 Project pin：只重排candidate

`resolveProject()` 改为 `discover → cached candidate → existing sidebar recovery`，不调用`ensureProjectHome()`。启动层保持唯一一次ensure。第一次visit失败时，ensure在现有JSON lock内按解析后的project ID删除仍指向旧ID的id/token/name aliases，再执行现有一次sidebar self-recovery。

valid exact-ID pin是profile内稳定选择；无pin/stale pin重新按名称发现时同名仍fail closed。删除alias必须ID compare-and-delete，避免误删并发进程已更新的新记录。

### 3.2 每请求独立的request context

只定义一个内部factory和一个接口，不共享实例：

```js
makeRequestContext({ deadline, isClientClosed, runtime })
// → { deadline, shouldCancel(), assertUsable(), cancelled, stop() }
```

| 请求 | 独立参数 |
| --- | --- |
| voice | body完成后、进入voice queue前建立；deadline为当前时间+60秒 |
| ask | 在自身handler建立；不继承voice 60秒；保留原始`isClientClosed()`与runtime fatal，具体阶段由现有`beforeSend`/pending边界决定 |
| startup/internal | 不进入runtime foreground queue，不需要HTTP context |

voice `withVoice()` callback第一条业务检查必须通过自己的context，失败时不得调用validate/filesystem/page/DOM；通过后才运行现有完整`validateVoiceInput()`。ask的submit、运行期Project/focus和artifact始终收到所属ask context，不能读取全局“当前request”。

ask不能把`clientClosed`解释为整个生命周期都可取消：

- `beforeSend()`尚未执行：client close可以取消submit，不产生远端副作用。
- `beforeSend()`已执行或`promptMayHaveBeenSent`成立：client close只结束HTTP等待，不能取消`rememberCurrentSessionUrl()`与pending bookkeeping。
- runtime fatal始终可以阻止尚未开始的新远端副作用，但已发送prompt仍尽力完成本地lost→URL/pending转换。

同一voice请求内page preparation、direct/fallback和foreground复用自己的context。`cancelled`是一个只resolve取消原因、永不reject的notification Promise，因此即使请求正在等待voice/session lock或尚未进入任何race，也不会产生unhandled rejection。factory复用现有500ms轮询语义，并在请求finally统一`stop()`。ask的client-close notification保留原始原因，由高层owner结合`promptMayHaveBeenSent`判断，不允许通用foreground helper把send后的结果直接改写为取消。

### 3.3 Idle session lease

runtime只从`sessionPages`选择未关闭、官方origin、无active/queued lock、无fresh pending的页。选择与写入reservation同步完成，不扫描任意`browser.pages()`。

lease：

- `release()`仅在directPromise真实settle后解除reservation。
- `discard()`只在page引用仍匹配时`sessionPages.delete(sessionID)`并有界关闭runtime页；不删除持久session URL/pending元数据。

无eligible页使用dedicated页；borrowed页只执行direct mode，fallback始终dedicated。

### 3.4 Node侧唯一错误归一化

浏览器evaluate不抛带自定义code的Error。可控结果返回结构化数据：

```js
{ ok: true, text, elapsedMs }
{ ok: false, kind: "endpoint" | "transport" | "cancelled" | "origin", status?, message }
```

`transcribeAudioFileDirect()`的Node wrapper把结构化结果和Puppeteer catch统一映射为内部Node Error code：

| Node code | 来源 | lease | 后续 |
| --- | --- | --- | --- |
| `VOICE_ENDPOINT` | HTTP/token/schema/invalid response | release | dedicated fallback |
| `VOICE_CANCELLED` | context取消或页面tombstone | abort成功settle则release | 不fallback |
| `VOICE_TRANSPORT` | fetch AbortError/network timeout | discard | 剩余deadline内dedicated处理 |
| `VOICE_PAGE` | origin/context/target/protocol错误 | discard | dedicated或browser错误 |
| `VOICE_RUNTIME_FATAL` | abort/close/task均不收敛 | 隔离 | shutdown |

client cancel优先于同时到达的transport结果。core只switch这些Node-side codes，不再依赖跨CDP字段或含义模糊的message正则。

### 3.5 页面abort与统一voice-task cleanup

现有`transcribeAudioFile()`增加内部`mode: auto|direct|fallback`和requestID，默认auto兼容旧调用。页面全局使用独特key保存 `{requestID, controller, cancelled}`；cancel先到时创建tombstone，每次controller建立后先检查。finally按requestID compare-and-delete。

单一`cleanupVoiceTask({ operationPromise, foregroundHandle, page, lease, requestID, mode })`覆盖全部页面路径，不再保留专属borrowed helper。`operationPromise`只表示已经开始的真实页面任务；`foregroundHandle`用于判断排队entry是否已经开始：

| mode | 首个取消动作 | 页面隔离 |
| --- | --- | --- |
| borrowed direct | bounded `cancelDirectVoice` RPC | 未settle或abort未确认时`lease.discard()` |
| dedicated direct | bounded `cancelDirectVoice` RPC | 从voice registry移除并bounded close |
| dedicated fallback | 不需要direct abort | 从voice registry移除并bounded close |
| foreground尚未开始 | 只标记context cancel | 不等待internal；late entry轮到后gate，不启动DOM |

统一顺序：

```text
启动可用的abort RPC并立即挂late rejection handler
→ abort RPC最多短grace；pending也继续
→ 已开始的operationPromise/internal最多短grace
→ 仍未settle：按mode discard/retire并bounded close
→ 再等待已开始任务短grace
→ 已开始任务/close仍不收敛：runtime.fail(VOICE_RUNTIME_FATAL)
→ settle或隔离完成后才允许voice/session locks结束
```

若foreground entry尚未开始，context取消后不会创建operationPromise，cleanup只退役已分配的dedicated页并及时返回；late internal已有rejection observer并在gate处no-op。endpoint/transport/page错误本身已settle，不走取消helper，按唯一矩阵release/discard。现有`invalidateVoicePage()`的fire-and-forget逻辑由统一retire/cleanup替换，不能与新helper并存。helper复用`withTimeout()`，不新增timer框架。

### 3.6 Auth health与absolute deadline

保留现有`/api/auth/session` health和最多两次fresh-page尝试。absolute deadline覆盖voice queue、allocation queue、newPage、aged/degraded close、goto、health、direct/fallback和late completion。

每个await前读取remaining；deadline耗尽不创建page/retry/fallback，不使用延长deadline的最小下限。无法取消的late newPage完成后关闭且不登记，并在finally释放自己的allocation queue slot。

### 3.7 最小非重入foreground queue

runtime复用现有promise-chain风格增加`withForeground(task, context)`，返回单一handle：

```js
{ internal, hasStarted() }
```

- `internal`永远进入queue tail；轮到后先`context.assertUsable()`，通过后才同步标记started并调用task。它创建时立即挂rejection observer，tail保存`internal.catch(() => {})`。
- `hasStarted()`只读取闭包boolean；不提供删除queue节点、重排或通用调度API。

高层owner始终直接race `handle.internal` 与所属request context的resolve型`cancelled` notification；cancel outcome不能因entry已经started而被改写成等待internal：

| cancel到达时状态 | owner必须执行 |
| --- | --- |
| 尚未started | 立即返回`VOICE_CANCELLED`；已分配dedicated页可立即退役；late internal轮到后在assert处no-op/reject |
| 已started voice fallback | 立即调用`cleanupVoiceTask({ operationPromise: handle.internal, ... })`关闭/隔离页面，并等待internal真实settle；完成后才抛`VOICE_CANCELLED` |
| 已started ask submit，尚未`beforeSend` | 保持session lock，等待internal通过现有cancel gates退出；之后返回取消 |
| 已started ask submit，已经`beforeSend` | 不把client close改写为取消；等待internal并继续`rememberCurrentSessionUrl()`及pending bookkeeping |
| ask Project/focus/artifact | send前可按client close取消；send后的generating断连不再启动focus/artifact，直接进入pending持久化 |

因此取消通知与真实task生命周期是两个同时必须处理的信号：notification负责立即触发owner的阶段决策/cleanup，internal负责证明页面任务已经结束。任何voice路径都不能只等待internal而不启动cleanup，也不能只返回cancel而提前释放locks；任何ask路径都不能在远端send已经开始后跳过URL/pending恢复边界。

不在DOM内部构建通用调度器；core只在现有高层调用seam包装：

| 高层动作 | 包装位置与范围 |
| --- | --- |
| fallback | core调用`mode:fallback`时包整个dictation/composer流程 |
| submit | `submitAsk()`包现有`CHATGPT_DOM.submit()` |
| focus/runtime Project recovery | core现有调用点包整个前台敏感调用；startup阶段server未ready，无需queue |
| pulse | runtime传`runForeground`给现有wait选项，包skip/bring/scroll |
| artifact | core传runner给collect选项，仅包bring/scroll/click，不包下载等待 |

高层只入队一次；内部`waitForComposer()`继续raw bring，不自行取lease，因此无递归死锁。direct不入队。若fallback在等待foreground时取消，handle尚未started，dedicated页立即退役且owner及时返回；若fallback已经started，cancel notification立即驱动owner关闭页面并把handle.internal交给统一cleanup，voice lock不能提前释放。

ask response wait保留现有“pulse之后读取assistantState，再按submitted判断client close”的顺序，但post-send client close必须加入pulse的现有skip predicate：client已断开时pulse不进入foreground queue、不bringToFront、不scroll，随后wait loop继续读取state并返回`generating/client-disconnected`。runtime fatal不进入该skip，仍由context/foreground gate抛出。

这替换`voiceFallbackActive`作为正确性锁的职责。flag可保留为pulse快速skip/日志，但不作为互斥边界，也不增加第二套skip后继续DOM的机制。

### 3.8 Runtime fatal与ask durability边界

仅当abort、settlement和runtime page close都无法收敛时设置最小fatalError。voice/ask业务callback与page/foreground入口使用各自request context的`assertUsable()`；active ask自己的shouldCancel合并runtime fatal，并在`input.uploadFile()`前和`beforeSend`再次gate。

fatal前完成的upload/send不回滚，继续依赖pending/lost；fatal后尚未开始的动作必须阻止。handler尝试响应后`setImmediate()`进入shutdown；queued/new任务零副作用失败。

ask client-close沿用当前代码已经建立的阶段边界，不新增状态机：

1. `beforeSend()`前断连：取消submit，清理尚未提交的附件。
2. `beforeSend()`同步写lost后，无论client是否断开，都等待可信click结果并继续`rememberCurrentSessionUrl()`；URL记录完成前session lock不释放。
3. `waitForResponse()`在已提交且client断开时返回现有`generating/client-disconnected`。
4. response pulse在post-send client close时先skip前台动作，再让wait loop读取submitted state并返回上述状态。
5. `finishAsk()`识别该状态后不再执行需要前台的focus或artifact；直接调用现有无artifact持久化分支，至少写pending并保留已验证conversation URL。
6. wait catch收到明确client-close code时也直接进入pending分支，不执行cancel-gated focus，作为异常收敛边界。
7. 已有安全文本快照时仍可保存；没有文本也必须写pending。下一次同session先恢复，不得直接提交新prompt。

这条链替换“client close后通用foreground cancel”的错误做法，复用现有lost→URL→pending防重发契约。

### 3.9 所有owned-browser close统一有界

调用close前捕获launch-owned process handle。统一helper最多5秒graceful close；失败/超时只kill该owned process。shared WS/CDP及spawn+connect按README视为shared，只disconnect。

helper用于登录等待超时、startup catch、runtime shutdown。所有分支最终到达process exit/flush；daemon索引仍先清理。

### 3.10 Timeout层级

不修改`chatgpt.js`。daemon业务deadline保持60秒；现有CLI 120秒和TUI 90秒继续作为外层保护，避免本次扩展CLI行为。有效pin预期减少约15秒，但不承诺固定启动时长。

---

## 4. 文件与预算

| 文件 | 修改 | additions + deletions上限 |
| --- | --- | ---: |
| `chatgpt-core.js` | Project/cache；阶段感知的每请求context；lease；统一voice-task cleanup；deadline；foreground owner协议；ask lost/URL/pending；fatal；owned close | 175 |
| `chatgpt-dom.js` | mode；结构化direct结果/Node normalization；AbortController/tombstone；post-send pulse skip；artifact runner option；upload gate | 47 |
| `test-mcp.js` | 五组聚合行为测试，共用event spy、fake pages与barriers | 168 |
| **合计** | 仅3文件，预留10行 | **390** |

预算收敛依据：Project无第二次ensure；一个resolve型context factory且每请求独立；一个cleanup helper覆盖borrowed/dedicated/fallback；一个Node classifier；foreground handle只含internal/started，不实现可删除节点；ask复用现有beforeSend/lost/URL/pending；post-send client close复用pulse现有skip predicate和pending分支，不新增状态机；一个owned-close helper；测试共用同一事件spy和barrier。实现前按seam重新估算，先红后立即检查numstat；不可达时停止重审，不能删安全断言。

---

## 5. 行为级TDD计划

### 5.1 `testProjectPinUsesSingleRecoveryChain`

valid pin跳过前置sidebar且只ensure一次；stale pin最多一次self-recovery并按ID清理aliases；live ambiguity仍fail closed；no pin保持现有行为。

### 5.2 `testQueuedVoiceCancelHasZeroSideEffects`

第一voice占锁，第二context创建但尚未进入任何race，随后client close并删WAV；断言resolve型cancel notification不触发unhandled rejection。释放第一后第二不调用validate/filesystem/page/DOM；第三voice成功。另覆盖ask等待session lock时client close，daemon继续可用。

### 5.3 `testVoiceTaskLifecycle`

同一表驱动场景覆盖borrowed success、endpoint release+fallback、transport/page discard、client cancel、abort RPC永久pending、direct/close仍pending→fatal，以及无session页的dedicated direct cancel和dedicated fallback cancel。断言真实settle/隔离前同session ask和下一voice不能进入旧页；dedicated close后也必须等待task收敛；用真实browser page.evaluate失败证明code由Node adapter生成而非CDP保留。

### 5.4 `testVoiceDeadlineAndForeground`

barrier暂停allocation/newPage/goto/health/direct，断言一个deadline、late page关闭、queue slot释放、过期无retry。fallback持有foreground时并发submit、runtime Project/focus、pulse和artifact，断言事件不交错、内部waitForComposer不递归。分别在entry未started和已started后取消：前者owner及时返回且late internal零副作用；后者cancel notification必须先触发owner的page cleanup，且只有page close使真实fallback task settle后才释放foreground/voice lock；后续queue继续推进。direct不排队。

### 5.5 `testFatalAndOwnedCloseBoundaries`

用独立voice/ask contexts断言voice 60秒deadline不污染长ask；fatal后queued/new零副作用，active ask在uploadFile/beforeSend前停止。追加两条真实durability链：`beforeSend()`/可信click后client close仍记录conversation URL、清除lost并写pending；生成期间client close跳过focus/artifact但完成pending落盘，下一次同session走recovery且不调用submit。后者必须使用生产pulse顺序，分别覆盖进入wait前已断连和8秒pulse到期前断连：pulse先skip foreground，wait仍读取submitted state并返回client-disconnected；明确client-close catch也直接写pending。两条链都断言bookkeeping完成前session lock不释放。表驱动三处owned close；close永久pending时kill自有process并退出；shared/spawn+connect只disconnect。

### 5.6 既有回归

保持默认离线suite和21个TUI voice测试通过，重点是voice health、direct fast path、origin guard、cancel-before-fallback、fallback callback、8秒pulse、closed response、stale daemon、Project identity和session并发。测试只断言行为、顺序和副作用。

---

## 6. 正常、错误、并发、退出与安全路径

| 场景 | 处理 |
| --- | --- |
| valid pin | 唯一ensure验证，跳过前置15秒sidebar |
| stale/no pin | 唯一recovery链，同名fail closed |
| idle session | direct lease，task settle后归还 |
| busy/pending session | dedicated页 |
| queued cancel/deadline | 零文件/页面副作用 |
| borrowed cancel | abort RPC有界；不settle则discard；仍失败fatal |
| dedicated direct cancel | abort RPC有界；退役/close页面并等待task；仍失败fatal |
| dedicated fallback cancel | 退役/close页面并等待fallback task；尚未取得foreground时owner及时脱离、late entry inert |
| ask在send前断连 | 取消submit，不产生远端prompt |
| ask在可信click后断连 | 继续记录conversation URL并写pending，bookkeeping完成前保持session lock |
| ask生成期断连 | 不再focus/收artifact，直接写pending；下次同session先recovery而非submit |
| endpoint错误 | release健康页，dedicated fallback |
| transport/page错误 | discard坏页，剩余deadline内dedicated处理 |
| fallback前台竞争 | foreground queue串行全部实际入口 |
| deadline耗尽 | 不创建/retry/fallback，进入cleanup |
| runtime fatal | 阻止后续远端副作用并shutdown |
| owned close卡死 | 5秒后只kill自有process |
| shared/external browser | 只disconnect，不kill |

安全边界不新增endpoint、权限或持久敏感数据。页面requestID/tombstone不含token/path/audio；日志不输出access token、audio、daemon bearer或完整session payload。

---

## 7. 验证命令与最终E2E

```sh
cd thirdparty/chatgpt-browser-agent
node --check chatgpt-core.js
node --check chatgpt-dom.js
TMPDIR=/private/tmp node test-mcp.js testProjectPinUsesSingleRecoveryChain testQueuedVoiceCancelHasZeroSideEffects testVoiceTaskLifecycle testVoiceDeadlineAndForeground testFatalAndOwnedCloseBoundaries
TMPDIR=/private/tmp npm test

cd packages/opencode
bun test test/cli/tui/prompt-voice-input.test.ts
bun typecheck
```

先红后绿。最终只做一次Edge+原browser-agent profile E2E：cold direct；idle ask页direct；第一voice占锁时取消第二后第三成功；受控fallback与submit/pulse竞争；finally正常`/stop`。记录耗时、managed tabs、daemon和日志，不宣称根治外部关闭。

---

## 8. 风险与开放问题

### 8.1 已接受风险

1. 首次无pin/stale pin仍可能sidebar recovery。
2. 私有transcription endpoint仍可能变化；health与UI fallback保留。
3. 外部/用户/系统关闭Edge仍disconnect。
4. 无idle session仍创建dedicated页。
5. 极端CDP无法abort/close时有界关闭agent daemon/owned browser。
6. exact-ID pin是profile级稳定选择，不是account identity。

### 8.2 开放问题

用户已明确授权采用第6轮推荐修正并重新进入审计阶段。started foreground cancel现在规定为：cancel notification立即通知voice owner启动统一cleanup；owner关闭/隔离页面并等待handle.internal真实settle；settle或隔离前不释放voice/session lock。尚未started的entry仍由owner及时返回，late internal只执行gate。

该修改替换原有“started后采用internal但不通知owner”的错误语义，没有新增第二套锁或状态机。当前没有遗留的用户决策问题，但方案必须通过新的完整范围subagent审计后才能放行。

---

## 9. 拒绝的替代方案

| 方案 | 原因 |
| --- | --- |
| Project内第二次ensure | 重复验证/recovery |
| cancel只挂catch | 底层任务继续、locks提前释放 |
| 无界await abort RPC | 取消自身可挂死 |
| 浏览器自定义Error code直传 | CDP不保证保留 |
| endpoint/transport混类 | 可能归还坏页 |
| 移除auth health | 降低现有自愈 |
| fallback时skip focus继续submit | 功能降级 |
| DOM每层各自入foreground queue | 递归死锁和臃肿 |
| UI fallback复用ask页 | 清composer/fake mic污染 |
| 扫描任意browser.pages | 用户tab风险 |
| kill connect-mode browser | 误杀用户Edge |
| 并行voice/新配置/Browser-use重写 | 超出真实需求 |

---

## 10. 独立审计记录

### 聚焦方案第1轮：FAIL

borrowed direct缺cancel/rejection处理，双路径timeout超预算。

### 聚焦方案第2轮：PASS，后被第一性复审推翻

未发现底层fetch未abort、queued cancel仍访问WAV、auth自愈降级、deadline遗漏page prepare、Project recovery重复和owned close遗漏。

### 第一性复审第1轮：FAIL

确认上述结构问题，方案从职责入口重建。

### 第一性复审第2轮：FAIL

abort RPC自身可能pending、错误分类矛盾、396行无余量；方案增加bounded abort与唯一矩阵并重算预算。

### 第一性复审第3轮：FAIL

确认不能删除用户明确要求的完整foreground互斥；浏览器Error code不能依赖CDP；加入foreground后预算超限。本文改为core高层seam包runner、Node adapter归一化，并删除CLI改动，预算重算为355行。

### 第一性复审第4轮：FAIL

确认统一cleanup此前只描述borrowed direct，未覆盖dedicated direct/fallback；voice context不能供独立ask共享；foreground排队取消缺少caller及时脱离和late inert entry语义。本文已改为每请求独立context、一个cleanup覆盖三种voice mode、foreground internal tail与caller race分离；预算重算为370行。

### 第一性复审第5轮：FAIL

确认裸rejecting cancelPromise可能在无race阶段触发unhandled rejection；foreground task已经started后caller仍可能先结束并释放locks；cleanup参数未区分caller与真实internal operation。本文已改为resolve型cancel notification、started-aware foreground handle，并让统一cleanup只等待已开始的operation/internal；预算重算为380行。

### 第一性复审第6轮：FAIL

终审确认其余主要边界均成立，但started foreground cancel不会触发owner的page cleanup：caller等待internal不向owner产生取消异常，而现有fallback开始后没有`shouldCancel()`检查，所以它会持续到完成或内部timeout。推荐改为“立即通知owner cleanup，但internal真实settle/页面隔离前不释放locks”。这是本流程最后一轮，问题已转入上方开放问题，方案保持未放行。

### 用户授权修正后的完整复审第1轮：FAIL

started fallback取消链已闭环，但审计确认通用ask client-close会破坏现有durability：可信click后若把submit结果改写为取消，会跳过`rememberCurrentSessionUrl()`并留下lost；生成期断连若在foreground focus前退出，会跳过pending落盘并允许下次重复submit。本文已改为阶段感知语义：send前可取消，send后必须完成lost→URL→pending；generating断连跳过focus/artifact但直接持久化pending。

### 用户授权修正后的完整复审第2轮：FAIL

ask send后lost→URL→pending语义已补齐，但现有`waitForResponse()`先执行pulse再检查client-close/submitted；通用foreground gate会在第一次或下一次8秒pulse处抛取消，导致pending分支仍不可达。本文已规定post-send client close先通过pulse现有skip predicate跳过foreground，再让wait读取submitted state并返回generating；明确client-close catch也直接写pending。

### 用户授权修正后的完整复审第3轮：PASS

结果：PASS（无阻塞意见）。subagent从头复核完整方案、生产代码、测试与本地日志，确认Project pin/唯一ensure、queued cancel零副作用、borrowed与dedicated cleanup、Node侧错误归一化、absolute deadline、完整foreground、active fallback cancel、ask lost→URL→pending durability、pulse client-close顺序、shared/owned browser边界和390行预算均闭环；未发现功能、安全、兼容、并发、取消、退出或清理降级。方案正式放行，等待用户授权实施。
