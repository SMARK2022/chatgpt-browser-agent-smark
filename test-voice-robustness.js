#!/usr/bin/env node
'use strict';
// 定向鲁棒性测试：验证 voice 转写在各种异常场景下能自恢复。
// 每个测试显示耗时，便于区分"正常完成"和"超时后假成功"。
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');

const SCRIPT_DIR = __dirname;
const VOICE_ROOT = path.join(os.tmpdir(), 'opencode', 'voice');
const TEST_WAV = path.join(VOICE_ROOT, 'test-hello.wav');

// 单次调用必须经过真实CLI/daemon，而不是直接调用DOM helper；否则无法观察启动和进程退出问题。
// 130秒只包住测试子进程，产品voice仍由自己的绝对deadline决定，测试不能替它制造成功。
// stdout必须包含结构化text才算通过，退出码0但空转录仍属于用户可见失败。
function transcribe(label) {
  const t0 = Date.now();
  const result = spawnSync('node', [path.join(SCRIPT_DIR, 'chatgpt.js'), 'transcribe-file', '--file', TEST_WAV, '--json'], {
    encoding: 'utf8',
    timeout: 130_000,
    cwd: SCRIPT_DIR,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const ok = result.status === 0 && stdout.includes('"text"');
  console.log(`  [${elapsed}s] ${label}: ${ok ? 'PASS' : 'FAIL'} ${ok ? stdout : stderr.slice(0, 120)}`);
  return { ok, elapsed: parseFloat(elapsed), stdout, stderr };
}

// 每个独立场景从明确daemon边界开始，避免前一场景的页面、锁或计数污染本轮结果。
// stop使用公开CLI而非删除daemon.json；只有生产shutdown才能证明browser/profile得到正常收敛。
// 15秒上限保护测试进程，不能用无限等待掩盖daemon退出卡死。
function stopDaemon() {
  spawnSync('node', [path.join(SCRIPT_DIR, 'chatgpt.js'), '--stop'], { encoding: 'utf8', timeout: 15_000, cwd: SCRIPT_DIR });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 压力参数保留命令行可调性，但非法值必须在启动浏览器前失败，避免无意义远端请求。
// 省略参数沿用固定验收矩阵，保证本地和审计命令比较的是同一负载。
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} requires a non-negative number`);
  return value;
}

// 并发场景不能使用spawnSync，否则voice和ask不会真正重叠，伪发送缺陷也无法复现。
// 子进程显式继承当前环境，确保所有producer命中同一隔离daemon和同一profile。
// 收集完整stdout/stderr后再判定，避免只凭进程关闭时机把partial输出当成功。
function runCLI(args, timeout = 130_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [path.join(SCRIPT_DIR, 'chatgpt.js'), ...args], {
      cwd: SCRIPT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${args.join(' ')}`)); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout: stdout.trim(), stderr: stderr.trim(), elapsedMs: Date.now() - startedAt });
    });
  });
}

// harness必须与agent使用同一state推导规则，否则status会读取另一份daemon token和PID。
// 项目内OPENCODE_DATA_DIR不能承载登录profile；该分支与生产的安全回退保持一致。
// 显式CHATGPT_STATE_DIR始终优先，供E2E在临时目录中隔离daemon索引。
function stateDir() {
  if (process.env.CHATGPT_STATE_DIR) return path.resolve(process.env.CHATGPT_STATE_DIR);
  const data = process.env.OPENCODE_DATA_DIR && !path.resolve(process.env.OPENCODE_DATA_DIR).startsWith(path.resolve(SCRIPT_DIR))
    ? process.env.OPENCODE_DATA_DIR
    : process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'opencode') : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
  return path.join(data, 'chatgpt-browser-agent', 'state');
}

// status走真实本地HTTP认证边界，不从daemon.json直接伪造运行时计数。
// bearer只用于请求头且不进入输出；错误响应必须保留为测试失败而不是空状态。
// 五秒socket上限只诊断失联daemon，不触发重启或任何远端副作用。
function daemonStatus() {
  const state = daemonState();
  return new Promise((resolve, reject) => {
    // bearer只在本地内存中进入Authorization；测试绝不打印或持久化token。
    const request = http.request({ host: '127.0.0.1', port: state.port, path: '/status', headers: { authorization: `Bearer ${state.token}` } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200) throw new Error(body.error || `status HTTP ${response.statusCode}`);
          resolve(body);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('daemon status timed out')));
    request.on('error', reject);
    request.end();
  });
}

function daemonState() {
  return JSON.parse(fs.readFileSync(path.join(stateDir(), 'daemon.json'), 'utf8'));
}

