#!/usr/bin/env node
/* ============================================================
 * e2e-regression.js — 真实浏览器端到端回归（零依赖）
 *
 * 为什么需要它：
 *   verify.js 是「结构 + 纯函数 + DOM 桩」级别，198 项全绿仍挡不住
 *   v1.6.1 那次只在真实浏览器 + 分发环境里才出现的 SW 缓存错配。
 *   本脚本用本机 Chrome headless 真正跑一遍页面和点击流程，可重复执行。
 *
 * 用法：
 *   node e2e-regression.js                 跑全部场景（A 默认数据 / B 空库存）
 *   node e2e-regression.js --scene=a      只跑 A
 *   node e2e-regression.js --scene=b      只跑 B
 *   node e2e-regression.js --chrome=<路径> 指定 Chrome
 *   node e2e-regression.js --keep         保留探针 HTML 便于排查（默认自动清理）
 *   node e2e-regression.js --help
 *
 * 约束：
 *   - 脚本放在工作区根目录，不进 fridge-app/ 部署目录，不影响 m4-1 基线。
 *   - 探针 HTML 只在同一目录临时生成（相对资源才能加载），跑完由 finally 删除。
 *   - 每个场景用独立 Chrome user-data-dir，状态互不污染。
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var cp = require('child_process');
var pathToFileURL = require('url').pathToFileURL;

var ROOT = __dirname;
var APP = path.join(ROOT, 'fridge-app');
var INDEX = path.join(APP, 'index.html');
var STORAGE_KEY = 'xianzhi.fridge.v1';
var HEAD_ANCHOR = '<script src="app.js"></script>';
var BODY_ANCHOR = '</body>';
var TEMPS = [];

/* ---------- 参数 ---------- */
var argv = process.argv.slice(2);
var opt = { scene: 'all', chrome: '', keep: false };
argv.forEach(function (a) {
  if (a === '--help' || a === '-h') opt.help = true;
  else if (a === '--keep') opt.keep = true;
  else if (a.indexOf('--scene=') === 0) opt.scene = a.slice(8).toLowerCase();
  else if (a.indexOf('--chrome=') === 0) opt.chrome = a.slice(9);
});
if (opt.help) {
  console.log('用法: node e2e-regression.js [--scene=a|b|all] [--chrome=<路径>] [--keep]');
  console.log('场景 A：默认示例数据，跑完整闭环；场景 B：库存被扣光，验证剩菜登记缺陷不复发。');
  console.log('需要本机安装 Chrome；也可设置环境变量 CHROME_PATH。');
  process.exit(0);
}
if (['a', 'b', 'all'].indexOf(opt.scene) < 0) {
  console.error('未知场景：' + opt.scene + '（应为 a / b / all）');
  process.exit(2);
}

