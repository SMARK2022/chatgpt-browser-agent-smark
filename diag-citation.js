#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const STATE_DIR = path.resolve(process.env.CHATGPT_STATE_DIR || `${process.env.LOCALAPPDATA}\\opencode\\chatgpt-browser-agent\\state`);
const PROFILE_DIR = path.join(STATE_DIR, 'profile');
const CHATGPT_URL = 'https://chatgpt.com';

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });

async function main() {
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'daemon.json'), 'utf8')).port}`,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  // 找一个在 chatgpt.com 上的页面
  let page = pages.find(p => /^https:\/\/chatgpt\.com/i.test(p.url()));
  if (!page) { console.log('No chatgpt.com page found'); return; }
  console.log('Page URL:', page.url());

  const diag = await page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    const last = msgs[msgs.length - 1];
    if (!last) return { error: 'no assistant message found' };

    // 搜索所有可能的 citation 元素
    const allTestIds = new Set();
    last.querySelectorAll('*').forEach(el => {
      const tid = el.getAttribute('data-testid');
      if (tid) allTestIds.add(tid);
    });

    // 找所有带 citation/cite 的元素
    const citationElements = [];
    last.querySelectorAll('[data-testid*="citation"], [data-testid*="cite"], cite, [class*="citation"], [class*="cite"]').forEach(el => {
      const link = el.querySelector('a[href]') || (el.tagName === 'A' ? el : null);
      citationElements.push({
        tag: el.tagName,
        testid: el.getAttribute('data-testid') || '',
        className: el.className?.toString()?.slice(0, 100) || '',
        text: (el.textContent || '').trim().slice(0, 60),
        href: link?.href || '',
        outerHTML: el.outerHTML.slice(0, 300),
      });
    });

    // 找所有 <a> 元素在 assistant 消息中
    const allLinks = [];
    last.querySelectorAll('a[href]').forEach(el => {
      allLinks.push({
        href: el.href,
        text: (el.textContent || '').trim().slice(0, 60),
        parentTag: el.parentElement?.tagName || '',
        parentTestid: el.parentElement?.getAttribute('data-testid') || '',
      });
    });

    // 找 conversation-turn 中的所有按钮
    const lastTurn = last.closest('[data-testid^="conversation-turn-"]') || last.parentElement;
    const turnButtons = [];
    lastTurn?.querySelectorAll('button').forEach(el => {
      turnButtons.push({
        ariaLabel: el.getAttribute('aria-label') || '',
        testid: el.getAttribute('data-testid') || '',
        text: (el.textContent || '').trim().slice(0, 40),
      });
    });

    return {
      allTestIds: [...allTestIds].sort(),
      citationCount: citationElements.length,
      citationElements: citationElements.slice(0, 10),
      linkCount: allLinks.length,
      links: allLinks.slice(0, 10),
      turnButtonCount: turnButtons.length,
      turnButtons: turnButtons.slice(0, 10),
      lastTextSnippet: (last.innerText || '').slice(0, 200),
    };
  });

  console.log(JSON.stringify(diag, null, 2));
  browser.disconnect();
}