// browser-close只能作用于当前daemon的后代；同名Edge进程不足以证明所有权。
// helper也携带user-data-dir，因此必须排除--type=进程，只保留唯一浏览器主进程。
// 归属不唯一时测试fail-closed，绝不为通过用例而扩大到用户普通Edge。
function ownedBrowserProcess(daemonPID) {
  if (process.platform !== 'darwin') throw new Error('--browser-close currently requires macOS ps ownership evidence');
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr || result.stdout}`);
  const processes = result.stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
  });
  const descendants = new Set([daemonPID]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) if (descendants.has(item.parent) && !descendants.has(item.pid)) { descendants.add(item.pid); changed = true; }
  }
  const profile = path.resolve(process.env.CHATGPT_BROWSER_USER_DATA_DIR || path.join(stateDir(), 'profile'));
  const matches = processes.filter(item => descendants.has(item.pid)
    && item.command.includes(`--user-data-dir=${profile}`)
    && !item.command.includes(' --type=')
    && /Microsoft Edge|Chromium|Google Chrome/i.test(item.command));
  // 归属证据不唯一时绝不降级为进程名匹配，避免误关用户普通Edge。
  if (matches.length !== 1) throw new Error(`expected one owned browser descendant for ${profile}, found ${matches.length}`);
  return matches[0];
}

// ask只要求进程成功，voice还必须解析出非空text；两个结果契约不能混为一个退出码判断。
// 原始stderr优先进入错误，保留首次分歧而不是包装成泛化的负载失败。
function requireSuccess(result, label, field) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  if (field === 'voice') {
    const parsed = JSON.parse(result.stdout);
    if (!parsed.text?.trim()) throw new Error(`${label} returned empty text`);
  }
  return result;
}

// 负载矩阵复现真实producer顺序：voice并发，每个ask独立创建Session并共享同一browser runtime。
// harness不串行ask；短创建窗口由生产锁排序，回答等待继续并发，才能反复覆盖voice/new-ask重叠。
// 每轮都检查锁和页面收敛，避免“结果都返回但daemon已泄漏资源”的假通过。
// voiceSubmitted使用单调差值证明每个输入只有一次POST，不能靠返回文本推断无重发。
async function runLoad() {
  const rounds = option('--rounds', 3);
  const voices = option('--voice-per-round', 4);
  const askEvery = option('--ask-every', 2);
  const expectedVoice = option('--expect-voice', 12);
  const expectedAsk = option('--expect-ask', 6);
  const maxP95 = option('--max-p95-ms', 120_000);
  const maxVoicePages = option('--max-voice-pages', 1);
  const maxManagedPages = option('--max-managed-pages', expectedAsk + 1);
  stopDaemon();
  const logFile = path.join(stateDir(), 'daemon.log');
  const logOffset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const sessionIDs = new Set();
  const voiceResults = [];
  const askResults = [];
  let submittedStart = 0;
  for (let round = 0; round < rounds; round++) {
    const pending = [];
    for (let index = 0; index < voices; index++) {
      pending.push(runCLI(['transcribe-file', '--file', TEST_WAV, '--json']).then(result => {
        voiceResults.push(requireSuccess(result, `voice round=${round + 1} index=${index + 1}`, 'voice'));
      }));
      if ((index + 1) % askEvery === 0) {
        // 每次都创建独立Session且marker不同，completed replay和generic continuation都不能伪装远端提交。
        const prompt = `Reply exactly OK. Load request ${round + 1}-${index + 1}.`;
        const ask = runCLI(['--raw', prompt]).then(result => {
          requireSuccess(result, `ask round=${round + 1} index=${index + 1}`);
          const sessionID = result.stdout.match(/Session:\s*(#[a-f0-9]{10})/i)?.[1] || null;
          if (!sessionID) throw new Error(`ask round=${round + 1} index=${index + 1} did not return a Session handle`);
          if (sessionIDs.has(sessionID)) throw new Error(`load ask reused Session handle ${sessionID}`);
          sessionIDs.add(sessionID);
          askResults.push(result);
        });
        pending.push(ask);
      }
    }
    await Promise.all(pending);
    const status = await daemonStatus();
    if (process.env.CHATGPT_PROJECT && status.project !== process.env.CHATGPT_PROJECT) throw new Error(`load resolved Project ${status.project || 'none'}, expected ${process.env.CHATGPT_PROJECT}`);
    if (round === 0) submittedStart = status.voiceSubmitted - voiceResults.length;
    const observed = { active: status.voiceActive, queued: status.voiceQueued, locks: status.activeLocks, voicePages: status.voicePageCount, managedPages: status.managedPageCount };
    if (observed.active !== 0 || observed.queued !== 0 || observed.locks !== 0 || observed.voicePages > maxVoicePages || observed.managedPages > maxManagedPages) throw new Error(`round ${round + 1} resources did not converge: ${JSON.stringify(observed)}`);
  }
  if (voiceResults.length !== expectedVoice || askResults.length !== expectedAsk || sessionIDs.size !== expectedAsk) throw new Error(`unexpected result counts: voice=${voiceResults.length}/${expectedVoice} ask=${askResults.length}/${expectedAsk} sessions=${sessionIDs.size}/${expectedAsk}`);
  const ordered = voiceResults.map(result => result.elapsedMs).sort((a, b) => a - b);
  const p95 = ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
  if (p95 > maxP95) throw new Error(`voice p95 ${p95}ms exceeded ${maxP95}ms`);
  const status = await daemonStatus();
  if (status.voiceSubmitted - submittedStart !== expectedVoice) throw new Error(`voiceSubmitted delta=${status.voiceSubmitted - submittedStart}, expected=${expectedVoice}`);
  let acceptedAsk = 0;
  const acceptanceDeadline = Date.now() + 5_000;
  do {
    const current = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(logOffset) : '';
    // 该日志只在完整submitAsk取得可信conversation URL后写入，比CLI退出码更能排除本地replay假通过。
    acceptedAsk = (current.match(/Prompt sent, waiting for response\.\.\./g) || []).length;
    if (acceptedAsk >= expectedAsk) break;
    await sleep(100);
  } while (Date.now() < acceptanceDeadline);
  if (acceptedAsk !== expectedAsk) throw new Error(`remote ask acceptance count=${acceptedAsk}, expected=${expectedAsk}`);
  requireSuccess(await runCLI(['transcribe-file', '--file', TEST_WAV, '--json']), 'post-load voice', 'voice');
  console.log(`PASS load: voice=${voiceResults.length} ask=${askResults.length} sessions=${sessionIDs.size} accepted=${acceptedAsk} p95=${p95}ms submitted=${status.voiceSubmitted - submittedStart}`);
}

// 真实idle保留同一daemon和page，专门验证长间隔后的健康复用或预上传续租。
// 第二次调用必须在本次内部成功，不能要求用户先经历一次失败再触发恢复。
// 计数差值固定为一，防止age恢复悄悄重发同一个音频。
async function runIdle() {
  const gap = option('--gap-ms', 300_000);
  stopDaemon();
  requireSuccess(await runCLI(['transcribe-file', '--file', TEST_WAV, '--json']), 'idle first voice', 'voice');
  const before = await daemonStatus();
  await sleep(gap);
  requireSuccess(await runCLI(['transcribe-file', '--file', TEST_WAV, '--json']), 'idle second voice', 'voice');
  const after = await daemonStatus();
  if (after.voiceSubmitted - before.voiceSubmitted !== 1) throw new Error(`idle second voice submitted ${after.voiceSubmitted - before.voiceSubmitted} times`);
  if (after.voiceActive !== 0 || after.voiceQueued !== 0) throw new Error(`idle resources did not converge: ${JSON.stringify(after)}`);
  console.log(`PASS idle: gap=${gap}ms second call completed in one submission`);
}

// 该场景强制owned模式，shared CDP下杀浏览器会越过agent所有权边界。
// 只终止已证明属于旧daemon的Edge主进程，让生产disconnect handler自行清理索引。
// 下一次独立voice不得复用旧PID，并且只允许一次direct提交。
// finally只在恢复验证结束后停止替代daemon，不提前删除故障现场。
async function runBrowserClose() {
  if (process.env.CHATGPT_BROWSER_CDP_URL || process.env.CHATGPT_BROWSER_WS_ENDPOINT || Number(process.env.CHATGPT_BROWSER_DEBUG_PORT || 0) !== 0) {
    throw new Error('--browser-close requires owned launch mode with CDP/WS unset and debug port 0');
  }
  const gap = option('--gap-ms', 5_000);
  stopDaemon();
  await sleep(500);
  const index = path.join(stateDir(), 'daemon.json');
  if (fs.existsSync(index)) throw new Error('pre-existing daemon index remained after bounded --stop');
  try {
    requireSuccess(await runCLI(['transcribe-file', '--file', TEST_WAV, '--json']), 'browser-close first voice', 'voice');
    const before = await daemonStatus();
    const old = daemonState();
    if (before.voiceSubmitted !== 1) throw new Error(`first owned daemon submitted ${before.voiceSubmitted} voice requests`);
    const browser = ownedBrowserProcess(old.pid);
    process.kill(browser.pid, 'SIGTERM');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (!fs.existsSync(index)) break;
      const current = JSON.parse(fs.readFileSync(index, 'utf8'));
      if (current.pid !== old.pid) break;
      await sleep(250);
    }
    if (fs.existsSync(index) && JSON.parse(fs.readFileSync(index, 'utf8')).pid === old.pid) throw new Error('production disconnect lifecycle did not retire the old daemon index');
    // 关闭后不调用stop、不删state；等待模拟用户稍后再次Alt+V，恢复必须完全由下一独立调用拥有。
    await sleep(gap);
    requireSuccess(await runCLI(['transcribe-file', '--file', TEST_WAV, '--json']), 'browser-close recovered voice', 'voice');
    const after = await daemonStatus();
    const next = daemonState();
    if (next.pid === old.pid) throw new Error('later voice reused the disconnected daemon process');
    if (after.voiceSubmitted !== 1) throw new Error(`replacement daemon submitted ${after.voiceSubmitted} voice requests`);
    console.log(`PASS browser-close: oldDaemon=${old.pid} oldBrowser=${browser.pid} newDaemon=${next.pid}`);
  } finally {
    // 下一独立调用已成功后才清理测试daemon；shared browser在入口已被明确禁止。
    stopDaemon();
  }
}

// profile观察必须早于首次voice，才能把登录持久和endpoint结果拆成两个独立信号。
// daemon以独立进程启动，observer只通过DevTools marker做只读首屏检查。
function startOwnedDaemon() {
  const child = spawn(process.execPath, [path.join(SCRIPT_DIR, 'chatgpt.js'), '--daemon-internal'], {
    cwd: SCRIPT_DIR,
    env: process.env,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

// 高频轮询只服务首屏订阅dialog证据，不改变页面、不刷新也不点击任何控件。
// marker来自本agent profile，连接后仍只读取非敏感dialog和认证布尔值。
// daemon ready是观察窗口终点，避免后续voice网络错误被误记为启动问题。
// accessToken只在page.evaluate内转成布尔值，测试进程和artifact都拿不到凭据。
async function observeBootstrapDialogs() {
  const profile = path.resolve(process.env.CHATGPT_BROWSER_USER_DATA_DIR || path.join(stateDir(), 'profile'));
  const marker = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 45_000;
  let browser;
  while (Date.now() < deadline) {
    try {
      const [port, browserPath] = fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/);
      browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${browserPath}`, defaultViewport: null });
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!browser) throw new Error('owned Edge DevTools marker did not become connectable before bootstrap');
  const dialogs = new Set();
  const inspect = async page => {
    const texts = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')]
      .map(element => (element.innerText || element.textContent || '').trim())
      .filter(text => /无法加载订阅|Failed to fetch/i.test(text))).catch(() => []);
    for (const text of texts) dialogs.add(text);
  };
  const poll = setInterval(async () => {
    for (const page of await browser.pages().catch(() => [])) await inspect(page);
  }, 100);
  try {
    while (Date.now() < deadline && !fs.existsSync(path.join(stateDir(), 'daemon.json'))) await sleep(100);
    if (!fs.existsSync(path.join(stateDir(), 'daemon.json'))) throw new Error('daemon did not reach ready during bootstrap observation');
    // ready前的轮询覆盖root导航和React首屏；ready后只补一次尾部读取，避免把后续voice混入首屏结论。
    const pages = await browser.pages();
    for (const page of pages) await inspect(page);
    const page = pages.find(candidate => candidate.url().startsWith('https://chatgpt.com'));
    if (!page) throw new Error('daemon ready without a ChatGPT bootstrap page');
    const authenticated = await page.evaluate(() => {
      let bootstrap = null;
      try { bootstrap = JSON.parse(document.querySelector('#client-bootstrap')?.textContent || 'null'); }
      catch {}
      const hasLoginBtn = [...document.querySelectorAll('button, a')]
        .some(element => /\b(log in|sign in)\b|登录|登入/i.test((element.textContent || '').trim()));
      // observer只带回布尔验收事实；profile token不得进入测试进程输出或artifact。
      return bootstrap?.authStatus === 'logged_in'
        && typeof bootstrap?.session?.accessToken === 'string'
        && bootstrap.session.accessToken.length > 0
        && !!document.querySelector('#prompt-textarea')
        && !hasLoginBtn;
    });
    return { dialogs: [...dialogs], authenticated };
  } finally {
    clearInterval(poll);
    browser.disconnect();
  }
}

