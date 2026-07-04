#!/usr/bin/env node
'use strict';
// 定向鲁棒性测试：验证 voice 转写在各种异常场景下能自恢复。
// 每个测试显示耗时，便于区分"正常完成"和"超时后假成功"。
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPT_DIR = __dirname;
const VOICE_ROOT = path.join(os.tmpdir(), 'opencode', 'voice');
const TEST_WAV = path.join(VOICE_ROOT, 'test-hello.wav');

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

function stopDaemon() {
  spawnSync('node', [path.join(SCRIPT_DIR, 'chatgpt.js'), '--stop'], { encoding: 'utf8', timeout: 15_000, cwd: SCRIPT_DIR });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  fs.mkdirSync(VOICE_ROOT, { recursive: true });
  // 确保测试 WAV 存在
  const srcWav = path.join(SCRIPT_DIR, 'test-voice-hello.wav');
  if (fs.existsSync(srcWav) && !fs.existsSync(TEST_WAV)) fs.copyFileSync(srcWav, TEST_WAV);
  if (!fs.existsSync(TEST_WAV)) { console.log('SKIP: no test WAV available'); return; }

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
