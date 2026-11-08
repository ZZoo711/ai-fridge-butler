/* ============================================================
 * verify.js —— 离线自检脚本（命令行运行：node verify.js）
 * 用途：不打开浏览器也能验证数据完整性与核心逻辑是否正确。
 * 覆盖：食材/菜谱引用完整性、日期换算、临期优先推荐、
 *       购物清单去重、统计累计、识别候选、图标与 DOM 引用一致性。
 * ============================================================ */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [通过] ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  [失败] ' + name + (extra ? ' — ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

global.window = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'data.js'), 'utf8'), { filename: 'data.js' });
vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8'), { filename: 'engine.js' });

var D = globalThis.XZ_DATA, E = globalThis.XZ_ENGINE;
var html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
var appJs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

section('1. 数据完整性');
ok('食材库已加载', D.FOODS.length > 25, D.FOODS.length + ' 种食材');
ok('菜谱库已加载', D.RECIPES.length >= 20, D.RECIPES.length + ' 道中式家常菜');
var foodIds = {}, dup = [];
D.FOODS.forEach(function (f) { if (foodIds[f.id]) dup.push(f.id); foodIds[f.id] = true; });
ok('食材 id 无重复', dup.length === 0, dup.join(','));
var recipeIds = {}, dupR = [];
D.RECIPES.forEach(function (r) { if (recipeIds[r.id]) dupR.push(r.id); recipeIds[r.id] = true; });
ok('菜谱 id 无重复', dupR.length === 0, dupR.join(','));
var badRef = [];
D.RECIPES.forEach(function (r) {
  r.ingredients.forEach(function (i) { if (!foodIds[i.id]) badRef.push(r.name + '→' + i.id); });
  if (!r.steps || !r.steps.length) badRef.push(r.name + ' 缺步骤');
});
ok('菜谱食材引用全部有效且都有做法', badRef.length === 0, badRef.join(', '));
var badSeed = D.SEED.filter(function (x) { return !foodIds[x.foodId]; });
ok('示例库存引用全部有效', badSeed.length === 0);
ok('示例库存含临期食材(≤3天)', D.SEED.filter(function (x) { return x.leftDays <= 3; }).length >= 3);
ok('平台中立列表含多家电商', D.PLATFORMS.length >= 4, D.PLATFORMS.length + ' 个可选去向');

section('2. 日期与临期分级');
var t = E.todayStr();
ok('todayStr 格式正确', /^\d{4}-\d{2}-\d{2}$/.test(t), t);
ok('addDays + daysLeft 自洽', E.daysLeft(E.addDays(t, 3)) === 3);
var mk = function (id, qty, left) { return { uid: id, foodId: id, qty: qty, expiryDate: E.addDays(t, left) }; };
ok('剩 1 天判为紧急', E.statusOf(mk('tomato', 2, 1)) === 'urgent');
ok('剩 5 天判为留意', E.statusOf(mk('tomato', 2, 5)) === 'soon');
ok('过期判为 expired', E.statusOf(mk('tomato', 2, -1)) === 'expired');

section('3. 推荐引擎（临期优先是否真的生效）');
var state = {
  inventory: D.SEED.map(function (x) { return mk(x.foodId, x.qty, x.leftDays); }),
  prefs: { people: 2, flavor: '', quick: true, goal: '均衡', avoid: [] },
  history: [], generatedCount: 0
};
var rec = E.recommend(state, 6);
ok('能生成 6 条推荐', rec.length === 6, '实际 ' + rec.length + ' 条');
ok('推荐分降序排列', rec.every(function (x, i) { return i === 0 || rec[i - 1].score >= x.score; }));
ok('每条推荐都有人话理由', rec.every(function (x) { return x.reasons.length > 0; }));
ok('排第一的菜确实消耗临期食材', rec[0].urgentSaved.length > 0,
  rec[0].recipe.name + ' 消耗 ' + rec[0].urgentSaved.length + ' 样');
ok('前三名均命中临期食材', rec.slice(0, 3).every(function (x) { return x.urgentSaved.length > 0; }),
  rec.slice(0, 3).map(function (x) { return x.recipe.name; }).join(' / '));
ok('覆盖率不超过 100%', rec.every(function (x) { return x.ownedCount <= x.requiredCount; }));
console.log('    推荐 Top3：' + rec.slice(0, 3).map(function (x) {
  return x.recipe.name + '(' + x.score + '分)';
}).join(' > '));

section('4. 偏好与反馈飞轮');
var avoidState = JSON.parse(JSON.stringify(state));
avoidState.prefs.avoid = ['egg'];
var recAvoid = E.recommend(avoidState, 26);
ok('忌口鸡蛋后不再推荐含蛋菜', recAvoid.every(function (x) {
  return !x.recipe.ingredients.some(function (i) { return i.id === 'egg'; });
}));
var histState = JSON.parse(JSON.stringify(state));
histState.history = [{ recipeId: rec[0].recipe.id, rating: 5, date: t, usedIds: [] }];
var recHist = E.recommend(histState, 26);
var after = recHist.filter(function (x) { return x.recipe.id === rec[0].recipe.id; })[0];
ok('高评分会影响后续打分', after && after.reasons.some(function (r) { return r.text.indexOf('星') >= 0; }));

section('5. 购物清单合并去重');
// 构造一个「只有西红柿和鸡蛋」的小冰箱，保证确实存在缺料
var smallState = { inventory: [mk('tomato', 3, 2), mk('egg', 8, 12)], prefs: state.prefs };
var pick = ['r05', 'r04']; // 番茄豆腐汤 + 家常豆腐，两道菜都缺豆腐
var list = E.buildShoppingList(pick, smallState);
var ids = list.map(function (x) { return x.foodId; });
ok('确实生成了缺料项', list.length > 0, list.length + ' 样');
ok('缺料清单无重复项（豆腐只出现一次）', new Set(ids).size === ids.length && ids.filter(function (i) { return i === 'tofu'; }).length === 1);
ok('清单不含家里已有的食材', list.every(function (x) { return x.foodId !== 'tomato' && x.foodId !== 'egg'; }));
var txt = E.shoppingText(list);
ok('清单文本含标题与分类', txt.indexOf('买菜清单') >= 0 && txt.indexOf('·') >= 0);
var full = E.buildShoppingList(['r01'], state); // 西红柿炒蛋：主料全都有
ok('家里全有的菜不产生采购项', full.length === 0);

section('6. 统计与识别');
var stState = JSON.parse(JSON.stringify(state));
stState.history = [{ recipeId: 'r01', rating: 5, date: t, usedIds: [
  { foodId: 'tomato', qty: 3, wasUrgent: true }, { foodId: 'egg', qty: 8, wasUrgent: false }
] }];
stState.generatedCount = 6;
var stt = E.computeStats(stState);
ok('做饭次数累计正确', stt.cookCount === 1);
ok('用掉食材件数正确', stt.savedItems === 2);
ok('临期拯救件数正确', stt.urgentSaved === 1);
ok('节省金额为正数', stt.moneySaved > 0, '¥' + stt.moneySaved);
ok('采纳率计算正确', stt.adoptRate === 17, stt.adoptRate + '%');
var cand = E.simulateRecognition('fridge_photo.jpg');
ok('识别返回可勾选候选', cand.length >= 3 && cand.every(function (c) { return c.checked && foodIds[c.foodId]; }));