// 两次auth-only启动先证明正常关闭后profile仍可登录，再允许唯一一次short voice。
// 任一认证或订阅检查失败都保留当前现场，不能在finally关闭后把根因一起抹掉。
// 第二次daemon必须更换PID，防止“restart”实际复用了尚未退出的旧进程。
async function runProfileRestart() {
  if (process.env.CHATGPT_BROWSER_CDP_URL || process.env.CHATGPT_BROWSER_WS_ENDPOINT || Number(process.env.CHATGPT_BROWSER_DEBUG_PORT || 0) !== 0) {
    throw new Error('--profile-restart requires default owned mode with CDP/WS unset and debug port 0');
  }
  stopDaemon();
  await sleep(500);
  startOwnedDaemon();
  const firstObservation = await observeBootstrapDialogs();
  if (firstObservation.dialogs.length > 0) throw new Error(`owned bootstrap showed subscription failure: ${firstObservation.dialogs.join(' | ')}`);
  if (!firstObservation.authenticated) throw new Error('first owned bootstrap did not preserve the logged-in profile');
  const first = daemonState();
  const firstBrowser = ownedBrowserProcess(first.pid);

  // 登录持久性必须先独立通过；不能让首次voice的endpoint结果决定profile是否保存成功。
  stopDaemon();
  await sleep(1_000);
  startOwnedDaemon();
  const secondObservation = await observeBootstrapDialogs();
  if (secondObservation.dialogs.length > 0) throw new Error(`restarted owned bootstrap showed subscription failure: ${secondObservation.dialogs.join(' | ')}`);
  if (!secondObservation.authenticated) throw new Error('restarted owned bootstrap lost the logged-in profile');
  const second = daemonState();
  if (second.pid === first.pid) throw new Error('auth-only restart reused the stopped daemon');

  // 两次auth-only gate之后只提交一个short voice；失败时保留daemon/browser供检查，不在finally再次关闭。
  requireSuccess(await runCLI(['transcribe-file', '--file', TEST_WAV, '--json']), 'profile post-restart voice', 'voice');
  console.log(`PASS profile-restart: firstDaemon=${first.pid} firstBrowser=${firstBrowser.pid} secondDaemon=${second.pid}`);
  stopDaemon();
}

