#!/usr/bin/env node
/**
 * 鲜知·冰箱大脑 —— 手机端体验检查 + 演示素材抓取
 *
 * 用法：
 *   node capture-demo.js --app=<fridge-app 目录> --out=<输出目录>
 *
 * 只读产品目录，不修改任何文件；浏览器使用独立临时 profile，
 * 不会影响线上站点或 M4 参与者的任何数据。
 * 依赖：本机 Chrome（自动探测 / CHROME_PATH 指定）+ Node 22（内置 WebSocket）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

/* ---------- 参数 ---------- */
function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const APP = path.resolve(arg('app', path.resolve(__dirname, '../fridge-app')));
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'xz-roadmap-check')));
const SHOTS = path.join(OUT, 'screens');
fs.mkdirSync(SHOTS, { recursive: true });

const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));
if (!CHROME) throw new Error('未找到 Chrome，请设置 CHROME_PATH');

const PORT = Number(arg('server-port', '0'));
const CDP_PORT = Number(arg('cdp-port', '9333'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 本地静态服务 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(APP, rel);
  if (!file.startsWith(APP) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

/* ---------- CDP 极简客户端 ---------- */
let ws, seq = 0;
const pending = new Map();
const events = [];
function cmd(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
  });
}
async function evaluate(expr) {
  const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function connect(url) {
  ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = e => reject(new Error('WebSocket failed: ' + (e.message || 'unknown')));
  });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method) events.push(m);
  };
}
function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, r => {
      let s = ''; r.on('data', d => s += d);
      r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('bad json: ' + s.slice(0, 100))); } });
    }).on('error', reject);
  });
}

/* ---------- 检查逻辑（注入页面执行） ---------- */
const CHECK_JS = `(() => {
  const vw = window.innerWidth;
  const overflow = document.documentElement.scrollWidth - vw;
  const offenders = [];
  document.querySelectorAll('main *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return;
    if (r.right > vw + 2 || r.left < -2) {
      let p = el.parentElement, scrollable = false;
      while (p && p !== document.body) {
        if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) { scrollable = true; break; }
        p = p.parentElement;
      }
      if (!scrollable) offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 46),
        right: Math.round(r.right)
      });
    }
  });
  const btns = [...document.querySelectorAll('button')].filter(b => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (r.height < 36 || r.width < 36);
  });
  return {
    overflow,
    offenders: offenders.slice(0, 6),
    offenderCount: offenders.length,
    smallTargets: btns.length,
    h1: (document.querySelector('h1') || {}).textContent?.trim() || '',
    visibleCards: document.querySelectorAll('.view.active .card').length
  };
})()`;

const VIEWS = ['home', 'fridge', 'plan', 'week', 'leftover', 'shop', 'nutrition', 'stats', 'settings'];

