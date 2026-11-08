/* ============================================================
 * m4-report.js —— M4 冷启动验证判定脚本（零依赖 Node）
 *
 * 用法：
 *   node m4-report.js 参与人A.csv 参与人B.csv ... [--out 报告.md]
 *   node m4-report.js --selftest        # 用合成数据校验计算逻辑
 *
 * 只读取本地 CSV，不联网、不上传。判定口径对齐 PRD §11 / §13：
 *   7 日留存 ≥ 25% 且 推荐采纳率 ≥ 20%  → 继续投入，否则回到定位重做。
 * ============================================================ */
'use strict';
var fs = require('fs');

/* ---------- CSV 解析（支持 BOM / CRLF / 引号包裹 / 转义双引号） ---------- */
function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  var rows = [], row = [], cur = '', quoted = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
      } else { cur += ch; }
    } else if (ch === '"') { quoted = true; }
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(function (x) { return x !== ''; })) rows.push(row);
      row = [];
    } else { cur += ch; }
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    if (row.some(function (x) { return x !== ''; })) rows.push(row);
  }
  if (!rows.length) return [];
  var head = rows.shift().map(function (h) { return h.trim(); });
  return rows.map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
}

/* ---------- 工具 ---------- */
function addDays(iso, n) {
  var d = new Date(String(iso) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : 0; }
function last(rows) { return rows.length ? rows[rows.length - 1] : {}; }

function groupUsers(rows) {
  var map = {};
  rows.forEach(function (r) {
    var id = r.userId || 'unknown';
    if (!map[id]) map[id] = { userId: id, baseline: r.baseline || '', startedAt: r.startedAt || r.date, rows: [] };
    map[id].rows.push(r);
  });
  return Object.keys(map).map(function (k) {
    map[k].rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return map[k];
  });
}

/* ---------- 指标计算 ---------- */
function computeMetrics(users) {
  var total = users.length;
  function dateExists(u, date) {
    return u.rows.some(function (r) { return r.date === date; });
  }
  function openedOn(u, date) {
    return u.rows.some(function (r) { return r.date === date && num(r.opened) === 1; });
  }
  // 只有导出覆盖到该日期的用户才纳入分母，避免把「还没到 D7」误算成流失
  var d1Eligible = users.filter(function (u) { return dateExists(u, addDays(u.startedAt, 1)); });
  var d7Eligible = users.filter(function (u) { return dateExists(u, addDays(u.startedAt, 7)); });
  var d1 = d1Eligible.filter(function (u) { return openedOn(u, addDays(u.startedAt, 1)); }).length;
  var d7 = d7Eligible.filter(function (u) { return openedOn(u, addDays(u.startedAt, 7)); }).length;

  var cooks = 0, generated = 0, urgent = 0, userDays = 0, activated = 0;
  var blockers = [], baselines = {};
  users.forEach(function (u) {
    baselines[u.baseline] = true;
    var fin = last(u.rows);
    cooks += u.rows.reduce(function (s, r) { return s + num(r.cookCount); }, 0);
    generated += num(fin.generatedCount);
    urgent += num(fin.urgentSaved);
    userDays += u.rows.length;
    if (num(fin.viewedRecipe) > 0 && num(fin.generatedCount) > 0) activated++;
    u.rows.forEach(function (r) {
      if (r.blocker && String(r.blocker).trim()) blockers.push({ userId: u.userId, date: r.date, text: String(r.blocker).trim() });
    });
  });

  var d1Rate = pct(d1, d1Eligible.length);
  var d7Rate = pct(d7, d7Eligible.length);
  var adoptRate = pct(cooks, generated);
  var activateRate = pct(activated, total);
  var urgentPerWeek = userDays ? Math.round(urgent / userDays * 7 * 10) / 10 : 0;
  var maxDays = users.reduce(function (m, u) { return Math.max(m, u.rows.length); }, 0);

  // 护栏：自报卡点里出现忌口/过敏/误推等关键词，必须人工复核
  var guardKw = /忌口|过敏|误推|识别错|推了.*不吃|吃不了/;
  var guardHits = blockers.filter(function (b) { return guardKw.test(b.text); });

  var sampleOk = total >= 20 && maxDays >= 14 && d7Eligible.length >= 20;
  var pass = d7Rate >= 25 && adoptRate >= 20;

  return {
    totalUsers: total, maxDays: maxDays, userDays: userDays,
    d1Eligible: d1Eligible.length, d7Eligible: d7Eligible.length,
    d1: d1, d7: d7, d1Rate: d1Rate, d7Rate: d7Rate,
    cooks: cooks, generated: generated, adoptRate: adoptRate,
    activated: activated, activateRate: activateRate,
    urgent: urgent, urgentPerWeek: urgentPerWeek,
    baselines: Object.keys(baselines), baselineConsistent: Object.keys(baselines).length <= 1,
    blockers: blockers, guardHits: guardHits,
    sampleOk: sampleOk, pass: pass,
    verdict: !sampleOk ? 'INCOMPLETE' : (pass ? 'GO' : 'NO-GO')
  };
}

/* ---------- 报告生成 ---------- */
function buildReport(m) {
  function badge(ok) { return ok ? '达标' : '未达标'; }
  var L = [];
  L.push('# 鲜知 · 冰箱大脑 — M4 冷启动验证报告');
  L.push('');
  L.push('> 由 `m4-report.js` 依据参与者导出的 CSV 自动汇总，判定口径见 PRD §11 / §13。');
  L.push('');
  L.push('## 1. 数据概况');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('|----|----|');
  L.push('| 参与者 | ' + m.totalUsers + ' 人 |');
  L.push('| 最长参与天数 | ' + m.maxDays + ' 天 |');
  L.push('| 累计人天 | ' + m.userDays + ' |');
  L.push('| 版本基线 | ' + (m.baselines.join(', ') || '（缺失）') + (m.baselineConsistent ? '（一致）' : '（**不一致，数据不可比**）') + ' |');
  L.push('| 可评估 D1 / D7 的用户 | ' + m.d1Eligible + ' / ' + m.d7Eligible + ' |');
  L.push('');
  L.push('## 2. 核心指标');
  L.push('');
  L.push('| 指标 | 结果 | 目标 | 判定 |');
  L.push('|------|------|------|------|');
  L.push('| 次日留存 | ' + m.d1Rate + '%（' + m.d1 + '/' + m.d1Eligible + '） | ≥ 40% | ' + badge(m.d1Rate >= 40) + ' |');
  L.push('| **7 日留存** | **' + m.d7Rate + '%**（' + m.d7 + '/' + m.d7Eligible + '） | **≥ 25%** | **' + badge(m.d7Rate >= 25) + '** |');
  L.push('| **推荐采纳率** | **' + m.adoptRate + '%**（' + m.cooks + '/' + m.generated + '） | **≥ 20%** | **' + badge(m.adoptRate >= 20) + '** |');
  L.push('| 激活率（生成→看做法） | ' + m.activateRate + '%（' + m.activated + '/' + m.totalUsers + '） | ≥ 70% | ' + badge(m.activateRate >= 70) + ' |');
  L.push('| 人均每周临期食材消耗 | ' + m.urgentPerWeek + ' 样 | ≥ 2 样 | ' + badge(m.urgentPerWeek >= 2) + ' |');
  L.push('');
  L.push('## 3. 结论');
  L.push('');
  if (m.verdict === 'INCOMPLETE') {
    L.push('**数据不足，结论暂不成立。** 需要 ≥20 人、每人 ≥14 天且导出覆盖 D7 才能判定。当前：' +
      m.totalUsers + ' 人 / 最长 ' + m.maxDays + ' 天 / 可评估 D7 ' + m.d7Eligible + ' 人。');
  } else if (m.verdict === 'GO') {
    L.push('**GO — 继续投入。** 7 日留存与推荐采纳率双双达到阈值，说明「用户会真的每天打开用」这一核心假设成立。');
  } else {
    L.push('**NO-GO — 回到定位重做。** 未同时达到 7 日留存 ≥25% 与采纳率 ≥20%。' +
      '按 PRD §13 第 6 条，优先怀疑「录入成本太高」而非「推荐不准」，先试一键拍照 + 免确认。');
  }
  if (!m.baselineConsistent) {
    L.push('');
    L.push('> ⚠️ 参与者版本基线不一致，说明验证期间发过新版。本次结果不可比，建议冻结版本后重跑。');
  }
  L.push('');
  L.push('## 4. 护栏与卡点');
  L.push('');
  L.push('- 自报卡点共 ' + m.blockers.length + ' 条；命中忌口/过敏/误推等护栏关键词 **' + m.guardHits.length + ' 条**（护栏指标高于增长指标，须逐条人工复核）。');
  if (m.guardHits.length) {
    m.guardHits.slice(0, 20).forEach(function (b) {
      L.push('  - `' + b.userId + '` ' + b.date + '：' + b.text.replace(/\|/g, '／'));
    });
  }
  if (m.blockers.length && !m.guardHits.length) {
    L.push('- 卡点样例（前 5 条，用于定位体验问题）：');
    m.blockers.slice(0, 5).forEach(function (b) {
      L.push('  - `' + b.userId + '` ' + b.date + '：' + b.text.replace(/\|/g, '／'));
    });
  }
  L.push('');
  L.push('## 5. 口径说明');
  L.push('');
  L.push('- D1 = 首次打开次日；D7 = 首次打开后第 7 天。仅当该用户的导出覆盖到该日期才计入分母。');
  L.push('- 采纳率 = 全部「我做了」次数 / 各用户累计推荐展示数之和（取每人最后一天的快照，避免重复累加）。');
  L.push('- 激活率 = 生成过推荐且点开过菜谱详情的用户占比。');
  L.push('- 人均每周临期消耗 = 累计临期拯救数 / 累计人天 × 7。');
  L.push('- 忌口误推率与识别投诉无法自动采集，需结合自报卡点人工判定，0 容忍。');
  L.push('');
  return L.join('\n');
}

/* ---------- 自测 ---------- */
function selftest() {
  var pass = 0, fail = 0;
  function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  [通过] ' + name); }
    else { fail++; console.log('  [失败] ' + name + (extra ? ' — ' + extra : '')); }
  }
  console.log('M4 判定脚本自测');

  // CSV 解析：BOM + CRLF + 含逗号/引号的卡点文本
  var csv = '\uFEFFdate,userId,baseline,startedAt,opened,cooked,cookCount,viewedRecipe,generatedCount,urgentSaved,blocker\r\n' +
    '2026-11-08,U-a,m4-1,2026-11-08,1,1,1,2,6,3,"忘了买葱, 就近凑合"\r\n' +
    '2026-11-09,U-a,m4-1,2026-11-08,0,,,2,6,3,\r\n';
  var parsed = parseCsv(csv);
  ok('CSV 解析去掉 BOM 与 CRLF', parsed.length === 2 && parsed[0].date === '2026-11-08');
  ok('CSV 引号内的逗号不被拆列', parsed[0].blocker === '忘了买葱, 就近凑合', parsed[0].blocker);
  ok('缺勤日 opened=0 且 cooked 为空', parsed[1].opened === '0' && parsed[1].cooked === '');

  // 构造 20 人 × 14 天：10 人 D7 仍打开、12 道菜 / 60 次推荐 → 留存 50%、采纳率 20%
  var rows = [];
  for (var u = 0; u < 20; u++) {
    var id = 'U-' + u;
    for (var d = 0; d < 14; d++) {
      var opened = (d === 0 || d === 1 || (u < 10 && d === 7)) ? 1 : 0;
      rows.push({
        date: addDays('2026-11-08', d), userId: id, baseline: 'm4-1', startedAt: '2026-11-08',
        opened: opened, cooked: d === 0 ? 1 : '', cookCount: (d === 0 && u < 12) ? 1 : 0,
        viewedRecipe: 2, generatedCount: 3, urgentSaved: 1, blocker: ''
      });
    }
  }
  var m = computeMetrics(groupUsers(rows));
  ok('识别 20 位参与者', m.totalUsers === 20);
  ok('最长参与 14 天', m.maxDays === 14);
  ok('D1 留存 100%（全员次日打开）', m.d1Rate === 100, String(m.d1Rate));
  ok('D7 留存 50%（10/20）', m.d7Rate === 50, String(m.d7Rate));
  ok('采纳率 20%（12/60）', m.adoptRate === 20, String(m.adoptRate));
  ok('激活率 100%', m.activateRate === 100);
  ok('样本充分 → 结论成立', m.sampleOk === true);
  ok('达标 → GO', m.verdict === 'GO', m.verdict);

  // 不达标场景
  var bad = computeMetrics(groupUsers(rows.map(function (r) {
    var c = Object.assign({}, r); c.opened = c.date === '2026-11-08' ? 1 : 0; return c;
  })));
  ok('全流失 → NO-GO', bad.verdict === 'NO-GO', bad.verdict);
  ok('D7 留存降为 0', bad.d7Rate === 0, String(bad.d7Rate));

  // 样本不足 / 版本不一致
  var few = computeMetrics(groupUsers(rows.filter(function (r) { return r.userId === 'U-0'; })));
  ok('样本不足 → INCOMPLETE', few.verdict === 'INCOMPLETE', few.verdict);
  var mixed = computeMetrics(groupUsers(rows.map(function (r) {
    var c = Object.assign({}, r); if (c.userId === 'U-0') c.baseline = 'm4-2'; return c;
  })));
  ok('版本基线不一致被检出', mixed.baselineConsistent === false);
  ok('报告含版本不一致警告', buildReport(mixed).indexOf('版本基线不一致') >= 0);

  // 护栏关键词
  var guard = computeMetrics(groupUsers(rows.map(function (r) {
    var c = Object.assign({}, r); if (c.userId === 'U-0' && c.date === '2026-11-08') c.blocker = '忌口食材被推了'; return c;
  })));
  ok('护栏关键词被识别', guard.guardHits.length === 1, String(guard.guardHits.length));

  console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  return fail === 0;
}