async function main() {
  fs.mkdirSync(VOICE_ROOT, { recursive: true });
  // 确保测试 WAV 存在
  const srcWav = path.join(SCRIPT_DIR, 'test-voice-hello.wav');
  if (fs.existsSync(srcWav) && !fs.existsSync(TEST_WAV)) fs.copyFileSync(srcWav, TEST_WAV);
  if (!fs.existsSync(TEST_WAV)) { console.log('SKIP: no test WAV available'); return; }

  if (process.argv.includes('--load')) return runLoad();
  if (process.argv.includes('--idle')) return runIdle();
  if (process.argv.includes('--browser-close')) return runBrowserClose();
  if (process.argv.includes('--profile-restart')) return runProfileRestart();

  console.log('=== 定向鲁棒性测试 ===\n');

  // 测试 1: 正常转写（冷启动 daemon）
  console.log('测试 1: 正常转写（冷启动）');
  const t1 = transcribe('normal cold start');
  if (!t1.ok) { console.log('  测试 1 失败，终止'); process.exit(1); }
  await sleep(3000);

  // 测试 2: 转写完成后杀 daemon，紧接着再转写
  console.log('\n测试 2: 转写后杀 daemon → 立即重试');
  stopDaemon();
  await sleep(2000);
  const t2 = transcribe('after daemon kill');
  if (!t2.ok) { console.log('  测试 2 失败，终止'); process.exit(1); }
  await sleep(3000);

  // 测试 3: 连续快速两次转写（验证不串行卡死）
  console.log('\n测试 3: 连续两次转写（间隔 2s）');
  const t3a = transcribe('quick #1');
  await sleep(2000);
  const t3b = transcribe('quick #2');
  if (!t3a.ok || !t3b.ok) { console.log('  测试 3 失败，终止'); process.exit(1); }
  await sleep(3000);

  // 测试 4: 端到端验证（最终确认）
  console.log('\n测试 4: 端到端验证');
  const t4 = transcribe('e2e final');
  if (!t4.ok) { console.log('  测试 4 失败'); process.exit(1); }

  console.log('\n=== 全部通过 ===');
  console.log(`耗时统计: T1=${t1.elapsed}s T2=${t2.elapsed}s T3a=${t3a.elapsed}s T3b=${t3b.elapsed}s T4=${t4.elapsed}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