/* ---------- Chrome 探测 ---------- */
function findChrome() {
  var candidates = [
    opt.chrome,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (var i = 0; i < candidates.length; i++) {
    try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
  }
  return null;
}

/* ---------- 注入到页面的两段探针 ----------
 * 前置段插在 app.js 之前：此时 data.js / engine.js 已就绪，可预置状态并挂错误收集。
 * 测试段插在 </body> 前：此时 app.js 已同步跑完，可直接操作真实 DOM。
 * 结果用 encodeURIComponent 写成 <pre> 文本，避免 HTML 实体干扰解析。 */
function probeScripts(scene) {
  var preset = '';
  if (scene === 'b') {
    preset = [
      '  // 场景 B：模拟「做菜把库存扣光」，且保留一条做菜历史',
      '  try {',
      '    var D = window.XZ_DATA, E = window.XZ_ENGINE;',
      '    var rid = D.RECIPES[0].id;',
      '    var st = {',
      '      version: 1, inventory: [],',
      '      prefs: { people: 2, flavor: "", quick: true, goal: "均衡", avoid: [], remind: true },',
      '      history: [{ recipeId: rid, rating: 5, date: E.todayStr(), usedIds: [] }],',
      '      shopping: [], selected: [], generatedIds: [], generatedCount: 0, lastGeneratedAt: "",',
      '      nutritionLog: {}, weekPlan: { weekStart: "", meals: {} },',
      '      leftovers: [], reuseLog: [],',
      '      m4: { userId: "U-e2e-empty", baseline: "m4-1", startedAt: E.todayStr(), checkIns: {}, viewedRecipe: 0 }',
      '    };',
      '    localStorage.setItem(' + JSON.stringify(STORAGE_KEY) + ', JSON.stringify(st));',
      '  } catch (e) { window.__E2E_ERRORS.push("preset: " + e); }'
    ].join('\n');
  }

  var pre = [
    '(function () {',
    '  window.__E2E_ERRORS = [];',
    '  window.addEventListener("error", function (e) {',
    '    window.__E2E_ERRORS.push(String(e.message || e.error || "error"));',
    '  });',
    '  window.addEventListener("unhandledrejection", function (e) {',
    '    window.__E2E_ERRORS.push("unhandledrejection: " + String(e.reason));',
    '  });',
    '  try {',
    '    var n = (+sessionStorage.getItem("xz-e2e-loads") || 0) + 1;',
    '    sessionStorage.setItem("xz-e2e-loads", String(n));',
    '  } catch (e) {}',
    preset,
    '})();'
  ].join('\n');

  var helpers = [
    '(function () {',
    '  var R = [];',
    '  function ok(n, c, x) { R.push({ n: n, ok: !!c, x: String(x == null ? "" : x) }); }',
    '  function q(s) { return document.querySelector(s); }',
    '  function qa(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }',
    '  function txt(s) { var e = q(s); return e ? e.textContent : ""; }',
    '  function act(a, root) {',
    '    var scope = root || document;',
    '    var el = scope.querySelector("[data-action=\\"" + a + "\\"]");',
    '    if (el) { el.click(); return el; } return null;',
    '  }',
    '  function goView(v) { var e = q(".nav-item[data-view=\\"" + v + "\\"]"); if (e) e.click(); return !!e; }',
    '  function allFoods() {',
    '    return window.XZ_DATA.FOODS.filter(function (f) { return f.cat !== "调味"; }).length;',
    '  }',
    '  function put() {',
    '    var old = document.getElementById("E2EOUT");',
    '    if (old) old.remove();',
    '    var pre = document.createElement("pre");',
    '    pre.id = "E2EOUT";',
    '    pre.textContent = encodeURIComponent(JSON.stringify(R));',
    '    document.body.appendChild(pre);',
    '  }',
    '  var loads = "?";',
    '  try { loads = sessionStorage.getItem("xz-e2e-loads") || "?"; } catch (e) {}'
  ].join('\n');

  var bodyA = [
    '  try {',
    '    var eng = window.XZ_ENGINE;',
    '    ok("A01 构建号三处一致 1.6.2",',
    '        window.XZ_APP_BUILD === "1.6.2" && eng && eng.BUILD === "1.6.2" && window.XZ_EXPECT_BUILD === "1.6.2",',
    '        String(window.XZ_APP_BUILD) + " / " + (eng && eng.BUILD) + " / " + window.XZ_EXPECT_BUILD);',
    '    ok("A02 版本一致时不触发自愈重载", loads === "1", "loads=" + loads);',
    '    var navs = qa(".nav-item[data-view]");',
    '    ok("A03 九个视图导航齐全", navs.length === 9, navs.length + " 个");',
    '    var viewOk = navs.length === 9 && navs.every(function (b) {',
    '      var v = b.getAttribute("data-view"); b.click();',
    '      var t = document.getElementById("view-" + v);',
    '      return t && t.classList.contains("active");',
    '    });',
    '    ok("A04 逐个切换视图均命中容器", viewOk);',
    '    goView("plan");',
    '    ok("A05 计划页有「我做了」入口", !!act("open-feedback"));',
    '    var loBox = document.getElementById("fbLeftover");',
    '    ok("A06 反馈弹窗默认勾选「这道菜有剩」", !!(loBox && loBox.checked));',
    '    act("submit-feedback");',
    '    goView("leftover");',
    '    ok("A07 做饭反馈一键登记进剩菜盒", txt("#leftoverList").indexOf("来自做过的菜") >= 0);',
    '    var ideas = qa("#reuseIdeas .idea-card").length;',
    '    ok("A08 剩菜改造方案已渲染", ideas > 0, ideas + " 张");',
    '    act("open-leftover-add");',
    '    var boxes = qa("[data-lo-food]");',
    '    var expect = allFoods();',
    '    ok("A09 登记弹窗列出全部食材(不按库存过滤)", boxes.length === expect, boxes.length + "/" + expect);',
    '    var labels = qa(".lo-food-grid .check-item");',
    '    var topRanked = labels.length > 0 && (labels[0].querySelector(".lo-recent") || labels[0].classList.contains("on"));',
    '    ok("A10 最近做过的食材有标记且置顶", qa(".lo-recent").length > 0 && topRanked, qa(".lo-recent").length + " 个标记");',
    '    ok("A11 快捷登记入口存在", qa("[data-action=\\"quick-leftover\\"]").length > 0);',
    '    boxes.slice(0, 2).forEach(function (b) { b.checked = true; });',
    '    var nameEl = document.getElementById("loName");',
    '    if (nameEl) nameEl.value = "e2e 测试剩菜";',
    '    var before = qa("#leftoverList .lo-item").length;',
    '    act("submit-leftover");',
    '    var after = qa("#leftoverList .lo-item").length;',
    '    ok("A12 手动登记写入剩菜盒且条目 +1", after === before + 1, before + " → " + after);',
    '    var mine = qa("#leftoverList .lo-item").filter(function (el) {',
    '      return el.textContent.indexOf("e2e 测试剩菜") >= 0;',
    '    })[0];',
    '    ok("A13 新登记条目显示已关联食材", !!mine && mine.textContent.indexOf("关联：") >= 0);',
    '    var target = mine ? mine.querySelector("[data-action=\\"lo-edit\\"]") : null;',
    '    var targetUid = target ? target.getAttribute("data-uid") : "";',
    '    if (target) target.click();',
    '    var checkedNow = qa("[data-lo-food]:checked").length;',
    '    ok("A14 编辑弹窗带回原关联食材", checkedNow === 2, checkedNow + " 项预选");',
    '    var uidEl = document.getElementById("loEditUid");',
    '    ok("A15 编辑态复用原 uid", !!(uidEl && uidEl.value === targetUid), String(targetUid));',
    '    var more = qa("[data-lo-food]").filter(function (b) { return !b.checked; })[0];',
    '    if (more) more.checked = true;',
    '    act("submit-leftover");',
    '    var still = qa("#leftoverList [data-action=\\"lo-edit\\"]").some(function (b) {',
    '      return b.getAttribute("data-uid") === targetUid;',
    '    });',
    '    var countEdit = qa("#leftoverList .lo-item").length;',
    '    ok("A16 编辑不新增重复条目", still && countEdit === after, countEdit + " 条");',
    '    var pick = qa("#reuseIdeas [data-action=\\"reuse-pick\\"]")[0];',
    '    if (pick) pick.click();',
    '    ok("A17 凑一锅勾选后覆盖面板更新", txt("#reuseCoverage").indexOf("已选") >= 0);',
    '    act("reuse-batch");',
    '    ok("A18 闭环动作已接线并给出反馈", txt("#toastRoot").length > 0 || qa(".toast").length > 0);',
    '    goView("settings");',
    '    var bbox = document.getElementById("backupBox");',
    '    ok("A19 设置页备份卡片已渲染", !!(bbox && bbox.textContent.indexOf("上次备份") >= 0));',
    '    var acts = qa("[data-action]").map(function (b) { return b.getAttribute("data-action"); });',
    '    ok("A20 导出与导入按钮已接线", acts.indexOf("backup-export") >= 0 && acts.indexOf("backup-pick") >= 0);',
    '    act("backup-export");',
    '    ok("A21 导出备份不抛运行时错误", (window.__E2E_ERRORS || []).length === 0, (window.__E2E_ERRORS || []).join(" | "));',
    '  } catch (e) { ok("A 场景执行异常", false, (e && e.message) || String(e)); }',
    '  // 异步：构造合法备份 JSON，走真实 FileReader -> 二次确认 -> 覆盖导入',
    '  var bak = window.XZ_ENGINE.backupToText({',
    '    inventory: [{ uid: "e2e1", foodId: "tomato", qty: "2 个", expiryDate: window.XZ_ENGINE.todayStr() }],',
    '    prefs: { people: 2, flavor: "", quick: true, goal: "均衡", avoid: [] },',
    '    history: [], leftovers: [], reuseLog: [],',
    '    m4: { userId: "U-e2e-backup", baseline: "m4-1", startedAt: window.XZ_ENGINE.todayStr(),',
    '          checkIns: { "2026-11-08": { opened: true, cooked: 1 } }, viewedRecipe: 1 }',
    '  }, "2026-11-08 12:00");',
    '  var bInput = document.getElementById("backupFile");',
    '  try {',
    '    var dt = new DataTransfer();',
    '    dt.items.add(new File([bak], "backup.json", { type: "application/json" }));',
    '    bInput.files = dt.files;',
    '    bInput.dispatchEvent(new Event("change", { bubbles: true }));',
    '    ok("A22 备份文件已注入输入框", true);',
    '  } catch (e) { ok("A22 备份文件已注入输入框", false, (e && e.message) || String(e)); }',
    '  var tries = 0;',
    '  (function poll() {',
    '    var m = document.getElementById("modalRoot");',
    '    if (m && m.textContent.indexOf("确认导入备份") >= 0) {',
    '      ok("A23 合法备份弹出二次确认", true);',
    '      act("backup-import-confirm");',
    '      ok("A24 确认覆盖导入后弹窗关闭", (document.getElementById("modalRoot").textContent || "").indexOf("确认导入备份") < 0);',
    '      var e2 = window.__E2E_ERRORS || [];',
    '      ok("A25 全程无 JS 运行时错误", e2.length === 0, e2.join(" | "));',
    '      put();',
    '      return;',
    '    }',
    '    if (++tries < 30) { setTimeout(poll, 100); }',
    '    else {',
    '      ok("A23 合法备份弹出二次确认", false, "等待超时");',
    '      var e3 = window.__E2E_ERRORS || [];',
    '      ok("A25 全程无 JS 运行时错误", e3.length === 0, e3.join(" | "));',
    '      put();',
    '    }',
    '  })();'
  ].join('\n');

  var bodyB = [
    '  try {',
    '    var st = null;',
    '    try { st = JSON.parse(localStorage.getItem(' + JSON.stringify(STORAGE_KEY) + ') || "null"); } catch (e) {}',
    '    ok("B01 空库存状态已预置且页面正常启动", !!(st && st.inventory.length === 0 && window.XZ_APP_BUILD));',
    '    ok("B02 版本一致时不触发自愈重载", loads === "1", "loads=" + loads);',
    '    goView("leftover");',
    '    act("open-leftover-add");',
    '    var boxes = qa("[data-lo-food]");',
    '    var expect = allFoods();',
    '    ok("B03 库存扣光后登记弹窗仍列全部食材", boxes.length === expect, boxes.length + "/" + expect);',
    '    boxes.slice(0, 2).forEach(function (b) { b.checked = true; });',
    '    var nameEl = document.getElementById("loName");',
    '    if (nameEl) nameEl.value = "e2e 空库存剩菜";',
    '    act("submit-leftover");',
    '    ok("B04 空库存也能登记成功", txt("#leftoverList").indexOf("e2e 空库存剩菜") >= 0);',
    '    var ideas = qa("#reuseIdeas .idea-card").length;',
    '    ok("B05 空库存仍能匹配出改造方案", ideas > 0, ideas + " 张");',
    '    var quick = qa("#leftoverQuick [data-action=\\"quick-leftover\\"]");',
    '    ok("B06 做菜历史仍能带出快捷登记", quick.length > 0, quick.length + " 个");',
    '    if (quick[0]) quick[0].click();',
    '    ok("B07 快捷登记写入剩菜盒", txt("#leftoverList").indexOf("来自做过的菜") >= 0);',
    '    var errs = window.__E2E_ERRORS || [];',
    '    ok("B08 全程无 JS 运行时错误", errs.length === 0, errs.join(" | "));',
    '  } catch (e) { ok("B 场景执行异常", false, (e && e.message) || String(e)); }'
  ].join('\n');

  var test = [helpers, scene === 'a' ? bodyA : bodyB, '  put();', '})();'].join('\n');
  return { pre: pre, test: test };
}

/* ---------- 生成探针 HTML ---------- */
function buildProbeHtml(scene) {
  var html = fs.readFileSync(INDEX, 'utf8');
  if (html.indexOf(HEAD_ANCHOR) < 0 || html.indexOf(BODY_ANCHOR) < 0) {
    throw new Error('index.html 结构变化，找不到注入锚点');
  }
  var p = probeScripts(scene);
  html = html.replace(HEAD_ANCHOR, '<script>\n' + p.pre + '\n</script>\n' + HEAD_ANCHOR);
  html = html.replace(BODY_ANCHOR, '<script>\n' + p.test + '\n</script>\n' + BODY_ANCHOR);
  var file = path.join(APP, '_e2e_' + scene + '.html');
  fs.writeFileSync(file, html, 'utf8');
  TEMPS.push(file);
  return file;
}

/* ---------- 跑一个场景 ---------- */
function runScene(chrome, scene) {
  var htmlFile = buildProbeHtml(scene);
  var profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xz-e2e-'));
  TEMPS.push(profile);
  var args = [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--allow-file-access-from-files',
    '--virtual-time-budget=8000',
    '--user-data-dir=' + profile,
    '--dump-dom',
    pathToFileURL(htmlFile).href
  ];
  var r = cp.spawnSync(chrome, args, {
    encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, timeout: 90000,
    windowsHide: true
  });
  var out = String(r.stdout || '');
  var m = out.match(/<pre\s+id="E2EOUT"[^>]*>([\s\S]*?)<\/pre>/i);
  if (!m) {
    var why = r.error ? String(r.error) : (String(r.stderr || '').slice(0, 400) || out.slice(0, 400));
    throw new Error('场景 ' + scene.toUpperCase() + ' 未拿到探针输出：' + why);
  }
  return JSON.parse(decodeURIComponent(m[1].trim()));
}

/* ---------- 清理 ---------- */
function cleanup() {
  TEMPS.forEach(function (p) {
    try {
      if (fs.existsSync(p)) {
        var st = fs.statSync(p);
        if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
      }
    } catch (e) {}
  });
}
process.on('exit', cleanup);

/* ---------- 主流程 ---------- */
(function main() {
  var chrome = findChrome();
  if (!chrome) {
    console.error('未找到 Chrome。请用 --chrome=<路径> 指定，或设置环境变量 CHROME_PATH。');
    process.exit(2);
  }
  console.log('\n真实浏览器端到端回归（Chrome headless）');
  console.log('  Chrome: ' + chrome);
  console.log('  页面源: ' + INDEX);
  console.log('  场景  : ' + opt.scene.toUpperCase() + '\n');

  var scenes = opt.scene === 'all' ? ['a', 'b'] : [opt.scene];
  var total = 0, failed = 0;
  try {
    scenes.forEach(function (s) {
      console.log(s === 'a'
        ? '场景 A · 默认示例数据（完整闭环 + 登记/编辑关联）'
        : '场景 B · 库存被扣光（v1.6.1 缺陷回归）');
      var rows;
      try {
        rows = runScene(chrome, s);
      } catch (e) {
        console.log('  [失败] ' + e.message);
        failed++;
        return;
      }
      rows.forEach(function (x) {
        total++;
        if (!x.ok) failed++;
        console.log('  [' + (x.ok ? '通过' : '失败') + '] ' + x.n + (x.x ? ' — ' + x.x : ''));
      });
      console.log('');
    });
  } finally {
    if (!opt.keep) cleanup();
  }
  console.log('结果：通过 ' + (total - failed) + ' 项，失败 ' + failed + ' 项');
  if (opt.keep) console.log('（--keep：探针 HTML 保留在 fridge-app/，请手动清理）');
  process.exitCode = failed ? 1 : 0;
})();