/* ---------- 命令入口 ---------- */
function main(argv) {
  if (argv.indexOf('--selftest') >= 0) { process.exit(selftest() ? 0 : 1); }
  var outIdx = argv.indexOf('--out');
  var outFile = outIdx >= 0 ? argv[outIdx + 1] : '';
  var files = argv.filter(function (a, i) {
    return a !== '--out' && i !== outIdx + 1 && /\.csv$/i.test(a);
  });
  if (!files.length) {
    console.log('用法：node m4-report.js <参与者1.csv> [参与者2.csv ...] [--out 报告.md]');
    console.log('      node m4-report.js --selftest');
    console.log('\nCSV 由 App「设置 → M4 冷启动验证 → 导出验证数据 CSV」生成。');
    process.exit(1);
  }
  var all = [];
  files.forEach(function (f) {
    if (!fs.existsSync(f)) { console.error('找不到文件：' + f); process.exit(1); }
    var rows = parseCsv(fs.readFileSync(f, 'utf8'));
    console.error('读入 ' + f + '：' + rows.length + ' 行');
    all = all.concat(rows);
  });
  var metrics = computeMetrics(groupUsers(all));
  var report = buildReport(metrics);
  if (outFile) { fs.writeFileSync(outFile, report, 'utf8'); console.log('报告已写入：' + outFile); }
  console.log('\n' + report);
  console.log('\n结论：' + metrics.verdict);
}

module.exports = { parseCsv: parseCsv, addDays: addDays, groupUsers: groupUsers, computeMetrics: computeMetrics, buildReport: buildReport, selftest: selftest };
if (require.main === module) main(process.argv.slice(2));