async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xz-roadmap-'));
  const chrome = cp.spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--window-size=430,932',
    'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });

  try {
    // 等 CDP 端口
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try { targets = await httpJson('http://127.0.0.1:' + CDP_PORT + '/json/list'); if (targets.length) break; } catch (e) {}
      await sleep(250);
    }
    if (!targets || !targets.length) throw new Error('Chrome DevTools 端口未就绪');
    const page = targets.find(t => t.type === 'page') || targets[0];
    await connect(page.webSocketDebuggerUrl);
    await cmd('Page.enable');
    await cmd('Runtime.enable');
    await cmd('Log.enable');
    await cmd('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true
    });
    await cmd('Page.navigate', { url: base + '/index.html' });
    for (let i = 0; i < 60; i++) {
      const ok = await evaluate(`document.readyState === 'complete' && !!document.querySelector('.nav-item')`).catch(() => false);
      if (ok) break;
      await sleep(250);
    }
    await sleep(700);
    // 独立演示 profile 内恢复示例数据，保证界面有内容
    await evaluate(`(() => { const b = document.querySelector('[data-action="reset-demo"]'); if (b) b.click(); return true; })()`);
    await sleep(500);

    const report = { generatedAt: new Date().toISOString(), app: APP, viewports: [] };

    // --- 主检查：390×844，逐视图截图 + 结构检查 ---
    const v390 = { width: 390, height: 844, views: [], screenshots: [] };
    for (const v of VIEWS) {
      await evaluate(`(() => {
        window.scrollTo(0, 0);
        const n = document.querySelector('.nav-item[data-view="${v}"]');
        if (n) n.click();
        return true;
      })()`);
      await sleep(420);
      const check = await evaluate(CHECK_JS);
      v390.views.push({ view: v, ...check });
      const shot = await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const f = path.join(SHOTS, String(v390.screenshots.length + 1).padStart(2, '0') + '-' + v + '.png');
      fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
      v390.screenshots.push(path.basename(f));
      console.log('[390]', v, 'overflow=' + check.overflow, 'offenders=' + check.offenderCount, 'smallTargets=' + check.smallTargets);
    }

    // 菜谱详情弹窗 + 临期面板特写
    await evaluate(`(() => { const n=document.querySelector('.nav-item[data-view="plan"]'); if(n)n.click(); return true; })()`);
    await sleep(350);
    await evaluate(`(() => { const b=document.querySelector('[data-action="open-recipe"]'); if(b)b.click(); return true; })()`);
    await sleep(450);
    const modalShot = await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(SHOTS, '10-recipe-modal.png'), Buffer.from(modalShot.data, 'base64'));
    v390.screenshots.push('10-recipe-modal.png');
    v390.views.push({ view: 'recipe-modal', ...(await evaluate(CHECK_JS)) });
    await evaluate(`(() => { const b=document.querySelector('[data-action="close-modal"]'); if(b)b.click(); return true; })()`);
    await sleep(250);

    // 设置页滚动到 M4 验证卡片（README / 演示用）
    await evaluate(`(() => {
      const n=document.querySelector('.nav-item[data-view="settings"]'); if(n)n.click();
      const box=document.querySelector('#m4Box'); const card=box && box.closest('.card');
      window.scrollTo(0, card ? card.getBoundingClientRect().top + window.scrollY - 70 : 0);
      return true;
    })()`);
    await sleep(420);
    const m4Shot = await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(SHOTS, '11-m4-card.png'), Buffer.from(m4Shot.data, 'base64'));
    v390.screenshots.push('11-m4-card.png');

    // --- 小屏对照：360×740 只跑结构检查 ---
    await cmd('Emulation.setDeviceMetricsOverride', {
      width: 360, height: 740, deviceScaleFactor: 1, mobile: true
    });
    const v360 = { width: 360, height: 740, views: [] };
    for (const v of VIEWS) {
      await evaluate(`(() => { window.scrollTo(0,0); const n=document.querySelector('.nav-item[data-view="${v}"]'); if(n)n.click(); return true; })()`);
      await sleep(300);
      v360.views.push({ view: v, ...(await evaluate(CHECK_JS)) });
    }
    report.viewports.push(v390, v360);

    // --- 控制台 / 页面异常 ---
    report.consoleErrors = events.filter(e =>
      (e.method === 'Runtime.exceptionThrown') ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    ).map(e => {
      if (e.method === 'Runtime.exceptionThrown') return String(e.params.exceptionDetails.text || '') + ' ' + String((e.params.exceptionDetails.exception || {}).description || '').slice(0, 160);
      if (e.method === 'Log.entryAdded') return String(e.params.entry.text || '').slice(0, 200);
      return (e.params.args || []).map(a => String(a.value || a.description || '')).join(' ').slice(0, 200);
    });
    report.appVersion = await evaluate(`(() => ({
      build: (document.querySelector('[data-build]') || {}).textContent || '',
      navCount: document.querySelectorAll('.nav-item').length,
      recipeCount: document.querySelectorAll('.recipe-grid .recipe-card, #recipeGrid > *').length,
      m4Visible: !!document.querySelector('#m4Box')
    }))()`);

    fs.writeFileSync(path.join(OUT, 'mobile-check.json'), JSON.stringify(report, null, 2));
    console.log('[done] screenshots=' + v390.screenshots.length + ' consoleErrors=' + report.consoleErrors.length);
    console.log('[done] report=' + path.join(OUT, 'mobile-check.json'));
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    server.close();
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
}
main().catch(e => { console.error('FAILED:', e.message); server.close(); process.exit(1); });