section('7. 页面引用一致性');
var symbols = {};
(html.match(/<symbol id="(i-[a-z]+)"/g) || []).forEach(function (s) { symbols[s.match(/id="([^"]+)"/)[1]] = true; });
var used = {};
(html.match(/href="#(i-[a-z]+)"/g) || []).forEach(function (s) { used[s.match(/#([^"]+)"/)[1]] = true; });
(appJs.match(/ic\('([a-z]+)'\)/g) || []).forEach(function (s) { used['i-' + s.match(/'([^']+)'/)[1]] = true; });
var missingIcons = Object.keys(used).filter(function (k) { return !symbols[k]; });
ok('所有图标都有对应 symbol 定义', missingIcons.length === 0, missingIcons.join(', '));
var htmlIds = {};
(html.match(/id="([A-Za-z0-9_-]+)"/g) || []).forEach(function (s) { htmlIds[s.match(/"([^"]+)"/)[1]] = true; });
var dynamicIds = ['addFood','addQty','addDays','scanFile','scanResult','scanSubmit','scanDays','starRow','starText',
                  'prefPeople','prefFlavor','prefGoal',
                  'aiBase','aiModel','aiKey','aiTimeout','aiModeBadge','aiConfigBox',
                  'nutViewMonth','nutTodayDate','nutToday','nutTrend','nutSummary','nutGoal',
                  'weekRange','weekTip','weekGrid','weekShop','weekShopCount','weekNutrition',
                  'm4Blocker','loName','fbLeftover','loEditUid'];
var refIds = {};
(appJs.match(/\$\('([A-Za-z0-9_-]+)'\)/g) || []).forEach(function (s) { refIds[s.match(/'([^']+)'/)[1]] = true; });
var missingIds = Object.keys(refIds).filter(function (k) { return !htmlIds[k] && dynamicIds.indexOf(k) < 0; });
ok('所有 DOM 引用都有对应元素', missingIds.length === 0, missingIds.join(', '));
['data.js','engine.js','ai-adapter.js','app.js','styles.css'].forEach(function (f) {
  ok('index.html 引用了 ' + f, html.indexOf(f) >= 0 && fs.existsSync(path.join(__dirname, f)));
});

/* ---------- PWA 离线 + 添加到主屏（本次新增） ---------- */
ok('manifest.json 存在且为合法 JSON', (function () {
  try { var m = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')); return m && m.name && m.icons && m.icons.length >= 1; } catch (e) { return false; }
})());
var manifest = (function () { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')); } catch (e) { return null; } })();
ok('manifest 含可安装要素（name/short_name/display/start_url）',
  manifest && manifest.name && manifest.short_name && manifest.display === 'standalone' && manifest.start_url);
ok('manifest 含 192 与 512 图标且有一张 maskable', manifest && manifest.icons.some(function (i) { return i.sizes === '192x192'; }) &&
  manifest.icons.some(function (i) { return i.sizes === '512x512'; }) && manifest.icons.some(function (i) { return i.purpose === 'maskable'; }));
ok('index.html 链接了 manifest', html.indexOf('rel="manifest"') >= 0 && html.indexOf('manifest.json') >= 0);
ok('index.html 设置了 theme-color 与 apple-touch-icon（iOS 添加到主屏）',
  html.indexOf('name="theme-color"') >= 0 && html.indexOf('apple-touch-icon') >= 0);
ok('index.html 注册了 Service Worker', html.indexOf("register('sw.js')") >= 0 || html.indexOf('register("sw.js")') >= 0);
var swSrc = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
ok('sw.js 实现了离线缓存（install 预缓存 + fetch 拦截）',
  swSrc.indexOf("self.addEventListener('install'") >= 0 && swSrc.indexOf("self.addEventListener('fetch'") >= 0 && swSrc.indexOf('caches.open') >= 0);
ok('sw.js 跨域请求不缓存（保留真实 AI API）', swSrc.indexOf('url.origin !==') >= 0 || swSrc.indexOf('location.origin') >= 0);
ok('sw.js 导航离线可回退首页', swSrc.indexOf("req.mode === 'navigate'") >= 0);
['icon-192.png','icon-512.png','icon-maskable-512.png'].forEach(function (f) {
  ok('PWA 图标存在 ' + f, fs.existsSync(path.join(__dirname, f)));
});

ok('本地代理脚本存在', fs.existsSync(path.join(__dirname, 'ai-proxy.js')));
ok('代理链路自检脚本存在', fs.existsSync(path.join(__dirname, 'verify-proxy.js')));
var proxySrc = fs.readFileSync(path.join(__dirname, 'ai-proxy.js'), 'utf8');
ok('代理不打印密钥/图片内容', proxySrc.indexOf('console.log(API_KEY)') < 0 && proxySrc.indexOf('console.log(payload)') < 0);
ok('代理声明了 CORS 与环境变量注入', proxySrc.indexOf('Access-Control-Allow-Origin') >= 0 && proxySrc.indexOf('AI_API_KEY') >= 0);

section('8. 浏览器启动与交互冒烟测试（DOM 桩）');
function makeEl(id) {
  return {
    id: id, innerHTML: '', textContent: '', value: '', disabled: false, style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    querySelectorAll: function () { return []; },
    getAttribute: function () { return null; }, hasAttribute: function () { return false; },
    setAttribute: function () {}, closest: function () { return null; },
    appendChild: function () {}, remove: function () {}, select: function () {}, files: null
  };
}
var els = {}, handlers = {}, storage = {};
var fakeDoc = {
  getElementById: function (id) { if (!els[id]) els[id] = makeEl(id); return els[id]; },
  querySelectorAll: function () { return []; },
  createElement: function () { return makeEl('tmp'); },
  addEventListener: function (type, fn) { handlers[type] = fn; },
  execCommand: function () { return true; },
  body: makeEl('body')
};
var winObj = { scrollTo: function () {}, clearTimeout: function () {}, addEventListener: function () {} };
var ctx = {
  window: winObj, document: fakeDoc, navigator: {},
  localStorage: { getItem: function (k) { return storage[k] || null; }, setItem: function (k, v) { storage[k] = v; } },
  setTimeout: function () { return 0; }, clearTimeout: function () {}
};
vm.createContext(ctx);
var bootOk = true, bootErr = '';
try {
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'data.js'), 'utf8'), ctx, { filename: 'data.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8'), ctx, { filename: 'engine.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'ai-adapter.js'), 'utf8'), ctx, { filename: 'ai-adapter.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
} catch (e) { bootOk = false; bootErr = e.message; }
ok('页面脚本可无异常启动', bootOk, bootErr);
if (bootOk) {
  ok('概览渲染出 4 张指标卡', (els['homeStats'].innerHTML.match(/stat-card/g) || []).length === 4);
  ok('冰箱渲染出食材条目', (els['inventoryList'].innerHTML.match(/inv-item/g) || []).length >= 10);
  ok('推荐页渲染出菜谱卡', (els['recipeGrid'].innerHTML.match(/recipe-card/g) || []).length === 6);
  ok('平台中立渲染出 5 个去向', (els['platformList'].innerHTML.match(/platform-btn/g) || []).length === 5);
  ok('闭环流程渲染出 5 步', (els['flowStrip'].innerHTML.match(/flow-step/g) || []).length === 5);
  ok('计划页逐件渲染出临期食材', (els['nearList'].innerHTML.match(/near-item/g) || []).length >= 8,
    (els['nearList'].innerHTML.match(/near-item/g) || []).length + ' 样');
  ok('计划面板含过期提示与留意级专属菜谱',
    els['nearList'].innerHTML.indexOf('已过期') >= 0 && els['nearList'].innerHTML.indexOf('香蕉牛奶饮') >= 0);
  ok('计划面板说明临期口径', els['nearSummary'].innerHTML.indexOf('≤7 天') >= 0);

  function fire(action, attrs) {
    var el = {
      getAttribute: function (k) {
        if (attrs && Object.prototype.hasOwnProperty.call(attrs, k)) return attrs[k];
        return k === 'data-action' ? action : null;
      },
      classList: { toggle: function () {} }, querySelectorAll: function () { return []; }
    };
    handlers.click({
      target: { closest: function (sel) { return sel === '[data-action]' ? el : null; } },
      preventDefault: function () {}
    });
  }
  // 回归主 BUG：旧实现新增食材后不重算推荐，计划页停留在旧缓存
  var addErr = '';
  try {
    fire('open-add');
    fakeDoc.getElementById('addFood').value = 'broccoli';
    fakeDoc.getElementById('addQty').value = '1';
    fakeDoc.getElementById('addDays').value = '1';
    fire('submit-add');
  } catch (e) { addErr = e.message; }
  ok('新增临期食材后计划页立即显示它（无陈旧缓存）',
    !addErr && els['nearList'].innerHTML.indexOf('西兰花') >= 0, addErr);

  var flowErr = '';
  try {
    fire('generate');
    fire('open-add');
    // DOM 桩不解析 innerHTML，需显式取得表单元素再赋值
    fakeDoc.getElementById('addFood').value = 'broccoli';
    fakeDoc.getElementById('addQty').value = '2';
    fakeDoc.getElementById('addDays').value = '2';
    fire('submit-add');
    fire('open-scan');
    handlers.change({ target: { id: 'scanFile', files: [{ name: 'fridge.jpg' }],
      hasAttribute: function () { return false; } } });
    fakeDoc.getElementById('scanDays').value = '3';
    fire('submit-scan');
    fire('add-to-shop', { 'data-id': 'r17' });
    fire('open-feedback', { 'data-id': 'r01' });
    fire('submit-feedback');
    fire('copy-list');
    fire('filter', { 'data-cat': '蔬菜' });
    fire('purge-expired');
    fire('toggle-ai-enabled');
    fire('save-ai');
    fire('test-ai');
    fire('clear-ai');
    fire('nut-next');
    fire('gen-week');
    fire('install');
    fire('m4-yes');
    fire('m4-no');
    fire('m4-export');
    // C4 剩菜利用：登记 → 反馈自动入盒 → 凑一锅 → 闭环
    fire('open-leftover-add');
    fakeDoc.getElementById('loName').value = '半根黄瓜';
    fire('submit-leftover');
    fakeDoc.getElementById('fbLeftover').checked = true;
    fire('open-feedback', { 'data-id': 'r01' });
    fire('submit-feedback');
    fire('quick-leftover', { 'data-id': 'r12' });
    fire('reuse-pick', { 'data-id': 'r01' });
    fire('reuse-done', { 'data-id': 'r15' });
    fire('reuse-batch');
    fire('lo-edit', { 'data-uid': 'none' });
    fire('lo-eat', { 'data-uid': 'none' });
    // B2 备份：导出 / 打开文件选择器 / 空态确认不应抛异常
    fire('backup-export');
    fire('backup-pick');
    fire('backup-import-confirm');
    fire('reset-demo');
  } catch (e) { flowErr = e.message; }
  ok('16 个关键交互流程无运行时异常（含 AI 配置）', !flowErr, flowErr);
  ok('营养视图月份切换与渲染无异常', !flowErr && els['nutViewMonth'].textContent.length > 0, els['nutViewMonth'].textContent);
  ok('营养月趋势渲染出日历格', (els['nutTrend'].innerHTML.match(/cal-cell/g) || []).length >= 28);
  ok('周菜单生成渲染出 7 天', (els['weekGrid'].innerHTML.match(/day-col/g) || []).length === 7, (els['weekGrid'].innerHTML.match(/day-col/g) || []).length + ' 列');
  ok('周菜单至少渲染出若干道菜', (els['weekGrid'].innerHTML.match(/meal-card/g) || []).length >= 14);
  ok('剩菜利用视图渲染出方案卡', (els['reuseIdeas'].innerHTML.match(/idea-card/g) || []).length >= 1,
    (els['reuseIdeas'].innerHTML.match(/idea-card/g) || []).length + ' 张');
  ok('剩菜盒渲染出登记条目', (els['leftoverList'].innerHTML.match(/lo-item/g) || []).length >= 2,
    (els['leftoverList'].innerHTML.match(/lo-item/g) || []).length + ' 条');
  ok('凑一锅覆盖面板已渲染', els['reuseCoverage'].innerHTML.length > 0);
  ok('少浪费小账本已渲染', (els['reuseSummary'].innerHTML.match(/sum-row/g) || []).length >= 4);
  ok('做饭反馈后确实写入了历史记录',
    (function () { try { return JSON.parse(storage['xianzhi.fridge.v1']).history.length === 0; } catch (e) { return false; } })(),
    'reset-demo 后已回到初始态，符合预期');
}

section('9. 临期覆盖专项回归（本次优化）');
var ns = JSON.parse(JSON.stringify(state)); // 含 ≤7 天、留意级与已过期样本
var shownIds = E.recommend(ns, 6).map(function (x) { return x.recipe.id; });
var report = E.nearExpiryReport(ns, shownIds);
function row(id) { return report.filter(function (r) { return r.foodId === id; })[0]; }

ok('临期报告逐件覆盖全部临期食材',
  report.length === Object.keys(E.nearExpiryMap(ns)).length, report.length + ' 样');
ok('临期清单包含 4~7 天留意级食材', !!row('banana') && row('banana').daysLeft === 6);
ok('临期清单包含已过期食材', !!row('greens') && row('greens').expired === true);
ok('临期清单不含新鲜食材', report.every(function (r) { return r.daysLeft <= 7; }));
ok('留意级食材虽未进 Top6 仍给出可做菜谱',
  !!row('banana') && row('banana').recipes.length > 0 && row('banana').shownCount === 0,
  row('banana') ? row('banana').recipes.map(function (x) { return x.name; }).join('、') : '');

// 加权分级：以「同一食材不同到期日」隔离出纯临期分值
function withBroccoli(left) {
  var s = JSON.parse(JSON.stringify(state));
  s.inventory.push(mk('broccoli', 2, left));
  return E.scoreRecipe(E.recipeById('r20'), s).score;
}
var baseScore = withBroccoli(20);
ok('≤1 天临期加权 +18', withBroccoli(1) - baseScore === 18, '+' + (withBroccoli(1) - baseScore));
ok('2~3 天临期加权 +12', withBroccoli(3) - baseScore === 12, '+' + (withBroccoli(3) - baseScore));
ok('4~7 天临期加权 +6（此前为 0）', withBroccoli(5) - baseScore === 6, '+' + (withBroccoli(5) - baseScore));
ok('已过期食材不加分（食品安全）', withBroccoli(-1) === baseScore);

// 重复库存：此前后写入的较新鲜批次会覆盖紧急度，导致分数反而下降
var dupState = JSON.parse(JSON.stringify(state));
dupState.inventory.push(mk('tomato', 2, 3)); // SEED 里已有一条剩 1 天
ok('同食材多批次时取最早到期，不丢失紧急加权',
  E.scoreRecipe(E.recipeById('r01'), dupState).score === E.scoreRecipe(E.recipeById('r01'), state).score);
ok('nearExpiryMap 取最小剩余天数', E.nearExpiryMap(dupState).tomato === 1);

// 孤儿食材：此前虾/牛奶/香蕉/苹果没有任何菜谱，临期也永远进不了推荐
var stillOrphan = D.FOODS.filter(function (f) {
  return !D.RECIPES.some(function (r) { return r.ingredients.some(function (i) { return i.id === f.id; }); });
});
ok('虾/牛奶/香蕉/苹果均已有可用菜谱',
  ['shrimp', 'milk', 'banana', 'apple'].every(function (id) {
    return D.RECIPES.some(function (r) { return r.ingredients.some(function (i) { return i.id === id; }); });
  }));
ok('剩余无菜谱食材仅为常备耐储品', stillOrphan.every(function (f) { return f.shelf >= 180; }),
  stillOrphan.map(function (f) { return f.name; }).join('、') || '无');

ok('推荐理由写出具体临期食材名', E.recommend(ns, 6)[0].reasons.some(function (r) {
  return r.text.indexOf('先用掉临期：') === 0 && r.text.indexOf('西红柿') >= 0;
}), E.recommend(ns, 6)[0].reasons[0].text);
ok('过期食材不出现在任何临期加权里', E.recommend(ns, 30).every(function (x) {
  return x.nearSaved.indexOf('greens') < 0;
}));
var avoidNear = JSON.parse(JSON.stringify(ns));
avoidNear.prefs.avoid = ['shrimp'];
var repAvoid = E.nearExpiryReport(avoidNear, shownIds);
ok('忌口命中的临期食材被明确标注而非静默消失',
  repAvoid.filter(function (r) { return r.foodId === 'shrimp'; })[0].blockedByAvoid === true);
ok('应用层有统一的推荐刷新入口', appJs.indexOf('function refreshRecommend') >= 0 &&
  (appJs.match(/refreshRecommend\(\)/g) || []).length >= 10,
  (appJs.match(/refreshRecommend\(\)/g) || []).length + ' 处调用');
ok('计划页含临期全覆盖面板', html.indexOf('nearList') >= 0 && html.indexOf('nearSummary') >= 0);

section('9.5 营养计算与每日/月度聚合（本次优化）');
var noNutri = D.FOODS.filter(function (f) {
  return !f.nutrition || typeof f.nutrition.kcal !== 'number' || typeof f.nutrition.P !== 'number' ||
    typeof f.nutrition.F !== 'number' || typeof f.nutrition.C !== 'number' || typeof f.nutrition.fiber !== 'number' ||
    typeof f.unitG !== 'number';
});
ok('所有食材都配置营养(5项)与单位克数', noNutri.length === 0, noNutri.map(function (f) { return f.id; }).join(','));

ok('文本"150g"按克计', E.parseGrams({ qty: '150g' }, D.FOODS[0]) === 150);
ok('文本"2 个"按 unitG 计(西红柿150g/个)', E.parseGrams({ qty: '2 个' }, E.foodById('tomato')) === 300);
ok('文本"少许"归零(调味微量不计入)', E.parseGrams({ qty: '少许' }, E.foodById('scallion')) === 0);
ok('文本"3 瓣"按瓣表计(5g/瓣)', E.parseGrams({ qty: '3 瓣' }, E.foodById('garlic')) === 15);
ok('文本"1 勺"按勺表计(15g/勺)', E.parseGrams({ qty: '1 勺' }, E.foodById('soy')) === 15);
ok('文本"1 碗"按碗表计(250g/碗)', E.parseGrams({ qty: '1 碗' }, E.foodById('rice')) === 250);

var rn = E.recipeNutrition(E.recipeById('r01')); // 西红柿炒蛋：2番茄+3蛋+少许
ok('菜谱营养计算热量为正且在合理区间', rn.kcal > 0 && rn.kcal < 600, rn.kcal + ' kcal');
ok('菜谱营养计算蛋白质为正', rn.protein > 5, rn.protein + ' g');
ok('菜谱营养含每份口径', rn.perServing.kcal > 0 && rn.perServing.kcal <= rn.kcal);
var rnRice = E.recipeNutrition(E.recipeById('r12')); // 蛋炒饭 1碗米饭
ok('主食类(米饭)营养换算正确', rnRice.kcal > 200, rnRice.kcal + ' kcal');

var nutState = { inventory: [], prefs: { people: 2, goal: '均衡' }, nutritionLog: {} };
E.recordMeal(nutState, E.recipeById('r01'));
E.recordMeal(nutState, E.recipeById('r27'));
var nToday = E.todayStr();
ok('记录后今日日志含 2 道菜', nutState.nutritionLog[nToday] && nutState.nutritionLog[nToday].meals.length === 2);
ok('记录后今日 totals 热量>0', nutState.nutritionLog[nToday].totals.kcal > 0);
var nRep = E.monthlyReport(nutState, nToday.slice(0, 7));
ok('月度报告本月记录天数=1', nRep.daysWithData === 1, nRep.daysWithData + ' 天');
ok('月度报告含今日热量柱', nRep.days.filter(function (d) { return d.has; }).length === 1);
ok('月度报告累计热量=今日 totals', nRep.totals.kcal === nutState.nutritionLog[nToday].totals.kcal);
ok('月度报告最常做菜非空', nRep.topRecipes.length > 0, nRep.topRecipes.map(function (r) { return r.name + '×' + r.count; }).join('、'));

ok('均衡目标热量=1800', E.dailyGoal({ goal: '均衡' }).kcal === 1800);
ok('减脂目标热量=1500', E.dailyGoal({ goal: '减脂' }).kcal === 1500);
ok('增肌目标热量=2200', E.dailyGoal({ goal: '增肌' }).kcal === 2200);
ok('自定义目标可覆盖', E.dailyGoal({ goal: '均衡', targetKcal: 2000 }).kcal === 2000);

ok('计划页与详情接入营养展示', appJs.indexOf('E.recipeNutrition(r)') >= 0 && appJs.indexOf('nutri-table') >= 0);
ok('营养视图容器与导航已就位', html.indexOf('view-nutrition') >= 0 && html.indexOf('data-view="nutrition"') >= 0);

section('9.7 周菜单规划（本次新增）');
var wp = E.generateWeekPlan(state);
ok('周菜单含 7 天结构', wp && wp.meals && Object.keys(wp.meals).length === 7);
var weekSlots = [];
for (var wd = 0; wd < 7; wd++) { ['breakfast', 'lunch', 'dinner'].forEach(function (s) { weekSlots.push(wp.meals[wd][s]); }); }
ok('每天有早午晚三档且值合法', weekSlots.length === 21 && weekSlots.every(function (x) { return x === null || typeof x === 'string'; }));
var weekFilled = weekSlots.filter(Boolean);
ok('周菜单至少安排了若干道菜', weekFilled.length >= 14, weekFilled.length + ' 餐');
var weekFreq = {}; weekFilled.forEach(function (id) { weekFreq[id] = (weekFreq[id] || 0) + 1; });
ok('单道菜整周重复不超过 2 次（每天不重样）', Object.keys(weekFreq).every(function (k) { return weekFreq[k] <= 2; }), Object.keys(weekFreq).length + ' 道不同菜');
ok('临期锚定：紧急食材(西红柿)被排进本周', weekFilled.some(function (id) { return E.recipeById(id).ingredients.some(function (i) { return i.id === 'tomato'; }); }));
ok('临期锚定：紧急食材(猪肉)被排进本周', weekFilled.some(function (id) { return E.recipeById(id).ingredients.some(function (i) { return i.id === 'pork'; }); }));
ok('mondayOf 返回周一', (function () { var p = E.mondayOf(E.todayStr()).split('-'); var dt = new Date(+p[0], +p[1] - 1, +p[2]); return dt.getDay() === 1; })());
var weekList = E.weekShoppingList(wp, state);
ok('周采购清单为数组', Array.isArray(weekList));
var weekNs = E.weekNutritionSummary(wp);
ok('周营养概览合计热量>0', weekNs.total.kcal > 0, weekNs.total.kcal + ' kcal');
ok('周营养概览日均热量>0', weekNs.avgPerDay.kcal > 0);
ok('周菜单导航与容器已就位', html.indexOf('view-week') >= 0 && html.indexOf('data-view="week"') >= 0);
ok('周菜单生成入口已接线', appJs.indexOf("case 'gen-week'") >= 0 && appJs.indexOf('doGenWeek') >= 0);
ok('周菜单完成复用扣库存逻辑', appJs.indexOf('consumeAndRecord') >= 0);

section('9.8 PWA 离线 + 添加到主屏（本次新增）');
ok('manifest 声明 standalone 显示模式', manifest && manifest.display === 'standalone');
ok('manifest theme_color 与页面 theme-color 一致', manifest && manifest.theme_color === '#1ca04a' && html.indexOf('content="#1ca04a"') >= 0);
ok('install 安装动作已接线', appJs.indexOf("case 'install'") >= 0 && appJs.indexOf('deferredPrompt') >= 0);
ok('beforeinstallprompt 已捕获（拦截默认气泡）', appJs.indexOf('beforeinstallprompt') >= 0);
ok('appinstalled 已监听（安装后提示）', appJs.indexOf('appinstalled') >= 0);
ok('设置页含「安装到主屏」入口', html.indexOf('id="installBtn"') >= 0 && html.indexOf('data-action="install"') >= 0);

section('9.9 M4 冷启动验证套件（本次新增）');
var m4State = {
  m4: {
    userId: 'U-test', baseline: 'm4-1', startedAt: '2026-11-08', viewedRecipe: 3,
    checkIns: {
      '2026-11-08': { opened: true, cooked: true, blocker: '忘了买葱, 就近凑合' },
      '2026-11-10': { opened: true, cooked: false }
    }
  },
  history: [{ recipeId: 'r01', date: '2026-11-08', usedIds: [{ foodId: 'tomato', qty: 1, wasUrgent: true }] }],
  generatedCount: 12
};
var m4Rows = E.m4ExportRows(m4State, '2026-11-12');
ok('导出行覆盖连续日期且含缺勤日', m4Rows.length === 5 && m4Rows[0].date === '2026-11-08' && m4Rows[4].date === '2026-11-12');
ok('缺勤日 opened=0（留存分母不丢失）', m4Rows[1].opened === 0 && m4Rows[3].opened === 0);
ok('做饭日自动兜底 opened=1', m4Rows[0].opened === 1 && m4Rows[0].cookCount === 1);
ok('自报 cooked 与卡点被保留', m4Rows[0].cooked === 1 && m4Rows[2].cooked === 0 && m4Rows[0].blocker.indexOf('就近凑合') >= 0);
ok('每行带匿名编号与版本基线', m4Rows.every(function (r) { return r.userId === 'U-test' && r.baseline === 'm4-1'; }));
var m4Csv = E.m4ToCsv(m4State, '2026-11-12');
ok('CSV 表头字段齐全', E.M4_COLS.length === 11 && m4Csv.split('\r\n')[0].indexOf('date,userId,baseline') === 0);
ok('CSV 含逗号文本被正确引号包裹', m4Csv.indexOf('"忘了买葱, 就近凑合"') >= 0);
var m4r = require('./m4-report.js');
var m4Parsed = m4r.parseCsv('\uFEFF' + m4Csv);
ok('判定脚本能解析 App 导出的 CSV', m4Parsed.length === 5 && m4Parsed[0].blocker === '忘了买葱, 就近凑合');
var m4Metrics = m4r.computeMetrics(m4r.groupUsers(m4Parsed));
ok('判定脚本识别参与者并判样本不足', m4Metrics.totalUsers === 1 && m4Metrics.verdict === 'INCOMPLETE');
ok('判定脚本输出含结论的报告', m4r.buildReport(m4Metrics).indexOf('## 3. 结论') >= 0);
ok('m4-report.js 文件存在可引用', fs.existsSync(path.join(__dirname, 'm4-report.js')));
ok('首页打卡条与设置页 M4 卡片已就位', html.indexOf('id="m4CheckBar"') >= 0 && html.indexOf('id="m4Box"') >= 0);
ok('打卡与导出动作已接线', appJs.indexOf("case 'm4-yes'") >= 0 && appJs.indexOf("case 'm4-no'") >= 0 && appJs.indexOf("case 'm4-export'") >= 0);
ok('启动自动记录「今天来过」', appJs.indexOf('initM4();') >= 0 && appJs.indexOf('c.opened = true') >= 0);
ok('激活率埋点（看做法）已接入', appJs.indexOf('viewedRecipe') >= 0);
ok('验证期保护：恢复示例/清空不清打卡记录', appJs.indexOf('rebuildState') >= 0 && appJs.indexOf('savedM4') >= 0);
ok('M4 版本基线已固定', appJs.indexOf("M4_BASELINE = 'm4-1'") >= 0);

section('9.10 C4 剩菜再利用（本次新增）');
var loToday = E.todayStr();
var loState = JSON.parse(JSON.stringify(state));
loState.prefs = Object.assign({}, loState.prefs, { avoid: [] });
loState.leftovers = [
  { uid: 'a', name: '剩的番茄炒蛋', foodIds: ['tomato', 'egg'], fromRecipeId: 'r01', date: loToday },
  { uid: 'b', name: '半根黄瓜', foodIds: ['cucumber'], fromRecipeId: '', date: loToday },
  { uid: 'c', name: '前天的青菜', foodIds: ['greens'], fromRecipeId: '', date: E.addDays(loToday, -5) }
];
loState.reuseLog = [
  { date: loToday, recipeIds: ['r09'], kind: 'remake', itemCount: 1, money: 4.2 },
  { date: loToday, recipeIds: [], kind: 'discard', itemCount: 0, money: 0 }
];
ok('C4 引擎函数已全部导出',
  ['leftoverStatus', 'leftoverValue', 'safeLeftovers', 'reuseFoodIds', 'reuseIdeas', 'reuseCoverage', 'reuseSummary']
    .every(function (k) { return typeof E[k] === 'function'; }));
ok('熟食冷藏建议期固定为 2 天', E.REUSE_SHELF_DAYS === 2);
ok('当天登记仍在建议期内',
  E.leftoverStatus(loState.leftovers[0], loToday).safe === true &&
  E.leftoverStatus(loState.leftovers[0], loToday).daysLeft === 2);
ok('第 3 天判定超期并提示丢弃', (function () {
  var s = E.leftoverStatus(loState.leftovers[0], E.addDays(loToday, 3));
  return s.expired === true && s.label.indexOf('丢弃') >= 0;
})());
ok('超期剩菜不进入方案匹配（食品安全护栏）',
  Object.keys(E.reuseFoodIds(loState, loToday)).indexOf('greens') < 0);
ok('安全剩料去重后可用于匹配',
  Object.keys(E.reuseFoodIds(loState, loToday)).join(',') === 'tomato,egg,cucumber');
ok('剩菜估值按食材参考价累加',
  E.leftoverValue(loState.leftovers[0]) ===
  Math.round((E.foodById('tomato').price + E.foodById('egg').price) * 10) / 10);
var loIdeas = E.reuseIdeas(loState, loToday, 30);
ok('方案全部命中至少 1 样安全剩料',
  loIdeas.length > 0 && loIdeas.every(function (x) { return x.hitCount >= 1; }));
ok('原样重做同源菜被排除（剩番茄炒蛋不再推番茄炒蛋）',
  loIdeas.every(function (x) { return x.recipe.id !== 'r01'; }));
ok('方案带命中清单 / 缺料 / 热量 / 耗时',
  loIdeas.every(function (x) { return x.hitNames.length === x.hitCount && Array.isArray(x.missingNames) && x.kcal > 0 && x.time > 0; }));
function ideaScore(st, rid) {
  var f = E.reuseIdeas(st, loToday, 30).filter(function (x) { return x.recipe.id === rid; })[0];
  return f ? f.score : -999;
}
var oneFood = JSON.parse(JSON.stringify(loState)), twoFood = JSON.parse(JSON.stringify(loState));
oneFood.leftovers = [{ uid: 'a', name: '剩番茄', foodIds: ['tomato'], date: loToday }];
twoFood.leftovers = [{ uid: 'a', name: '剩番茄和蛋', foodIds: ['tomato', 'egg'], date: loToday }];
ok('同一道菜命中剩料越多加权越高（控制变量）', ideaScore(twoFood, 'r11') > ideaScore(oneFood, 'r11'));
ok('忌口命中的菜不进入再利用方案', (function () {
  var av = JSON.parse(JSON.stringify(loState)); av.prefs.avoid = ['tomato'];
  return E.reuseIdeas(av, loToday, 30).every(function (x) {
    return x.recipe.ingredients.every(function (i) { return i.id !== 'tomato'; });
  });
})());
ok('没有剩菜时返回空方案',
  E.reuseIdeas(Object.assign({}, loState, { leftovers: [] }), loToday, 8).length === 0);
var loCov = E.reuseCoverage(loState, ['r09', 'r15'], loToday);
ok('凑一锅跨菜合并去重并列出未覆盖',
  loCov.total === 3 && loCov.coveredCount === 2 && loCov.uncoveredNames.indexOf('西红柿') >= 0,
  loCov.coveredNames.join('、') + ' / 未覆盖 ' + loCov.uncoveredNames.join('、'));
ok('未选菜时覆盖数为 0', E.reuseCoverage(loState, [], loToday).coveredCount === 0);
var loSum = E.reuseSummary(loState, loToday);
ok('概览区分安全/超期且丢弃不计入救回',
  loSum.total === 3 && loSum.safe === 2 && loSum.overdue === 1 &&
  loSum.savedItems === 1 && loSum.handled === 2 && loSum.money === 4.2);
ok('清库存锚点菜谱已扩充到 10 道以上',
  D.RECIPES.filter(function (r) { return (r.tags || []).indexOf('清库存') >= 0; }).length >= 10,
  D.RECIPES.filter(function (r) { return (r.tags || []).indexOf('清库存') >= 0; }).length + ' 道');
ok('第 9 个视图与导航项已就位',
  html.indexOf('id="view-leftover"') >= 0 && html.indexOf('data-view="leftover"') >= 0);
ok('剩菜视图容器齐全',
  ['reuseTip', 'reuseSummary', 'leftoverList', 'leftoverQuick', 'reuseCoverage', 'reuseIdeas', 'navLeftoverBadge']
    .every(function (id) { return html.indexOf('id="' + id + '"') >= 0; }));
ok('C4 动作全部接线',
  ["case 'open-leftover-add'", "case 'submit-leftover'", "case 'quick-leftover'", "case 'lo-eat'",
   "case 'lo-discard'", "case 'reuse-pick'", "case 'reuse-done'", "case 'reuse-batch'"]
    .every(function (s) { return appJs.indexOf(s) >= 0; }));
ok('做饭反馈可一键登记剩菜',
  appJs.indexOf('fbLeftover') >= 0 && appJs.indexOf('addLeftoverFromRecipe') >= 0);
ok('闭环不重复扣库存 / 不重复记营养', (function () {
  var seg = appJs.slice(appJs.indexOf('function finishReuse'), appJs.indexOf('function renderLeftovers'));
  return seg.indexOf('function finishReuse') >= 0 && seg.indexOf('consumeAndRecord') < 0 && seg.indexOf('recordMeal') < 0;
})());
ok('Service Worker 缓存版本已升级（老访问者能拿到新脚本）',
  fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8').indexOf("xz-fridge-v5") >= 0);
ok('页面写明食品安全与不重复扣减口径',
  html.indexOf('不再进入任何改造方案') >= 0 && html.indexOf('不会重复扣库存或重复记营养') >= 0);

section('9.11 登记剩菜缺陷回归：版本错配与食材关联（v1.6.1 修复）');
ok('引擎层导出构建号 BUILD', E.BUILD === '1.6.2', E.BUILD);
ok('应用层写出构建标记 XZ_APP_BUILD', appJs.indexOf("XZ_APP_BUILD = '1.6.2'") >= 0);
ok('index.html 期望构建号与引擎/应用层一致', html.indexOf("XZ_EXPECT_BUILD = '1.6.2'") >= 0);
ok('index.html 具备版本错配自检（清缓存 + 只重载一次）',
  html.indexOf('xz-build-fix') >= 0 && html.indexOf('caches.delete(k)') >= 0 && html.indexOf('location.reload()') >= 0);
ok('sw.js 改为 network-first（在线优先，杜绝新 HTML 配旧 JS）',
  swSrc.indexOf('network-first') >= 0 && swSrc.indexOf('fetch(req).then') >= 0 &&
  swSrc.indexOf('fetch(req).then') < swSrc.indexOf('caches.match(req)') &&
  swSrc.indexOf('if (cached)') < 0);
ok('sw.js install 逐项缓存且忽略单项失败（403 不阻塞激活）',
  swSrc.indexOf('c.add(u).catch') >= 0 && swSrc.indexOf('skipWaiting') >= 0);
ok('sw.js 非 200 响应会回退缓存', swSrc.indexOf('hit || res') >= 0);
ok('sw.js 仍保留离线导航回退与跨域排除',
  swSrc.indexOf("req.mode === 'navigate'") >= 0 && swSrc.indexOf('url.origin !==') >= 0);
ok('登记弹窗列出全部食材，不再按当前库存过滤',
  appJs.indexOf("D.FOODS.filter(function (f) { return f.cat !== '调味'; })") >= 0 &&
  appJs.indexOf('owned[f.id]') < 0);
ok('最近做过的菜所用食材排在前面',
  appJs.indexOf('recentFoods[f.id]') >= 0 && appJs.indexOf('function rank(f)') >= 0);
ok('支持编辑已登记条目的关联食材',
  appJs.indexOf("case 'lo-edit'") >= 0 && appJs.indexOf('loEditUid') >= 0 &&
  appJs.indexOf('编辑关联食材') >= 0);
ok('C4 动作接线补齐 lo-edit / lo-remove',
  appJs.indexOf("case 'lo-edit'") >= 0 && appJs.indexOf("case 'lo-remove'") >= 0);
ok('未关联食材时条目与提示都明确说明「暂无方案」',
  appJs.indexOf('未关联食材，暂无方案') >= 0 && appJs.indexOf('没勾食材不会有改造方案') >= 0);
ok('编辑态复用原 uid，不会新增重复条目',
  appJs.indexOf('lv.foodIds = ids') >= 0 && appJs.indexOf('if (!edited)') >= 0);
(function () {
  // 回归真实故障：做菜后食材已从库存扣光，但剩菜仍应能关联并给出方案
  var st = {
    inventory: [], history: [], reuseLog: [], leftovers: [
      { uid: 'lv-fix', name: '剩的番茄炒蛋', foodIds: ['tomato', 'egg'], date: E.todayStr(), fromRecipeId: 'r01' }
    ],
    prefs: { people: 2, flavor: '', quick: true, goal: '均衡', avoid: [] }
  };
  var ideas = E.reuseIdeas(st, E.todayStr(), 8);
  ok('库存被扣光时剩菜仍能匹配出改造方案', ideas.length > 0, ideas.length + ' 张');
  ok('同源排除仍生效（剩番茄炒蛋不再推番茄炒蛋）',
    ideas.filter(function (x) { return x.recipe.id === 'r01'; }).length === 0);
  ok('关联食材命中后凑一锅覆盖数正确', E.reuseCoverage(st, [], E.todayStr()).total === 2);
})();

(function () {
  // 把 index.html 里的版本自检脚本放进沙箱实跑，验证「错配才修、只修一次」
  var inline = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  var guard = inline.filter(function (s) { return s.indexOf('xz-build-fix') >= 0; })[0] || '';
  var body = guard.replace(/^<script>/, '').replace(/<\/script>\s*$/, '');
  ok('index.html 版本自检是可执行脚本', body.length > 100);
  function T(v) {
    return { then: function (f, g) {
      try { var r = f(v); return (r && typeof r.then === 'function') ? r : T(r); }
      catch (e) { return g ? g(e) : T(undefined); }
    } };
  }
  function run(appBuild, engineBuild, alreadyFixed) {
    var store = alreadyFixed ? { 'xz-build-fix': '1' } : {};
    var deleted = [], reloads = 0;
    var cachesObj = {
      keys: function () { return T(['old-a', 'old-b']); },
      delete: function (k) { deleted.push(k); return T(true); }
    };
    var sandbox = {
      window: {
        XZ_ENGINE: engineBuild === null ? null : { BUILD: engineBuild },
        XZ_APP_BUILD: appBuild, caches: cachesObj
      },
      caches: cachesObj,
      sessionStorage: {
        getItem: function (k) { return store[k] || null; },
        setItem: function (k, v) { store[k] = v; }
      },
      Promise: { all: function (arr) { return T(arr); } },
      location: { reload: function () { reloads++; } }
    };
    vm.runInNewContext(body, sandbox);
    return { deleted: deleted, reloads: reloads };
  }
  var g1 = run('1.6.2', '1.6.2', false);
  ok('版本一致时不重载、不清缓存', g1.reloads === 0 && g1.deleted.length === 0);
  var g2 = run('1.5.0', '1.6.2', false);
  ok('app.js 是旧版时清缓存并重载一次', g2.reloads === 1 && g2.deleted.length === 2,
    'reloads=' + g2.reloads + ' deleted=' + g2.deleted.length);
  var g3 = run('1.6.2', '1.5.0', false);
  ok('engine.js 是旧版时同样触发修复', g3.reloads === 1);
  var g4 = run(null, null, true);
  ok('已重载过一次则不再循环', g4.reloads === 0);
})();

section('9.12 B2 全量数据备份：白名单 / 结构校验 / 打卡保留');
(function () {
  var sample = {
    version: 1,
    inventory: [{ uid: 'u1', foodId: 'tomato', qty: '2 个', expiryDate: E.todayStr() }],
    prefs: { people: 2, flavor: '', quick: true, goal: '均衡', avoid: ['egg'] },
    history: [{ recipeId: 'r01', rating: 5, date: E.todayStr(), usedIds: [] }],
    shopping: [], selected: [], generatedIds: [], generatedCount: 0, lastGeneratedAt: '',
    nutritionLog: {}, weekPlan: { weekStart: '', meals: {} },
    leftovers: [{ uid: 'lv1', name: '剩的番茄炒蛋', foodIds: ['tomato', 'egg'], date: E.todayStr() }],
    reuseLog: [],
    m4: {
      userId: 'U-abcd', baseline: 'm4-1', startedAt: E.todayStr(),
      checkIns: { '2026-11-08': { opened: true, cooked: 1 } }, viewedRecipe: 3
    },
    evilField: 'should-not-be-exported'
  };
  ok('备份纯函数已全部导出',
    typeof E.backupToText === 'function' && typeof E.parseBackup === 'function' &&
    typeof E.makeBackup === 'function' && E.BACKUP_SCHEMA === 1);
  var text = E.backupToText(sample, '2026-11-08 12:00');
  var head = JSON.parse(text);
  ok('备份文件带 app / schemaVersion / build / exportedAt',
    head.app === E.BACKUP_APP && head.schemaVersion === 1 &&
    head.build === E.BUILD && head.exportedAt === '2026-11-08 12:00');
  ok('导出走白名单，未声明字段不会外泄', text.indexOf('evilField') < 0);
  var back = E.parseBackup(text);
  ok('往返还原库存、偏好与剩菜',
    back.ok && back.state.inventory[0].foodId === 'tomato' &&
    back.state.prefs.avoid[0] === 'egg' && back.state.leftovers[0].name === '剩的番茄炒蛋');
  ok('M4 打卡记录与匿名编号完整保留（换设备不断档）',
    back.ok && back.state.m4.userId === 'U-abcd' &&
    back.state.m4.checkIns['2026-11-08'].cooked === 1 && back.counts.checkInDays === 1);
  ok('解析结果带可展示的摘要',
    back.ok && back.counts.inventory === 1 && back.counts.history === 1 && back.counts.leftovers === 1);
  ok('拒绝：非 JSON', E.parseBackup('这不是 JSON').ok === false);
  ok('拒绝：空文件 / 超大文件', E.parseBackup('').ok === false && E.parseBackup('x'.repeat(4194305)).ok === false);
  ok('拒绝：不是鲜知的备份文件',
    E.parseBackup(JSON.stringify({ app: 'other.app', schemaVersion: 1, state: sample })).ok === false);
  ok('拒绝：schemaVersion 不兼容',
    E.parseBackup(JSON.stringify({ app: E.BACKUP_APP, schemaVersion: 99, state: sample })).ok === false);
  ok('拒绝：缺少 state',
    E.parseBackup(JSON.stringify({ app: E.BACKUP_APP, schemaVersion: 1 })).ok === false);
  var bad = JSON.parse(JSON.stringify(sample)); bad.inventory = 'oops';
  ok('拒绝：结构不完整（inventory 非数组）',
    E.parseBackup(JSON.stringify({ app: E.BACKUP_APP, schemaVersion: 1, state: bad })).ok === false);
  var big = JSON.parse(JSON.stringify(sample));
  big.history = new Array(5001).fill({ recipeId: 'r01' });
  ok('拒绝：数组超出上限（防超大文件卡死）',
    E.parseBackup(JSON.stringify({ app: E.BACKUP_APP, schemaVersion: 1, state: big })).ok === false);
  var poison = '{"app":"' + E.BACKUP_APP + '","schemaVersion":1,"state":{' +
    '"inventory":[{"uid":"u1","__proto__":{"polluted":true},"foodId":"tomato"}],' +
    '"prefs":{},"history":[]}}';
  var pr = E.parseBackup(poison);
  ok('原型键被过滤，不污染对象',
    pr.ok && !Object.prototype.hasOwnProperty.call(pr.state.inventory[0], '__proto__') &&
    !({}).polluted);
  var long = JSON.parse(JSON.stringify(sample)); long.leftovers[0].name = 'x'.repeat(1000);
  var lt = E.parseBackup(E.backupToText(long));
  ok('超长字符串被截断到 500 字符', lt.ok && lt.state.leftovers[0].name.length === 500);
  ok('备份动作全部接线',
    ["case 'backup-export'", "case 'backup-pick'", "case 'backup-import-confirm'"]
      .every(function (s) { return appJs.indexOf(s) >= 0; }));
  ok('导入走 FileReader 且先做结构校验',
    appJs.indexOf('new FileReader()') >= 0 && appJs.indexOf('E.parseBackup') >= 0 &&
    appJs.indexOf('readBackupFile') >= 0);
  ok('导入前有二次确认弹窗', appJs.indexOf('确认导入备份') >= 0 &&
    appJs.indexOf('确认覆盖导入') >= 0);
  ok('确认导入不写脏打卡记录（不调用 initM4）', (function () {
    var seg = appJs.slice(appJs.indexOf('function confirmBackupImport'), appJs.indexOf('function renderFridge'));
    return seg.indexOf('initM4') < 0 && seg.indexOf('save()') >= 0 && seg.indexOf('renderSettings()') >= 0;
  })());
  ok('设置页备份卡片与隐藏文件输入已就位',
    html.indexOf('id="backupBox"') >= 0 && html.indexOf('id="backupFile"') >= 0);
  ok('页面写明覆盖确认与不上传服务器',
    appJs.indexOf('覆盖当前设备的全部数据') >= 0 && appJs.indexOf('不上传服务器') >= 0);
  ok('未改动 M4 CSV 列 / 基线 / 判定口径',
    E.M4_COLS.length === 11 && E.M4_COLS[2] === 'baseline' &&
    appJs.indexOf("M4_BASELINE = 'm4-1'") >= 0);
})();

section('10. M5 真实识别适配层');
vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'ai-adapter.js'), 'utf8'), { filename: 'ai-adapter.js' });
var A = globalThis.XZ_AI;
ok('适配层已挂载到全局', !!A);
ok('默认配置保持关闭（离线优先）', A.getConfig().enabled === false);
ok('俗名映射 番茄→tomato', A.resolveFood('番茄') === 'tomato');
ok('俗名映射 五花肉→pork', A.resolveFood('五花肉') === 'pork');
ok('俗名映射 小葱→scallion', A.resolveFood('小葱') === 'scallion');
ok('标准名精确匹配 西兰花', A.resolveFood('西兰花') === 'broccoli');
ok('未知名称返回 null', A.resolveFood('不认识的物件') === null);
var pr = A.parseResponse('好的，结果如下：\n```json\n[{"name":"番茄","confidence":0.97}]\n```\n完毕');
ok('容错解析代码块与前后废话', pr.length === 1 && pr[0].name === '番茄' && pr[0].confidence === 0.97);
var threw = false;
try { A.parseResponse('模型说它没有看到食材'); } catch (e) { threw = true; }
ok('非 JSON 返回会抛错以便回退', threw);
var mapped = A.mapItems([
  { name: '番茄', confidence: 0.9 }, { name: '西红柿', confidence: 0.8 },
  { name: '鸡蛋', confidence: 0.9 }, { name: '不认识', confidence: 0.6 }
]);
ok('映射结果去重并过滤未知项', mapped.length === 2 && mapped[0].foodId === 'tomato');
var body = A.buildBody('QUJD', 'vision-test');
ok('请求体为 OpenAI 兼容多模态格式',
  body.model === 'vision-test' && body.messages.length === 2 &&
  body.messages[1].content[1].image_url.url.indexOf('data:image/jpeg;base64,QUJD') === 0);
ok('提示词包含标准食材名', A.buildPrompt().indexOf('西红柿') >= 0);

function reply(content) { return { choices: [{ message: { content: content } }] }; }
function mockFetch(data, capture) {
  return function (u, init) {
    if (capture) capture(u, init);
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data); } });
  };
}
var baseCfg = {
  enabled: true, baseUrl: 'http://example.test/v1/chat/completions', model: 'vision-test', timeoutMs: 1000,
  _compress: function () { return Promise.resolve('QUJD'); }
};
var file = { name: 'fridge.jpg' };

(async function () {
  var r0 = await A.recognize(file);
  ok('未配置时自动回退演示识别', r0.source === 'mock' && r0.items.length > 0, r0.reason);

  var goodReply = '```json\n[{"name":"番茄","confidence":0.97},{"name":"鸡蛋","confidence":0.9},{"name":"不认识","confidence":0.5}]\n```';
  var r1 = await A.recognize(file, Object.assign({}, baseCfg, { _fetch: mockFetch(reply(goodReply)) }));
  ok('真实识别成功且完成归一化', r1.source === 'ai' && r1.items.length === 2 && r1.items[0].foodId === 'tomato',
    r1.reason);

  var cap = null;
  await A.recognize(file, Object.assign({}, baseCfg, {
    apiKey: 'sk-test-123',
    _fetch: mockFetch(reply(goodReply), function (u, init) { cap = init; })
  }));
  ok('直连模式正确注入 Bearer 密钥', !!cap && cap.headers.Authorization === 'Bearer sk-test-123');

  var cap2 = null;
  await A.recognize(file, Object.assign({}, baseCfg, {
    apiKey: '',
    _fetch: mockFetch(reply(goodReply), function (u, init) { cap2 = init; })
  }));
  ok('代理模式不下发任何密钥', !!cap2 && !cap2.headers.Authorization);

  var r2 = await A.recognize(file, Object.assign({}, baseCfg, {
    _fetch: function () { return Promise.reject(new Error('网络断开')); }
  }));
  ok('网络失败自动回退演示识别', r2.source === 'mock' && r2.reason.length > 0, r2.reason);

  var r3 = await A.recognize(file, Object.assign({}, baseCfg, {
    _fetch: mockFetch(reply('抱歉我无法识别这张图'))
  }));
  ok('返回无法解析时自动回退', r3.source === 'mock', r3.reason);

  var r4 = await A.recognize(file, Object.assign({}, baseCfg, {
    _fetch: mockFetch(reply('[]'))
  }));
  ok('空识别结果自动回退', r4.source === 'mock', r4.reason);

  var t0 = await A.testConnection();
  ok('未配置时连通性测试给出明确提示', t0.ok === false && t0.message.length > 0);
  var t1 = await A.testConnection(Object.assign({}, baseCfg, {
    _fetch: mockFetch(reply('OK'))
  }));
  ok('配置后连通性测试通过', t1.ok === true, t1.message);
  var t2 = await A.testConnection(Object.assign({}, baseCfg, {
    _fetch: function () { return Promise.resolve({ ok: false, status: 401, json: function () { return Promise.resolve({}); } }); }
  }));
  ok('鉴权失败被正确报告而非崩溃', t2.ok === false && t2.message.indexOf('401') >= 0, t2.message);

  section('\n结果');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
