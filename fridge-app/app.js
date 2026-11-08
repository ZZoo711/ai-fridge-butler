/* ============================================================
 * app.js —— 应用层（状态 / 渲染 / 交互）
 * 理由与结构：
 *  1) 单一状态对象 S + localStorage 持久化，刷新不丢数据，无需后端；
 *  2) 所有视图都是「从 S 重新渲染」的纯渲染函数，避免出现界面与数据不同步；
 *  3) 全局事件委托，按钮用 data-action 声明行为，检查时一眼能定位；
 *  4) 「做饭反馈」会真的扣减库存，让闭环真的转起来，而不是只做展示。
 * ============================================================ */
(function () {
  'use strict';

  // 构建标记：index.html 会核对，防止 Service Worker 旧缓存把新页面与旧脚本混在一起
  window.XZ_APP_BUILD = '1.6.2';

  var D = window.XZ_DATA;
  var E = window.XZ_ENGINE;
  var A = window.XZ_AI;        // M5 可插拔识别层（未配置时自动回退模拟）
  var KEY = 'xianzhi.fridge.v1';
  var M4_BASELINE = 'm4-1';    // M4 验证期版本基线：验证期间不得改动，否则前后数据不可比

  var S = null;                 // 全局状态
  var currentView = 'home';
  var filterCat = '全部';
  var lastRecommend = [];      // 最近一次推荐结果
  var scanCandidates = [];     // 拍照识别候选
  var lastScanSource = 'mock'; // 最近一次识别来源：ai / mock
  var lastScanReason = '';
  var modalRating = 5;         // 反馈星级（临时）
  var pendingRecipeId = null;  // 当前打开的菜谱
  var nutMonth = '';           // 营养视图当前查看的月份，空字符串=本月
  var pendingWeekDay = 0;       // 周菜单加菜选择器暂存：目标日（0~6）
  var pendingWeekSlot = 'dinner'; // 周菜单加菜选择器暂存：目标餐次
  var DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var SLOT_NAMES = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };
  function todayWeekday() { return (new Date().getDay() + 6) % 7; } // 周一=0
  var deferredPrompt = null;   // PWA 安装提示（beforeinstallprompt 捕获）
  var reusePicked = [];        // C4「凑一锅」当前勾选的菜谱 id（会话内临时，不持久化）


  /* ---------- 工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function ic(n) { return '<svg><use href="#i-' + n + '"></use></svg>'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function shiftMonth(ym, delta) {
    var p = String(ym).split('-');
    var d = new Date(+p[0], (+p[1]) - 1 + delta, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* 隐私模式下静默降级 */ } }
  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = ic('check') + '<span>' + esc(msg) + '</span>';
    $('toastRoot').appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }
  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
    // file:// 下 clipboard API 可能不可用，因此保留 execCommand 兜底
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, function () { fallback(); toast(okMsg); });
    } else { fallback(); toast(okMsg); }
  }

  /* ---------- 状态初始化 ---------- */
  function defaultState() {
    return {
      version: 1,
      inventory: [],
      prefs: { people: 2, flavor: '', quick: true, goal: '均衡', avoid: [], remind: true },
      history: [],
      shopping: [],
      selected: [],        // 已加入清单的菜谱 id
      generatedIds: [],
      generatedCount: 0,
      lastGeneratedAt: '',
      nutritionLog: {},    // 营养日志：{ 'YYYY-MM-DD': { meals:[...], totals:{...} } }
      weekPlan: { weekStart: '', meals: {} }, // 周菜单：{ weekStart:'YYYY-MM-DD'(周一), meals:{ '0':{breakfast,lunch,dinner} } }
      // C4 剩菜盒：与生鲜库存分开，避免二次扣库存；reuseLog 只记「救回了几份」
      leftovers: [],           // [{ uid, name, foodIds[], fromRecipeId, date, note }]
      reuseLog: [],            // [{ date, recipeIds[], kind, itemCount, money }]
      // M4 冷启动验证：匿名编号 + 版本基线 + 每日打卡。只存本机，不含任何身份信息
      m4: { userId: '', baseline: M4_BASELINE, startedAt: '', checkIns: {}, viewedRecipe: 0 }
    };
  }
  function seedState() {
    var st = defaultState();
    st.inventory = D.SEED.map(function (x) {
      return { uid: uid(), foodId: x.foodId, qty: x.qty, expiryDate: E.addDays(E.todayStr(), x.leftDays) };
    });
    return st;
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var obj = JSON.parse(raw);
        if (obj && obj.inventory) {
          var base = defaultState();
          S = Object.assign(base, obj);
          S.prefs = Object.assign(base.prefs, obj.prefs || {}); // 兼容旧版本数据结构
          return;
        }
      }
    } catch (e) {}
    S = seedState();
    save();
  }

  /* ---------- M4 验证：匿名编号 / 版本基线 / 每日「打开」埋点 ----------
   * 只记录「有没有打开」「有没有照着做」「卡在哪」，不采集任何身份信息。
   * opened 是幂等的：重复打开只置 true，不会覆盖用户已填的 cooked / blocker。 */
  function initM4() {
    var base = defaultState().m4;
    S.m4 = Object.assign(base, S.m4 || {});
    S.m4.checkIns = S.m4.checkIns || {};
    if (!S.m4.userId) S.m4.userId = 'U-' + uid();
    if (!S.m4.startedAt) S.m4.startedAt = E.todayStr();
    if (!S.m4.baseline) S.m4.baseline = M4_BASELINE;
    if (typeof S.m4.viewedRecipe !== 'number') S.m4.viewedRecipe = 0;
    var d = E.todayStr();
    var c = S.m4.checkIns[d] || {};
    c.opened = true;
    S.m4.checkIns[d] = c;
    save();
  }
  // 验证期保护：「恢复示例 / 清空数据」不该把 14 天的打卡记录一起清掉
  function rebuildState(useSeed) {
    var savedM4 = S.m4;
    S = useSeed ? seedState() : defaultState();
    if (savedM4) S.m4 = savedM4;
    initM4();
  }

  /* ---------- 视图切换 ---------- */
  function switchView(v) {
    currentView = v;
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) views[i].classList.remove('active');
    var target = $('view-' + v);
    if (target) target.classList.add('active');
    var items = document.querySelectorAll('.nav-item');
    for (var j = 0; j < items.length; j++) items[j].classList.toggle('active', items[j].getAttribute('data-view') === v);
    if (v === 'settings') renderSettings();
    if (v === 'plan') renderPlan(); // 进页面即重渲染，杜绝看到过期缓存
    if (v === 'week') renderWeekPlan();
    if (v === 'nutrition') renderNutrition();
    if (v === 'leftover') renderLeftovers();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- 推荐结果刷新 ----------
   * 原实现只在「生成 / 保存偏好 / 做饭反馈」重算 lastRecommend。
   * 用户手动添加、拍照入库、删除、清理过期后，计划页仍展示旧结果 ——
   * 这正是「新加的临期食材不出现在今晚吃什么」的主因。
   * 现在所有会改变库存或偏好的操作统一走这里，且不累加生成次数。 */
  function refreshRecommend() {
    lastRecommend = E.recommend(S, 6);
    return lastRecommend;
  }

  /* ---------- 推荐动作 ---------- */
  function generate() {
    if (!S.inventory.length) { toast('冰箱是空的，先添加几样食材吧'); switchView('fridge'); return; }
    refreshRecommend();
    if (!lastRecommend.length) { toast('没有匹配的菜谱，试着放宽偏好或加几样食材'); return; }
    S.generatedIds = lastRecommend.map(function (x) { return x.recipe.id; });
    S.generatedCount += lastRecommend.length;
    S.lastGeneratedAt = E.todayStr();
    save();
    switchView('plan');
    renderPlan(); renderHome(); updateBadges();
    toast('已按「临期优先」生成 ' + lastRecommend.length + ' 道菜');
  }

  /* ============================================================
   * 渲染：概览
   * ============================================================ */
  /* 临期口径与引擎一致：剩余 ≤7 天（含已过期），不再只算 ≤3 天 */
  function urgentItems() { return E.nearItems(S); }
  function renderHome() {
    var st = E.computeStats(S);
    var urg = urgentItems();
    var expired = urg.filter(function (x) { return E.statusOf(x) === 'expired'; }).length;
    var critical = urg.filter(function (x) {
      var s = E.statusOf(x); return s === 'urgent' || s === 'expired';
    }).length;

    $('todayLabel').textContent = (function () {
      var d = new Date();
      var wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + wk;
    })();

    // 右侧 mini 面板：最紧急的 3 样
    $('heroPanel').innerHTML =
      '<div class="mini-title">冰箱里最该先吃掉的</div>' +
      (urg.length ? urg.slice(0, 3).map(function (x) {
        var f = E.foodById(x.foodId), c = E.catStyle(f.cat);
        var dl = E.daysLeft(x.expiryDate);
        return '<div class="mini-row"><span class="mini-dot" style="background:' + c.color + '"></span>' +
          '<span class="mini-name">' + esc(f.name) + '</span>' +
          '<span class="mini-days ' + (dl < 0 ? 'red' : '') + '">' + (dl < 0 ? '已过期' : '剩 ' + dl + ' 天') + '</span></div>';
      }).join('') : '<div class="empty">暂时没有临期食材，很棒</div>') +
      (urg.length > 3 ? '<div class="mini-more">还有 ' + (urg.length - 3) + ' 样临期食材，去「今晚吃什么」看全部</div>' : '') +
      '<div class="mini-foot">' + ic('spark') + '鲜知会优先把它们安排进今晚的菜</div>';

    // 四张指标卡
    $('homeStats').innerHTML = [
      { icon: 'fridge', label: '冰箱食材', value: S.inventory.length, unit: '样', foot: '点击「我的冰箱」管理' },
      { icon: 'warn', label: '需要优先吃掉', value: urg.length, unit: '样', foot: '≤7 天 · 其中 ' + critical + ' 样 ≤3 天' + (expired ? '（含 ' + expired + ' 样已过期）' : '') },
      { icon: 'yen', label: '累计少扔掉', value: '¥' + st.moneySaved, unit: '', foot: '按食材参考价估算' },
      { icon: 'fire', label: '已下厨', value: st.cookCount, unit: '次', foot: '采纳率 ' + st.adoptRate + '%' }
    ].map(function (x) {
      return '<div class="stat-card"><div class="stat-label">' + ic(x.icon) + esc(x.label) + '</div>' +
        '<div class="stat-value">' + esc(x.value) + (x.unit ? '<span class="unit">' + x.unit + '</span>' : '') + '</div>' +
        '<div class="stat-foot">' + esc(x.foot) + '</div></div>';
    }).join('');

    // 临期提醒列表
    // 全部列出，不再截断到 4 条 —— 之前「有些临期食品不显示」也来自这里
    $('homeUrgent').innerHTML = urg.length ? urg.map(function (x) {
      var f = E.foodById(x.foodId), c = E.catStyle(f.cat), dl = E.daysLeft(x.expiryDate);
      var tone = dl < 0 ? 'red' : dl <= 3 ? 'amber' : 'blue';
      return '<div class="urgent-row"><span class="inv-dot" style="background:' + c.color + '"></span>' +
        '<span class="urgent-name">' + esc(f.name) + '</span>' +
        '<span class="urgent-qty">' + x.qty + ' ' + esc(f.unit) + '</span>' +
        '<span class="urgent-days ' + tone + '">' + (dl < 0 ? '已过期' : '剩 ' + dl + ' 天') + '</span></div>';
    }).join('') + '<div class="hint-box">' + ic('bulb') + '临期 = 剩余 ≤7 天；全部 '+ urg.length +' 样在「今晚吃什么」里都有安排</div>'
      : '<div class="empty">' + ic('leaf') + '没有临期食材，冰箱状态很健康</div>';

    // 今日推荐
    if (!lastRecommend.length) lastRecommend = E.recommend(S, 6);
    $('homeRecommend').innerHTML = lastRecommend.length ? lastRecommend.slice(0, 3).map(function (x) {
      return '<div class="rec-mini"><span class="tag tag-good">' + esc(x.recipe.cat) + '</span>' +
        '<span class="rec-mini-name">' + esc(x.recipe.name) + '</span>' +
        '<span class="rec-mini-time">' + x.recipe.time + ' 分钟</span>' +
        '<button class="btn btn-sm" data-action="open-recipe" data-id="' + x.recipe.id + '">看做法</button></div>';
    }).join('') : '<div class="empty">添加食材后即可生成推荐</div>';

    $('flowStrip').innerHTML = [
      ['01', '录入食材', '拍照识别或手动添加'],
      ['02', '临期提醒', '快坏的先排进来'],
      ['03', 'AI 配菜', '按库存与口味生成'],
      ['04', '补齐缺料', '多家平台任选'],
      ['05', '做完反馈', '扣库存、越用越准']
    ].map(function (s, i) {
      return '<div class="flow-step"><div class="n">' + s[0] + '</div><div class="t">' + s[1] + '</div><div class="d">' + s[2] + '</div></div>' +
        (i < 4 ? '<span class="flow-arrow">' + ic('arrow') + '</span>' : '');
    }).join('');
    renderM4Bar();
  }

  /* ============================================================
   * M4 验证：首页轻打卡条 + 设置页数据导出
   * 理由：PRD §13 要求「每天一次轻提醒，不打扰」，所以只在当天未打卡且
   * 已经生成过推荐时露面，答完即收起；不新增导航、不打断主流程。
   * ============================================================ */
  function renderM4Bar() {
    var box = $('m4CheckBar'); if (!box) return;
    var d = E.todayStr();
    var c = (S.m4 && S.m4.checkIns && S.m4.checkIns[d]) || {};
    var answered = (c.cooked === true || c.cooked === false);
    if (answered || !(S.generatedCount > 0)) { box.innerHTML = ''; return; }
    box.innerHTML =
      '<div class="tip-bar m4-bar">' +
      '<span class="m4-q">' + ic('check') + '今天照着鲜知做了吗？</span>' +
      '<input id="m4Blocker" class="field m4-blocker" placeholder="卡在哪？（选填）" maxlength="120">' +
      '<button class="btn btn-sm btn-primary" data-action="m4-yes">做了</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="m4-no">没做</button>' +
      '</div>';
  }
  function m4Check(yes) {
    var d = E.todayStr();
    S.m4 = S.m4 || defaultState().m4;
    S.m4.checkIns = S.m4.checkIns || {};
    var c = S.m4.checkIns[d] || {};
    c.opened = true; c.cooked = !!yes;
    var inp = $('m4Blocker');
    if (inp && inp.value) c.blocker = String(inp.value).slice(0, 120);
    S.m4.checkIns[d] = c;
    save(); renderHome();
    toast(yes ? '已记录，明天见' : '已记录，卡点会帮助我们改进');
  }
  function renderM4Box() {
    var box = $('m4Box'); if (!box) return;
    var rows = E.m4ExportRows(S);
    var done = rows.filter(function (r) { return r.cooked === 1 || r.cooked === 0; }).length;
    box.innerHTML =
      '<div class="sum-row"><span>匿名编号</span><strong>' + esc(S.m4.userId) + '</strong></div>' +
      '<div class="sum-row"><span>版本基线</span><strong>' + esc(S.m4.baseline) + '</strong></div>' +
      '<div class="sum-row"><span>参与天数</span><strong>第 ' + rows.length + ' 天 / 共 14 天</strong></div>' +
      '<div class="sum-row"><span>已打卡</span><strong>' + done + ' 天</strong></div>' +
      '<div class="divider"></div>' +
      '<p class="muted small">数据只存在这台设备的浏览器里。导出 CSV 后发给验证组织者即可，' +
      '文件不含姓名、手机号、位置等任何身份信息，只有一个随机匿名编号。</p>' +
      '<div class="install-row"><button class="btn btn-primary" data-action="m4-export">' + ic('copy') + ' 导出验证数据 CSV</button>' +
      '<span class="muted small">全程离线，不上传服务器</span></div>';
  }
  function exportM4Csv() {
    var csv = E.m4ToCsv(S);
    var name = 'm4-' + S.m4.userId + '-' + E.todayStr() + '.csv';
    try {
      var U = window.URL || window.webkitURL;
      var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      var url = U.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { U.revokeObjectURL(url); }, 1000);
      toast('已导出 ' + name + '，发给验证组织者即可');
    } catch (e) {
      // 老浏览器 / file:// 下 Blob 下载不可用时，退化为复制到剪贴板，数据不丢
      copyText(csv, '当前环境不支持下载，数据已复制到剪贴板');
    }
  }

  /* ============================================================
   * B2：全量数据备份（导出 / 导入）
   * 纯本地 Blob 下载 + FileReader 读取，不联网、不引入后端，隐私承诺不变。
   * 独立 localStorage key 记「上次备份时间」，刻意不写进 S，
   * 这样数据模型、m4 字段、CSV 列与判定口径都不会被这次改动影响。
   * ============================================================ */
  var BACKUP_META_KEY = 'xianzhi.fridge.lastBackupAt';
  var pendingBackup = null;

  function lastBackupAt() {
    try { return localStorage.getItem(BACKUP_META_KEY) || ''; } catch (e) { return ''; }
  }
  function renderBackupBox() {
    var box = $('backupBox'); if (!box) return;
    var last = lastBackupAt();
    box.innerHTML =
      '<div class="sum-row"><span>上次备份</span><strong>' +
        (last ? esc(last) : '还没有备份过') + '</strong></div>' +
      '<div class="sum-row"><span>包含内容</span><strong>库存 / 偏好 / 做饭与营养记录 / 周菜单 / 剩菜 / 打卡</strong></div>' +
      '<div class="divider"></div>' +
      '<p class="muted small">文件只保存在你选的位置，全程不上传服务器。换设备或清缓存前导一份，' +
      '之后用「导入备份」可完整恢复，含 14 天打卡记录与匿名编号。</p>' +
      '<div class="install-row">' +
      '<button class="btn btn-primary" data-action="backup-export">' + ic('copy') + ' 导出备份 JSON</button>' +
      '<button class="btn" data-action="backup-pick">' + ic('refresh') + ' 导入备份</button>' +
      '<span class="muted small">导入会覆盖当前设备的全部数据，需二次确认</span>' +
      '</div>';
  }
  function exportBackup() {
    var text = E.backupToText(S);
    var name = 'xianzhi-backup-' + E.todayStr() + '.json';
    try {
      var U = window.URL || window.webkitURL;
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      var url = U.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { U.revokeObjectURL(url); }, 1000);
      try { localStorage.setItem(BACKUP_META_KEY, E.backupNowText()); } catch (e) {}
      renderBackupBox();
      toast('已导出 ' + name + '，请妥善保存');
    } catch (e) {
      copyText(text, '当前环境不支持下载，备份内容已复制到剪贴板');
    }
  }
  function openBackupPicker() {
    var f = $('backupFile');
    // 老环境 / DOM 桩里可能没有 click，静默跳过而不是抛错影响其余交互
    if (f && typeof f.click === 'function') { f.value = ''; f.click(); }
  }
  function readBackupFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var res = E.parseBackup(String(reader.result || ''));
      if (!res.ok) { toast('导入失败：' + res.reason); return; }
      pendingBackup = res;
      openModal('确认导入备份',
        '<div class="hint-box" style="background:var(--red-bg);color:var(--red)">' + ic('info') +
        '导入会<b>覆盖当前设备的全部数据</b>，操作不可撤销。建议先导出一份当前数据留底。</div>' +
        '<div class="sum-row"><span>备份时间</span><strong>' + esc(res.exportedAt || '未记录') + '</strong></div>' +
        '<div class="sum-row"><span>来源版本</span><strong>' + esc(res.build || '未记录') + '</strong></div>' +
        '<div class="sum-row"><span>库存 / 做饭记录</span><strong>' +
          res.counts.inventory + ' 样 / ' + res.counts.history + ' 次</strong></div>' +
        '<div class="sum-row"><span>剩菜 / 打卡天数</span><strong>' +
          res.counts.leftovers + ' 份 / ' + res.counts.checkInDays + ' 天</strong></div>' +
        '<p class="muted small" style="margin-top:12px">打卡记录与匿名编号会一并恢复（换设备场景）。' +
        '若这台设备已经参与了验证，导入会替换它已有的记录，请先确认不会覆盖 D1~D14 数据。</p>',
        '<button class="btn" data-action="close-modal">取消</button>' +
        '<button class="btn btn-danger" data-action="backup-import-confirm">确认覆盖导入</button>');
    };
    reader.onerror = function () { toast('读取文件失败，请重试'); };
    reader.readAsText(file, 'utf-8');
  }
  function confirmBackupImport() {
    if (!pendingBackup) return;
    var base = defaultState();
    S = Object.assign(base, pendingBackup.state);
    S.prefs = Object.assign(defaultState().prefs, pendingBackup.state.prefs || {});
    pendingBackup = null;
    // 刻意不调用打卡初始化：导入的语义是「完整恢复」，不应把今天的打开记录再写一遍
    save(); closeModal(); refreshRecommend(); renderAll(); renderSettings();
    toast('备份已导入，数据已恢复');
  }

  /* ============================================================
   * 渲染：我的冰箱
   * ============================================================ */
  function renderFridge() {
    var cats = ['全部'];
    S.inventory.forEach(function (x) {
      var f = E.foodById(x.foodId);
      if (f && cats.indexOf(f.cat) < 0) cats.push(f.cat);
    });
    $('fridgeFilters').innerHTML = cats.map(function (c) {
      var n = c === '全部' ? S.inventory.length : S.inventory.filter(function (x) {
        var f = E.foodById(x.foodId); return f && f.cat === c;
      }).length;
      return '<button class="chip ' + (filterCat === c ? 'active' : '') + '" data-action="filter" data-cat="' + esc(c) + '">' + esc(c) + ' ' + n + '</button>';
    }).join('') + '<button class="chip" data-action="purge-expired">' + ic('trash') + ' 清理已过期</button>';

    var list = S.inventory.slice().sort(function (a, b) { return E.daysLeft(a.expiryDate) - E.daysLeft(b.expiryDate); });
    if (filterCat !== '全部') list = list.filter(function (x) {
      var f = E.foodById(x.foodId); return f && f.cat === filterCat;
    });

    $('fridgeCount').textContent = S.inventory.length;
    $('inventoryList').innerHTML = list.length ? list.map(function (x) {
      var f = E.foodById(x.foodId); if (!f) return '';
      var c = E.catStyle(f.cat), s = E.statusOf(x), dl = E.daysLeft(x.expiryDate);
      var pill = { expired: ['tag-expired', '已过期'], urgent: ['tag-urgent', '剩 ' + dl + ' 天'], soon: ['tag-soon', '剩 ' + dl + ' 天'], ok: ['tag-info', '剩 ' + dl + ' 天'] }[s];
      return '<div class="inv-item ' + (s === 'urgent' ? 'is-urgent' : s === 'expired' ? 'is-expired' : '') + '">' +
        '<span class="inv-dot" style="background:' + c.color + '"></span>' +
        '<div class="inv-main"><div class="inv-name">' + esc(f.name) + '</div>' +
        '<div class="inv-meta">' + x.qty + ' ' + esc(f.unit) + ' · ' + esc(f.cat) + ' · ' + E.fmtDate(x.expiryDate) + '到期</div></div>' +
        '<div class="inv-right"><span class="status-pill ' + pill[0] + '">' + pill[1] + '</span>' +
        '<button class="icon-btn" title="删除" data-action="delete-food" data-uid="' + x.uid + '">' + ic('trash') + '</button></div></div>';
    }).join('') : '<div class="empty">' + ic('fridge') + '这个分类还没有食材</div>';
  }

  /* ============================================================
   * 渲染：今晚吃什么
   * 关键修复：新增「临期食材全覆盖」面板。Top6 只是排序结果，不能保证
   * 每件临期食材都露面；这里逐件列出并说明「为什么没进推荐」，
   * 让任何临期食材都可见、可解释、可直接点开做法。
   * ============================================================ */
  function renderNearExpiry() {
    var box = $('nearList'); if (!box) return;
    var shownIds = lastRecommend.map(function (x) { return x.recipe.id; });
    var rows = E.nearExpiryReport(S, shownIds);
    var pending = rows.filter(function (r) {
      return !r.expired && !r.blockedByAvoid && !r.pantry && !r.shownCount;
    }).length;

    $('nearCount').textContent = rows.length ? '共 ' + rows.length + ' 样 · 按到期时间排序' : '';
    $('nearSummary').innerHTML = ic('info') +
      '<span>临期 = 剩余 <b>≤7 天</b>（含已过期）。' +
      (rows.length
        ? '每样都列出了可用菜谱或处理建议；' + (pending
            ? '<b>' + pending + ' 样</b>未进入下方 Top6，可在这里直接点开做，不会静默消失。'
            : '当前都已安排进推荐。')
        : '冰箱里目前没有需要优先处理的食材，状态很健康。') +
      '</span>';

    box.innerHTML = rows.length ? rows.map(function (r) {
      var c = E.catStyle(r.food.cat), dl = r.daysLeft;
      var pillCls = { expired: 'tag-expired', urgent: 'tag-urgent', soon: 'tag-soon', ok: 'tag-info' }[r.status];
      var pillTxt = dl < 0 ? '已过期 ' + Math.abs(dl) + ' 天' : '剩 ' + dl + ' 天';

      var body;
      if (r.expired) {
        // 食品安全优先：过期食材不加权推荐，只提示丢弃
        body = '<div class="near-note danger">已过期，不建议食用，请确认后丢弃</div>' +
          '<button class="near-act" data-action="purge-expired">' + ic('trash') + ' 清理已过期</button>';
      } else if (r.blockedByAvoid) {
        body = '<div class="near-note warn">已设为忌口，含它的菜被全部排除</div>' +
          '<button class="near-act" data-action="go-settings">去设置改忌口</button>';
      } else if (r.pantry) {
        body = '<div class="near-note">常备耐储品，检查包装后日常烹饪随手用掉即可，无需专门配菜</div>';
      } else if (!r.recipes.length) {
        body = '<div class="near-note warn">菜谱库暂无能用上它的菜，建议直接食用 / 冷冻 / 分享给邻居</div>' +
          '<button class="near-act" data-view="fridge">去冰箱处理</button>';
      } else {
        body = '<div class="near-state ' + (r.shownCount ? 'ok' : 'pending') + '">' +
          (r.shownCount ? '已进入今晚推荐 · ' + r.shownCount + ' 道'
                        : '共 ' + r.recipes.length + ' 道可做 · 未进 Top6，点下面直接看做法') +
          '</div><div class="near-recipes">' + r.recipes.slice(0, 3).map(function (rc) {
            return '<button class="mini-rec' + (rc.shown ? ' in-top' : '') + '" data-action="open-recipe" data-id="' + rc.id + '">' +
              esc(rc.name) + (rc.shown ? ' · 已推荐' : '') + '</button>';
          }).join('') + '</div>';
      }

      return '<div class="near-item sev-' + r.status + '">' +
        '<div class="near-head"><span class="inv-dot" style="background:' + c.color + '"></span>' +
        '<span class="near-name">' + esc(r.food.name) + '</span>' +
        '<span class="status-pill ' + pillCls + '">' + pillTxt + '</span></div>' +
        '<div class="near-meta">' + r.qty + ' ' + esc(r.unit) + ' · ' +
        (r.expiryDate ? E.fmtDate(r.expiryDate) + '到期' : '') + ' · ' + esc(r.food.cat) + '</div>' +
        body + '</div>';
    }).join('') : '<div class="empty">' + ic('leaf') + '冰箱里没有 ≤7 天的临期食材，状态很健康</div>';
  }

  function renderPlan() {
    var p = S.prefs;
    $('planTip').innerHTML = ic('info') + '当前偏好：' + p.people + ' 人份 · ' + (p.flavor || '口味不限') + ' · ' + p.goal +
      (p.quick ? ' · 快手优先' : '') + (p.avoid.length ? ' · 忌口 ' + p.avoid.length + ' 样' : '') +
      '　<a href="#" data-action="go-settings" style="color:inherit">去设置</a>';

    if (!lastRecommend.length) refreshRecommend();
    renderNearExpiry();
    if (!lastRecommend.length) {
      $('recipeGrid').innerHTML = '<div class="empty">' + ic('bulb') + '还没有可用的推荐，先去冰箱添加食材</div>';
      return;
    }
    $('recipeGrid').innerHTML = lastRecommend.map(function (x) {
      var r = x.recipe;
      var nutri = E.recipeNutrition(r);
      var pct = Math.round(x.ownedCount / x.requiredCount * 100);
      return '<div class="recipe-card">' +
        '<div class="recipe-top"><div><div class="recipe-title">' + esc(r.name) + '</div>' +
        '<div class="recipe-sub">' + esc(r.cat) + ' · ' + r.time + ' 分钟 · ' + r.servings + ' 人份 · 约 ' + nutri.kcal + ' kcal · 蛋白 ' + nutri.protein + 'g</div></div>' +
        '<div class="score-box"><div class="score-num">' + x.score + '</div><div class="score-lbl">推荐分</div></div></div>' +
        '<div class="reason-list">' + x.reasons.map(function (rs) {
          return '<span class="tag tag-' + rs.type + '">' + esc(rs.text) + '</span>';
        }).join('') + '</div>' +
        '<div><div class="match-bar"><span style="width:' + pct + '%"></span></div>' +
        '<div class="match-text"><span>家里已有 ' + x.ownedCount + '/' + x.requiredCount + ' 样主料</span>' +
        '<span>' + (x.missing.length ? '缺 ' + x.missing.length + ' 样' : '不用买') + '</span></div></div>' +
        '<div class="recipe-foot">' +
        '<button class="btn btn-sm" data-action="open-recipe" data-id="' + r.id + '">看做法</button>' +
        '<button class="btn btn-sm" data-action="add-to-shop" data-id="' + r.id + '">' + (S.selected.indexOf(r.id) >= 0 ? '已在清单' : '加入清单') + '</button>' +
        '<button class="btn btn-sm btn-primary" data-action="open-feedback" data-id="' + r.id + '">我做了</button>' +
        '</div></div>';
    }).join('');
  }

  /* ============================================================
   * 渲染：购物清单
   * ============================================================ */
  function renderShop() {
    var undone = S.shopping.filter(function (x) { return !x.checked; }).length;
    $('shopCount').textContent = '(' + undone + ' 样待买)';
    $('shoppingList').innerHTML = S.shopping.length ? S.shopping.map(function (x, i) {
      var f = E.foodById(x.foodId); if (!f) return '';
      return '<div class="shop-item ' + (x.checked ? 'done' : '') + '">' +
        '<button class="shop-check" data-action="toggle-shop" data-i="' + i + '">' + ic('check') + '</button>' +
        '<div class="shop-info"><div class="shop-name">' + esc(f.name) + '</div>' +
        '<div class="shop-from">用于：' + esc(x.from.join('、')) + '</div></div>' +
        '<span class="shop-qty">' + esc(x.qty) + '</span></div>';
    }).join('') : '<div class="empty">' + ic('cart') + '清单是空的<br>去「今晚吃什么」把想做的菜加进来</div>';

    $('platformList').innerHTML = D.PLATFORMS.map(function (p) {
      return '<button class="platform-btn" data-action="platform" data-name="' + esc(p) + '"><span>' + esc(p) + '</span>' + ic('copy') + '</button>';
    }).join('');
    $('shopFrom').innerHTML = S.selected.length ? '清单来自：' + S.selected.map(function (id) {
      var r = E.recipeById(id); return r ? esc(r.name) : '';
    }).filter(Boolean).join('、') : '尚未选择菜谱';
  }

  /* ============================================================
   * 渲染：减少浪费
   * ============================================================ */
  function renderStats() {
    var st = E.computeStats(S);
    $('statsGrid').innerHTML = [
      { icon: 'fire', label: '下厨次数', value: st.cookCount, unit: '次', foot: '每一次都是一次不点外卖' },
      { icon: 'leaf', label: '用掉的食材', value: st.savedItems, unit: '样', foot: '其中临期 ' + st.urgentSaved + ' 样' },
      { icon: 'yen', label: '估算少浪费', value: '¥' + st.moneySaved, unit: '', foot: '按参考单价累计' },
      { icon: 'chart', label: '推荐采纳率', value: st.adoptRate, unit: '%', foot: '共推荐 ' + st.generatedCount + ' 次' }
    ].map(function (x) {
      return '<div class="stat-card"><div class="stat-label">' + ic(x.icon) + esc(x.label) + '</div>' +
        '<div class="stat-value">' + esc(x.value) + (x.unit ? '<span class="unit">' + x.unit + '</span>' : '') + '</div>' +
        '<div class="stat-foot">' + esc(x.foot) + '</div></div>';
    }).join('');

    var max = Math.max(st.savedItems, st.urgentSaved, st.cookCount, 1);
    $('statsBars').innerHTML = [
      ['用掉食材', st.savedItems], ['其中临期', st.urgentSaved], ['下厨次数', st.cookCount]
    ].map(function (b) {
      return '<div class="bar-row"><div class="bar-label"><span>' + b[0] + '</span><span>' + b[1] + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + Math.round(b[1] / max * 100) + '%"></div></div></div>';
    }).join('') + '<div class="hint-box">' + ic('info') + '数据由「做饭反馈」自动累计，不手动填写，避免自欺欺人</div>';

    $('historyList').innerHTML = S.history.length ? S.history.slice().reverse().slice(0, 8).map(function (h) {
      var r = E.recipeById(h.recipeId);
      return '<div class="history-item"><span class="tag tag-info">' + esc(h.date) + '</span>' +
        '<span class="history-name">' + esc(r ? r.name : '未知菜谱') + '</span>' +
        '<span class="stars">' + '★'.repeat(h.rating) + '☆'.repeat(5 - h.rating) + '</span></div>';
    }).join('') : '<div class="empty">' + ic('clock') + '还没有做饭记录<br>做完一道菜记得点「我做了」</div>';
  }

  /* ============================================================
   * 渲染：营养记录（每天记录 / 每月回顾）
   * ============================================================ */
  function renderNutrition() {
    var ym = nutMonth || E.todayStr().slice(0, 7);
    var goal = E.dailyGoal(S.prefs);
    var report = E.monthlyReport(S, ym);
    var today = E.todayStr();
    var todayEntry = (S.nutritionLog || {})[today];
    var t = todayEntry ? todayEntry.totals : { kcal: 0, protein: 0, fat: 0, carb: 0, fiber: 0 };
    var kcalPct = goal.kcal ? Math.min(100, Math.round(t.kcal / goal.kcal * 100)) : 0;

    $('nutViewMonth').textContent = report.year + ' 年 ' + report.month + ' 月';
    $('nutTodayDate').textContent = today;

    function macroPill(label, cur, tgt, unit) {
      var p = tgt ? Math.min(100, Math.round(cur / tgt * 100)) : 0;
      return '<div class="macro-pill"><div class="macro-top"><span>' + label + '</span><span>' + cur + '/' + tgt + unit + '</span></div>' +
        '<div class="bar-track sm"><div class="bar-fill" style="width:' + p + '%"></div></div></div>';
    }
    $('nutToday').innerHTML =
      '<div class="nut-today-kcal"><span class="big">' + t.kcal + '</span> / ' + goal.kcal + ' kcal</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + kcalPct + '%"></div></div>' +
      '<div class="nut-macros">' +
        macroPill('蛋白质', t.protein, goal.protein, 'g') +
        macroPill('脂肪', t.fat, goal.fat, 'g') +
        macroPill('碳水', t.carb, goal.carb, 'g') +
        macroPill('膳食纤维', t.fiber, 25, 'g') +
      '</div>' +
      (todayEntry && todayEntry.meals.length
        ? '<div class="hint-box">' + ic('check') + '今天已记录：' + todayEntry.meals.map(function (m) { return esc(m.name) + '(' + m.kcal + 'kcal)'; }).join('、') + '</div>'
        : '<div class="empty">' + ic('clock') + '今天还没记录<br>做完一道菜点「我做了」即可自动累计</div>');

    var firstDay = new Date(report.year, report.month - 1, 1).getDay();
    var maxK = Math.max.apply(null, report.days.map(function (d) { return d.kcal; }).concat([1]));
    var cells = '';
    for (var b = 0; b < firstDay; b++) cells += '<div class="cal-cell empty"></div>';
    report.days.forEach(function (d) {
      var p = maxK ? Math.round(d.kcal / maxK * 100) : 0;
      cells += '<div class="cal-cell' + (d.has ? ' has' : '') + (d.date === today ? ' today' : '') + '" title="' + d.date + (d.has ? ' · ' + d.kcal + ' kcal' : ' · 未记录') + '">' +
        '<div class="cal-bar" style="height:' + (d.has ? Math.max(10, p) : 4) + '%"></div>' +
        '<span class="cal-num">' + (+d.date.slice(8)) + '</span></div>';
    });
    $('nutTrend').innerHTML = '<div class="cal-grid">' + cells + '</div>';

    $('nutSummary').innerHTML = [
      ['本月做了', report.recipeCount + ' 道菜'],
      ['记录天数', report.daysWithData + ' 天'],
      ['累计热量', report.totals.kcal + ' kcal'],
      ['日均热量', report.avg.kcal + ' kcal'],
      ['日均蛋白', report.avg.protein + ' g'],
      ['日均纤维', report.avg.fiber + ' g']
    ].map(function (x) {
      return '<div class="sum-row"><span>' + x[0] + '</span><span class="sum-val">' + x[1] + '</span></div>';
    }).join('') +
    (report.topRecipes.length
      ? '<div class="divider"></div><div class="mini-title">最常做的菜</div><div class="top-recipes">' +
        report.topRecipes.map(function (r) { return '<span class="tag tag-info">' + esc(r.name) + ' ×' + r.count + '</span>'; }).join('') +
        '</div>'
      : '');

    $('nutGoal').innerHTML = [
      ['热量', goal.kcal + ' kcal'],
      ['蛋白质', goal.protein + ' g'],
      ['脂肪', goal.fat + ' g'],
      ['碳水', goal.carb + ' g']
    ].map(function (x) {
      return '<div class="sum-row"><span>' + x[0] + '</span><span class="sum-val">' + x[1] + '</span></div>';
    }).join('') +
    '<div class="hint-box">' + ic('info') + '目标按健康目标（' + esc(S.prefs.goal) + '）自动给出，仅作均衡饮食参考，非医疗建议；在设置切换目标会同步更新。</div>';
  }

  /* ============================================================
   * 渲染：周菜单规划（P0-1）
   * 把冰箱里快坏的食材排进未来 7 天，自动生成早午晚，减少每天纠结。
   * 与「今晚吃什么」共享同一套引擎（临期加权 / 库存匹配 / 营养估算），
   * 只是把时间维度从「今晚」拉长到「整周」。
   * ============================================================ */
  function ensureWeekMeals(plan) {
    if (!plan.meals) plan.meals = {};
    for (var d = 0; d < 7; d++) {
      if (!plan.meals[d]) plan.meals[d] = { breakfast: null, lunch: null, dinner: null };
      ['breakfast', 'lunch', 'dinner'].forEach(function (s) { if (!(s in plan.meals[d])) plan.meals[d][s] = null; });
    }
  }
  function hasAnyMeal(plan) {
    if (!plan || !plan.meals) return false;
    for (var d = 0; d < 7; d++) {
      var m = plan.meals[d]; if (!m) continue;
      if (m.breakfast || m.lunch || m.dinner) return true;
    }
    return false;
  }
  function renderWeekPlan() {
    var weekStart = E.mondayOf(E.todayStr());
    var plan = S.weekPlan || { weekStart: '', meals: {} };
    ensureWeekMeals(plan);
    var stale = !plan.weekStart || plan.weekStart !== weekStart;
    var ws = plan.weekStart || weekStart;
    var todayIdx = todayWeekday();

    $('weekRange').textContent = E.fmtDate(ws) + ' – ' + E.fmtDate(E.addDays(ws, 6));
    $('weekTip').innerHTML = ic('info') + (stale
      ? '这是 <b>' + esc(E.fmtDate(ws)) + '</b> 那周的菜单（已不是本周）。点「一键生成本周菜单」可基于当前冰箱重新规划。'
      : '优先把冰箱里快坏的食材排进这一周；用掉临期食材的菜会标「临期」徽标。');

    var nearMap = E.nearExpiryMap(S);
    var grid = '';
    for (var d = 0; d < 7; d++) {
      var dayDate = E.addDays(ws, d);
      var isToday = (!stale && d === todayIdx);
      var dayKcal = 0, slotsHtml = '';
      ['breakfast', 'lunch', 'dinner'].forEach(function (slot) {
        var rid = plan.meals[d][slot];
        if (rid) {
          var r = E.recipeById(rid); if (!r) { plan.meals[d][slot] = null; return; }
          var n = E.recipeNutrition(r);
          dayKcal += n.kcal;
          var usesNear = r.ingredients.some(function (i) { var dl = nearMap[i.id]; return dl !== undefined && dl >= 0; });
          slotsHtml += '<div class="meal-card' + (usesNear ? ' is-near' : '') + '">' +
            (usesNear ? '<span class="meal-badge">临期</span>' : '') +
            '<div class="meal-name">' + esc(r.name) + '</div>' +
            '<div class="meal-meta">' + n.kcal + ' kcal</div>' +
            '<div class="meal-acts">' +
              '<button class="link-btn" data-action="open-recipe" data-id="' + r.id + '">做法</button>' +
              (isToday ? '<button class="link-btn" data-action="week-done" data-id="' + r.id + '" data-day="' + d + '">完成</button>' : '') +
              '<button class="link-btn danger" data-action="remove-week" data-day="' + d + '" data-slot="' + slot + '">移除</button>' +
            '</div></div>';
        } else {
          slotsHtml += '<button class="meal-add" data-action="add-week" data-day="' + d + '" data-slot="' + slot + '">+ ' + esc(SLOT_NAMES[slot]) + '</button>';
        }
      });
      grid += '<div class="day-col' + (isToday ? ' is-today' : '') + '">' +
        '<div class="day-head"><span class="day-name">' + DAY_NAMES[d] + '</span>' +
        '<span class="day-date">' + E.fmtDate(dayDate) + '</span></div>' +
        slotsHtml +
        '<div class="day-total">本日 ≈ ' + dayKcal + ' kcal</div></div>';
    }
    $('weekGrid').innerHTML = grid;

    if (stale) {
      $('weekShopCount').textContent = '';
      $('weekShop').innerHTML = '<div class="empty">' + ic('clock') + '切换到本周菜单后，这里会汇总本周需要采购的食材</div>';
      $('weekNutrition').innerHTML = '<div class="empty">' + ic('clock') + '切换到本周菜单后，这里会汇总本周营养</div>';
      return;
    }
    var list = E.weekShoppingList(S.weekPlan, S);
    $('weekShopCount').textContent = '（' + list.length + ' 样待买）';
    $('weekShop').innerHTML = list.length ? list.map(function (x) {
      var f = E.foodById(x.foodId); if (!f) return '';
      return '<div class="shop-item"><div class="shop-info"><div class="shop-name">' + esc(f.name) + '</div>' +
        '<div class="shop-from">用于：' + esc(x.from.join('、')) + '</div></div>' +
        '<span class="shop-qty">' + esc(x.qty) + '</span></div>';
    }).join('') : '<div class="empty">' + ic('leaf') + '本周菜单用到的食材家里基本都有，无需额外采购</div>';

    var ns = E.weekNutritionSummary(S.weekPlan);
    $('weekNutrition').innerHTML = [
      ['本周共规划', ns.count + ' 餐'],
      ['合计热量', ns.total.kcal + ' kcal'],
      ['日均热量', ns.avgPerDay.kcal + ' kcal'],
      ['合计蛋白', ns.total.protein + ' g'],
      ['合计纤维', ns.total.fiber + ' g']
    ].map(function (x) {
      return '<div class="sum-row"><span>' + x[0] + '</span><span class="sum-val">' + x[1] + '</span></div>';
    }).join('') +
    '<div class="hint-box">' + ic('info') + '周营养为「计划值」，按整道菜估算、含油盐参考值；实际吃了多少以「营养记录」里的每日记录为准。</div>';
  }
  function genWeek() {
    ensureWeekMeals(S.weekPlan);
    if (S.weekPlan.weekStart === E.mondayOf(E.todayStr()) && hasAnyMeal(S.weekPlan)) {
      openModal('覆盖现有安排？', '<p class="muted">本周菜单已有内容，确定要基于当前冰箱重新生成并覆盖吗？</p>',
        '<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="gen-week-confirm">重新生成</button>');
      return;
    }
    doGenWeek();
  }
  function doGenWeek() {
    S.weekPlan = E.generateWeekPlan(S);
    save(); renderWeekPlan();
    toast('已生成本周 7 天菜单，优先消耗临期食材');
  }
  function clearWeek() {
    ensureWeekMeals(S.weekPlan);
    if (!hasAnyMeal(S.weekPlan)) { toast('本周菜单是空的'); return; }
    openModal('清空本周菜单？', '<p class="muted">这会移除本周所有已安排的菜品，且不可撤销。</p>',
      '<button class="btn" data-action="close-modal">取消</button><button class="btn btn-danger" data-action="clear-week-confirm">确认清空</button>');
  }
  function clearWeekConfirm() {
    S.weekPlan = { weekStart: E.mondayOf(E.todayStr()), meals: {} };
    save(); closeModal(); renderWeekPlan(); toast('已清空本周菜单');
  }
  function openWeekPicker(day, slot) {
    pendingWeekDay = day; pendingWeekSlot = slot;
    var picks = E.recommend(S, 18);
    var body = '<div class="muted small" style="margin-bottom:10px">为 ' + DAY_NAMES[day] + ' 的' + SLOT_NAMES[slot] + '选一道菜：</div>' +
      '<div class="pick-grid">' + picks.map(function (x) {
        var r = x.recipe, n = E.recipeNutrition(r);
        return '<button class="pick-item" data-action="pick-week" data-id="' + r.id + '"><span class="pick-name">' + esc(r.name) +
          '</span><span class="pick-meta">' + r.time + ' 分钟 · ' + n.kcal + ' kcal</span></button>';
      }).join('') + '</div>';
    openModal('添加 ' + SLOT_NAMES[slot], body);
  }
  function pickWeek(id) { addWeekMeal(pendingWeekDay, pendingWeekSlot, id); closeModal(); }
  function addWeekMeal(day, slot, recipeId) {
    ensureWeekMeals(S.weekPlan);
    if (!S.weekPlan.weekStart) S.weekPlan.weekStart = E.mondayOf(E.todayStr());
    S.weekPlan.meals[day][slot] = recipeId;
    save(); renderWeekPlan(); toast('已添加到' + DAY_NAMES[day] + SLOT_NAMES[slot]);
  }
  function removeWeekMeal(day, slot) {
    ensureWeekMeals(S.weekPlan);
    S.weekPlan.meals[day][slot] = null;
    save(); renderWeekPlan();
  }
  function weekDone(recipeId, day) {
    if (day !== todayWeekday()) { toast('只能记录今天做过的菜'); return; }
    var used = consumeAndRecord(recipeId, 5);
    save(); refreshRecommend(); renderAll(); renderWeekPlan();
    toast('已记录今天这道菜，用掉 ' + used + ' 样食材');
  }
  function weekCopyList() {
    ensureWeekMeals(S.weekPlan);
    var list = E.weekShoppingList(S.weekPlan, S);
    if (!list.length) { toast('本周菜单无需额外采购'); return; }
    copyText(E.shoppingText(list), '本周采购清单已复制，粘贴到任意买菜 App 即可');
  }

  /* ============================================================
   * 渲染：C4 剩菜利用
   * 设计口径：剩菜与生鲜库存分开记录。食材在第一次做菜时已扣过库存、
   * 记过营养，再利用只移除剩菜记录并累计「救回几份」，绝不重复扣减。
   * ============================================================ */
  function addLeftoverFromRecipe(recipeId, silent) {
    var r = E.recipeById(recipeId); if (!r) return;
    var ids = r.ingredients.filter(function (i) {
      if (i.optional) return false;
      var f = E.foodById(i.id);
      return f && f.cat !== '调味' && f.shelf <= 60;
    }).map(function (i) { return i.id; });
    S.leftovers = S.leftovers || [];
    S.leftovers.push({
      uid: uid(), name: '剩的' + r.name, foodIds: ids,
      fromRecipeId: r.id, date: E.todayStr(), note: ''
    });
    if (!silent) toast('已记进剩菜盒，熟食建议 2 天内吃完');
  }
  function recentCooked(limit) {
    var seen = {}, out = [];
    (S.history || []).slice().reverse().forEach(function (h) {
      if (seen[h.recipeId]) return;
      var r = E.recipeById(h.recipeId);
      if (!r) return;
      seen[h.recipeId] = true;
      if (out.length < (limit || 3)) out.push(r);
    });
    return out;
  }
  function openLeftoverAdd(editUid) {
    var editing = null;
    if (editUid) editing = (S.leftovers || []).filter(function (x) { return x.uid === editUid; })[0] || null;
    var preset = {};
    if (editing) (editing.foodIds || []).forEach(function (id) { preset[id] = true; });

    var recent = recentCooked(4);
    var recentFoods = {};
    recent.forEach(function (r) {
      r.ingredients.forEach(function (i) { if (!i.optional) recentFoods[i.id] = true; });
    });
    var quick = (!editing && recent.length)
      ? '<div class="mini-title">最近做过的菜 · 一键登记</div><div class="pick-grid">' + recent.map(function (r) {
          return '<button class="pick-item" data-action="quick-leftover" data-id="' + r.id + '">' +
            '<span class="pick-name">剩的' + esc(r.name) + '</span>' +
            '<span class="pick-meta">自动带入所用食材</span></button>';
        }).join('') + '</div><div class="divider"></div>' : '';

    /* 关键修复：这里列的是「全部食材」，不再只列当前库存。
       做菜时食材已被 consumeAndRecord 从冰箱扣掉，而剩菜恰恰就是它们变成的，
       若按库存过滤，用户永远勾不到「剩的番茄炒蛋」里的西红柿和鸡蛋。 */
    var all = D.FOODS.filter(function (f) { return f.cat !== '调味'; });
    function rank(f) { return preset[f.id] ? 0 : recentFoods[f.id] ? 1 : 2; }
    all.sort(function (a, b) {
      return rank(a) - rank(b) || (a.cat === b.cat ? 0 : (a.cat < b.cat ? -1 : 1));
    });
    var foods = all.map(function (f) {
      var on = !!preset[f.id];
      return '<label class="check-item' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" data-lo-food="' + f.id + '"' + (on ? ' checked' : '') + '> ' +
        esc(f.name) + (recentFoods[f.id] ? '<span class="lo-recent">最近做过</span>' : '') + '</label>';
    }).join('');

    openModal(editing ? '编辑关联食材' : '登记一样剩菜',
      quick +
      '<input type="hidden" id="loEditUid" value="' + esc(editUid || '') + '">' +
      '<div class="form-row"><label class="form-label">给它起个名字</label>' +
      '<input class="field" id="loName" placeholder="例如：半根黄瓜 / 昨晚的番茄炒蛋" value="' +
        esc(editing ? editing.name : '') + '"></div>' +
      '<div class="mini-title">它是用什么做的（可多选，用来匹配改造菜）</div>' +
      '<div class="lo-food-grid">' + (foods || '<span class="muted small">暂无可选食材</span>') + '</div>' +
      '<div class="hint-box" style="margin-top:12px">' + ic('info') +
      '这里列的是全部食材，<b>不依赖冰箱库存</b>——做菜时用掉的食材已被扣减，但剩菜照样能关联它；' +
      '带「最近做过」标记的排在前面。剩菜不会重复扣库存，熟食建议冷藏 2 天内吃完。</div>',
      '<button class="btn" data-action="close-modal">取消</button>' +
      '<button class="btn btn-primary" data-action="submit-leftover">' + (editing ? '保存修改' : '放进剩菜盒') + '</button>');
  }
  function submitLeftover() {
    var inp = $('loName');
    var name = inp && inp.value ? String(inp.value).trim() : '';
    var ids = Array.prototype.slice.call(document.querySelectorAll('[data-lo-food]:checked'))
      .map(function (x) { return x.getAttribute('data-lo-food'); });
    var uidEl = $('loEditUid');
    var editUid = uidEl && uidEl.value ? String(uidEl.value) : '';
    if (!name && !ids.length) { toast('写个名字，或勾选用到的食材'); return; }
    var autoName = ids.length
      ? ids.map(function (id) { var f = E.foodById(id); return f ? f.name : id; }).join('、') + ' 边角料'
      : name;
    S.leftovers = S.leftovers || [];
    var edited = false;
    if (editUid) {
      var lv = S.leftovers.filter(function (x) { return x.uid === editUid; })[0];
      if (lv) { lv.name = name || lv.name; lv.foodIds = ids; edited = true; }
    }
    if (!edited) {
      S.leftovers.push({
        uid: uid(), name: name || autoName, foodIds: ids,
        fromRecipeId: '', date: E.todayStr(), note: ''
      });
    }
    save(); closeModal(); renderAll();
    // 没关联食材时明确说清后果，避免「登记了却没有方案」看起来像功能坏了
    toast(edited
      ? (ids.length ? '已更新关联食材，改造方案已刷新' : '已保存，但没关联食材就不会有改造方案')
      : (ids.length ? '已放进剩菜盒，下方是改造方案'
                    : '已登记。没勾食材不会有改造方案，点条目「关联食材」可补上'));
  }
  function quickLeftover(recipeId) {
    addLeftoverFromRecipe(recipeId, true);
    save(); closeModal(); renderAll(); toast('已登记，去「剩菜利用」看改造方案');
  }
  function removeLeftover(uidStr, kind) {
    S.leftovers = S.leftovers || [];
    var lv = S.leftovers.filter(function (x) { return x.uid === uidStr; })[0];
    if (!lv) return;
    S.leftovers = S.leftovers.filter(function (x) { return x.uid !== uidStr; });
    if (kind === 'eat' || kind === 'discard') {
      S.reuseLog = S.reuseLog || [];
      S.reuseLog.push({
        date: E.todayStr(), recipeIds: [], kind: kind,
        itemCount: kind === 'eat' ? 1 : 0,   // 丢弃不算「救回」
        money: kind === 'eat' ? E.leftoverValue(lv) : 0
      });
    }
    save(); renderAll();
    toast(kind === 'eat' ? '已记：这份剩菜吃掉了，没浪费'
        : kind === 'discard' ? '已丢弃并移出剩菜盒' : '已移出剩菜盒');
  }
  function toggleReusePick(recipeId) {
    var i = reusePicked.indexOf(recipeId);
    if (i >= 0) reusePicked.splice(i, 1); else reusePicked.push(recipeId);
    renderLeftovers();
  }
  function finishReuse(recipeIds, kind) {
    var ids = recipeIds || [];
    S.leftovers = S.leftovers || [];
    var cov = E.reuseCoverage(S, ids, E.todayStr());
    var hit = {};
    cov.coveredIds.forEach(function (id) { hit[id] = true; });
    var removed = [];
    if (ids.length) {
      S.leftovers = S.leftovers.filter(function (lv) {
        if (!E.leftoverStatus(lv, E.todayStr()).safe) return true; // 超期的不算被再利用
        var used = (lv.foodIds || []).some(function (id) { return hit[id]; });
        if (used) { removed.push(lv); return false; }
        return true;
      });
    }
    if (!removed.length) { toast('这些菜没覆盖到可再利用的剩料'); return; }
    var money = Math.round(removed.reduce(function (s, lv) { return s + E.leftoverValue(lv); }, 0) * 10) / 10;
    S.reuseLog = S.reuseLog || [];
    S.reuseLog.push({ date: E.todayStr(), recipeIds: ids, kind: kind, itemCount: removed.length, money: money });
    reusePicked = [];
    save(); renderAll();
    toast('已救回 ' + removed.length + ' 份剩菜 · 约 ¥' + money + '（按参考价估算）');
  }
  function renderLeftovers() {
    S.leftovers = S.leftovers || [];
    S.reuseLog = S.reuseLog || [];
    var sum = E.reuseSummary(S);
    var ideas = E.reuseIdeas(S, E.todayStr(), 8);
    var cov = E.reuseCoverage(S, reusePicked, E.todayStr());

    $('reuseTip').innerHTML = ic('info') + (sum.safe
      ? '剩菜盒里有 <b>' + sum.safe + '</b> 份还能吃。方案按「能吃掉几样剩料」排序，只给建议，不改冰箱库存。'
      : '剩菜盒是空的。做完饭在反馈弹窗勾一下「这道菜有剩」，就会自动记进来。');

    $('reuseSummary').innerHTML = [
      ['盒里现有', sum.total + ' 份'],
      ['其中可吃', sum.safe + ' 份'],
      ['超建议期', sum.overdue + ' 份'],
      ['累计救回', sum.savedItems + ' 份 · 约 ¥' + sum.money],
      ['本月处理', sum.thisMonth + ' 次']
    ].map(function (x) {
      return '<div class="sum-row"><span>' + x[0] + '</span><span class="sum-val">' + esc(x[1]) + '</span></div>';
    }).join('') + '<div class="hint-box">' + ic('info') + '金额按食材参考价估算，仅用于感知「少浪费」，不是真实账单。</div>';

    $('leftoverList').innerHTML = S.leftovers.length ? S.leftovers.map(function (lv) {
      var st = E.leftoverStatus(lv, E.todayStr());
      var names = (lv.foodIds || []).map(function (id) { var f = E.foodById(id); return f ? f.name : id; }).join('、');
      return '<div class="lo-item' + (st.expired ? ' is-over' : '') + '">' +
        '<div class="lo-top"><span class="lo-name">' + esc(lv.name) + '</span>' +
        '<span class="lo-badge' + (st.expired ? ' over' : st.daysLeft === 0 ? ' today' : '') + '">' + esc(st.label) + '</span></div>' +
        '<div class="lo-meta">' + esc(E.fmtDate(lv.date)) + ' 登记' +
        (names ? ' · 关联：' + esc(names) : ' · <span class="lo-warn">未关联食材，暂无方案</span>') +
        (lv.fromRecipeId ? ' · 来自做过的菜' : '') + '</div>' +
        '<div class="lo-acts">' +
          '<button class="link-btn" data-action="lo-edit" data-uid="' + esc(lv.uid) + '">关联食材</button>' +
          (st.safe ? '<button class="link-btn" data-action="lo-eat" data-uid="' + esc(lv.uid) + '">直接吃掉了</button>' : '') +
          '<button class="link-btn danger" data-action="lo-discard" data-uid="' + esc(lv.uid) + '">' + (st.expired ? '已丢弃' : '丢掉') + '</button>' +
          '<button class="link-btn danger" data-action="lo-remove" data-uid="' + esc(lv.uid) + '">移出</button>' +
        '</div></div>';
    }).join('') : '<div class="empty">' + ic('leaf') + '还没有剩菜。做饭后勾一下「这道菜有剩」，或点右上角手动登记</div>';

    var recent = recentCooked(3);
    $('leftoverQuick').innerHTML = recent.length
      ? '<span class="muted small" style="margin-right:10px">刚做过的：</span>' + recent.map(function (r) {
          return '<button class="btn btn-ghost btn-sm" data-action="quick-leftover" data-id="' + r.id + '">+ 剩的' + esc(r.name) + '</button>';
        }).join('')
      : '';

    $('reuseCoverage').innerHTML = cov.total
      ? '<div class="cov-line">已选 <b>' + reusePicked.length + '</b> 道菜 · 能吃掉 <b>' + cov.coveredCount + '/' + cov.total + '</b> 样剩料</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + Math.round(cov.coveredCount / cov.total * 100) + '%"></div></div>' +
        '<div class="cov-names">已覆盖：' + (cov.coveredNames.length ? esc(cov.coveredNames.join('、')) : '暂无') +
        '　·　未覆盖：' + (cov.uncoveredNames.length ? esc(cov.uncoveredNames.join('、')) : '无') + '</div>' +
        (reusePicked.length
          ? '<button class="btn btn-primary btn-sm" data-action="reuse-batch">这几道一起做掉</button>'
          : '<div class="muted small">在下方勾选方案，可一次吃掉多份剩菜</div>')
      : '<div class="muted small">先登记剩菜，这里会显示一次能消灭多少</div>';

    $('reuseIdeas').innerHTML = ideas.length ? ideas.map(function (x) {
      var r = x.recipe, picked = reusePicked.indexOf(r.id) >= 0;
      return '<div class="idea-card' + (picked ? ' picked' : '') + '">' +
        '<div class="idea-head"><span class="idea-name">' + esc(r.name) + '</span>' +
        (x.reuseTagged ? '<span class="tag tag-good">清库存</span>' : '') + '</div>' +
        '<div class="idea-meta">' + x.time + ' 分钟 · 约 ' + x.kcal + ' kcal · ' + esc(r.diff) + '</div>' +
        '<div class="idea-hit">' + ic('check') + ' 能吃掉：' + esc(x.hitNames.join('、')) + '（' + x.hitCount + ' 样）</div>' +
        (x.missingNames.length
          ? '<div class="idea-miss">还需补：' + esc(x.missingNames.join('、')) + '</div>'
          : '<div class="idea-miss ok">家里食材够，不用买</div>') +
        '<div class="idea-acts">' +
          '<button class="link-btn" data-action="reuse-pick" data-id="' + r.id + '">' + (picked ? '✓ 已加入凑一锅' : '+ 凑一锅') + '</button>' +
          '<button class="link-btn" data-action="open-recipe" data-id="' + r.id + '">做法</button>' +
          '<button class="link-btn" data-action="reuse-done" data-id="' + r.id + '">这样处理了</button>' +
        '</div></div>';
    }).join('') : '<div class="empty">' + ic('bulb') +
      (sum.safe ? '这些剩料暂时没有匹配的菜谱，直接加热吃掉也很划算' : '登记剩菜后，这里会给出改造方案') + '</div>';
  }

  /* ============================================================
   * 渲染：设置 + 实现说明
   * ============================================================ */
  function renderSettings() {
    var p = S.prefs;
    function sel(id, label, opts, val) {
      return '<div class="form-row"><label class="form-label">' + label + '</label><select class="field" id="' + id + '">' +
        opts.map(function (o) {
          var v = Array.isArray(o) ? o[0] : o, t = Array.isArray(o) ? o[1] : o;
          return '<option value="' + esc(v) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + esc(t) + '</option>';
        }).join('') + '</select></div>';
    }
    var avoidFoods = D.FOODS.filter(function (f) { return ['肉蛋', '水产', '豆制品', '蔬菜', '调味'].indexOf(f.cat) >= 0; }).slice(0, 18);
    $('prefsForm').innerHTML =
      sel('prefPeople', '常用人数', [[1, '1 人'], [2, '2 人'], [3, '3 人'], [4, '4 人及以上']], p.people) +
      sel('prefFlavor', '口味偏好', [['', '不限'], ['清淡', '清淡'], ['咸鲜', '咸鲜'], ['酸辣', '酸辣'], ['麻辣', '麻辣'], ['酸甜', '酸甜']], p.flavor) +
      sel('prefGoal', '当前目标', ['均衡', '减脂', '增肌', '省时间'], p.goal) +
      '<div class="switch-row"><div><div style="font-size:13px">快手优先</div><div class="muted small">优先推荐 15 分钟内能做完的菜</div></div>' +
      '<button class="switch ' + (p.quick ? 'on' : '') + '" data-action="toggle-quick" aria-label="快手优先"></button></div>' +
      '<div class="switch-row"><div><div style="font-size:13px">每日临期提醒</div><div class="muted small">打开首页时高亮快坏的食材</div></div>' +
      '<button class="switch ' + (p.remind ? 'on' : '') + '" data-action="toggle-remind" aria-label="每日提醒"></button></div>' +
      '<div class="form-row" style="margin-top:16px"><label class="form-label">忌口 / 不吃的食材（命中后整道菜不推荐）</label>' +
      '<div class="check-grid">' + avoidFoods.map(function (f) {
        var on = p.avoid.indexOf(f.id) >= 0;
        return '<label class="check-item ' + (on ? 'on' : '') + '"><input type="checkbox" data-avoid="' + f.id + '"' + (on ? ' checked' : '') + '>' + esc(f.name) + '</label>';
      }).join('') + '</div></div>' +
      '<button class="btn btn-primary" data-action="save-prefs">' + ic('check') + ' 保存偏好并重新推荐</button>';

    $('aboutBox').innerHTML =
      '<ul class="about-list">' +
      '<li><strong>为什么是纯网页：</strong>无需安装、无需账号、双击即可运行，最适合快速验证「用户会不会每天用」。</li>' +
      '<li><strong>为什么用 localStorage：</strong>没有后端也能持久化，刷新不丢数据；未来接云数据库只替换读写层。</li>' +
      '<li><strong>为什么用经典 script 而非 ES module：</strong>避免 file:// 协议下的 CORS 限制，保证离线可打开。</li>' +
      '<li><strong>为什么推荐打分可解释：</strong>每条推荐都列出理由（临期、覆盖率、口味、评分），黑盒推荐用户不敢信。</li>' +
      '<li><strong>为什么临期权重最高：</strong>「少扔菜」既是真实痛点，也呼应《反食品浪费法》。临期统一按剩余 ≤7 天分级加权（≤1 天 +18、2~3 天 +12、4~7 天 +6），已过期食材不加分、只提示丢弃。</li>' +
      '<li><strong>为什么计划页有「临期全覆盖」面板：</strong>Top6 只是排序结果，不保证每件临期食材都露面；逐件列出并说明未进推荐的原因，才不会让临期食材静默消失。</li>' +
      '<li><strong>为什么购物清单不锁定平台：</strong>叮咚/盒马的 AI 管家本质是卖货；中立分发才是用户视角。</li>' +
      '<li><strong>为什么识别后要人工确认：</strong>AI 识别会有误差，让用户勾选确认比直接入库安全得多。</li>' +
      '<li><strong>为什么「我做了」会扣库存：</strong>只有真的消耗食材，闭环才会自转，统计也才真实。</li>' +
      '<li><strong>识别可插拔：</strong>默认本地模拟；在下方填入 OpenAI 兼容端点即可切换真实多模态模型，失败自动回退，交互不变。</li>' +
      '<li><strong>菜谱库：</strong>30 道内置中式家常菜为示例数据（含虾、牛奶、香蕉、苹果等易被漏掉的食材），可替换为真实菜谱 API，推荐逻辑无需改动。</li>' +
      '</ul>' +
      '<div class="divider"></div>' +
      '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
      '<button class="btn btn-sm" data-action="reset-demo">' + ic('refresh') + ' 恢复示例数据</button>' +
      '<button class="btn btn-sm btn-danger" data-action="confirm-clear">' + ic('trash') + ' 清空全部数据</button></div>';
    renderAIConfig();
    renderM4Box();
    renderBackupBox();
  }

  /* ---------- M5：真实 AI 识别配置面板 ----------
   * 密钥不回显到输入框（避免出现在 DOM 文本里）；留空表示沿用已保存的值。 */
  function renderAIConfig() {
    var badge = $('aiModeBadge'), box = $('aiConfigBox');
    if (!badge || !box || !A) return;
    var cfg = A.getConfig();
    var real = !!(cfg.enabled && cfg.baseUrl && cfg.model);
    badge.innerHTML = '<span class="tag ' + (real ? 'tag-ai' : 'tag-mock') + '">' +
      (real ? '真实 AI 已启用 · ' + esc(cfg.model) : '当前：演示识别') + '</span>';
    box.innerHTML =
      '<p class="muted small" style="margin-bottom:14px">填入 OpenAI 兼容的多模态接口即可启用真实识别；留空则保持离线演示。' +
      '密钥只保存在本机浏览器，不写入日志。识别失败、超时或返回无法解析时会自动回退演示模式。</p>' +
      '<div class="switch-row"><div><div style="font-size:13px">启用真实 AI 识别</div>' +
      '<div class="muted small">关闭时一律走本地模拟，方便随时对比</div></div>' +
      '<button class="switch ' + (cfg.enabled ? 'on' : '') + '" data-action="toggle-ai-enabled" aria-label="启用真实识别"></button></div>' +
      '<div class="config-grid">' +
      '<div class="form-row"><label class="form-label">Base URL（chat/completions 完整地址）</label>' +
      '<input class="field" id="aiBase" placeholder="http://127.0.0.1:8787/v1/chat/completions" value="' + esc(cfg.baseUrl) + '"></div>' +
      '<div class="form-row"><label class="form-label">模型名</label>' +
      '<input class="field" id="aiModel" placeholder="例如 hunyuan-vision" value="' + esc(cfg.model) + '"></div>' +
      '<div class="form-row"><label class="form-label">API Key（走本地代理时留空）</label>' +
      '<input class="field" id="aiKey" type="password" value="" placeholder="' +
      (cfg.apiKey ? '已保存，留空表示不修改' : '留空 = 由代理注入') + '"></div>' +
      '<div class="form-row"><label class="form-label">超时（毫秒）</label>' +
      '<input class="field" id="aiTimeout" type="number" min="3000" max="120000" value="' + (cfg.timeoutMs || 20000) + '"></div>' +
      '</div>' +
      '<div class="config-actions">' +
      '<button class="btn btn-primary btn-sm" data-action="save-ai">' + ic('check') + ' 保存配置</button>' +
      '<button class="btn btn-sm" data-action="test-ai">' + ic('spark') + ' 测试连接</button>' +
      '<button class="btn btn-sm" data-action="clear-ai">清除配置</button></div>' +
      '<div class="config-note"><b>① 代理（推荐）</b>：运行 ' +
      '<code>AI_BASE_URL=... AI_API_KEY=... AI_MODEL=... node ai-proxy.js</code>，' +
      'Base URL 填 <code>http://127.0.0.1:8787/v1/chat/completions</code>，Key 留空 —— 密钥只在环境变量里，浏览器接触不到，同时绕开 CORS。<br>' +
      '<b>② 直连</b>：直接填厂商端点与 Key（需该端点允许浏览器跨域）。<br>' +
      '图片先压到最长边 1024px 再上传；任何异常都会自动回退演示识别，不影响其他功能。</div>';
  }

  function updateBadges() {
    // 红点只标「≤3 天或已过期」的紧急件，避免 ≤7 天全量把角标刷成两位数
    var critical = E.nearItems(S).filter(function (x) {
      var s = E.statusOf(x); return s === 'urgent' || s === 'expired';
    }).length;
    var undone = S.shopping.filter(function (x) { return !x.checked; }).length;
    var safeLo = E.reuseSummary(S).safe;
    $('navFridgeBadge').textContent = critical || '';
    $('navShopBadge').textContent = undone || '';
    $('navLeftoverBadge').textContent = safeLo || '';
  }
  function renderAll() {
    renderHome(); renderFridge(); renderPlan(); renderShop(); renderStats();
    if (currentView === 'settings') renderSettings();
    if (currentView === 'leftover') renderLeftovers();
    updateBadges();
  }

  /* ============================================================
   * 模态框
   * ============================================================ */
  function openModal(title, body, foot) {
    $('modalRoot').innerHTML = '<div class="modal-mask" data-action="mask"><div class="modal">' +
      '<div class="modal-head"><h2>' + title + '</h2><button class="icon-btn" data-action="close-modal">' + ic('close') + '</button></div>' +
      '<div class="modal-body">' + body + '</div>' +
      (foot ? '<div class="modal-foot">' + foot + '</div>' : '') + '</div></div>';
    document.body.style.overflow = 'hidden';
  }
  function closeModal() { $('modalRoot').innerHTML = ''; document.body.style.overflow = ''; }

  function openAdd() {
    var opts = D.FOODS.map(function (f) {
      return '<option value="' + f.id + '">' + esc(f.name) + '（' + esc(f.cat) + '）</option>';
    }).join('');
    openModal('手动添加食材',
      '<div class="form-row"><label class="form-label">选择食材</label><select class="field" id="addFood">' + opts + '</select></div>' +
      '<div class="form-row"><label class="form-label">数量</label><input class="field" id="addQty" type="number" min="1" step="1" value="1"></div>' +
      '<div class="form-row"><label class="form-label">还能放几天（到期日会自动换算）</label><input class="field" id="addDays" type="number" min="0" max="720" value="7"></div>' +
      '<div class="used-note">小技巧：把天数填 1~3，就能立刻看到它在推荐里被优先安排。</div>',
      '<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="submit-add">加入冰箱</button>');
  }
  function submitAdd() {
    var id = $('addFood').value;
    var qty = Math.max(1, parseInt($('addQty').value, 10) || 1);
    var days = Math.max(0, parseInt($('addDays').value, 10) || 0);
    var f = E.foodById(id);
    S.inventory.push({ uid: uid(), foodId: id, qty: qty, expiryDate: E.addDays(E.todayStr(), days) });
    save(); refreshRecommend(); closeModal(); renderAll();
    toast('已加入 ' + f.name + '，' + (days === 0 ? '今天到期' : '剩 ' + days + ' 天') + '，推荐已同步更新');
  }

  function openScan() {
    scanCandidates = [];
    var cfg = A ? A.getConfig() : { enabled: false };
    var real = !!(cfg.enabled && cfg.baseUrl && cfg.model);
    var modeHtml = '<div class="scan-mode ' + (real ? 'ai' : 'mock') + '">' + ic(real ? 'spark' : 'info') +
      (real ? '真实 AI 识别 · 模型 ' + esc(cfg.model) + '（失败会自动回退演示识别）'
            : '演示识别 · 本地模拟，无需联网') +
      '<button class="link-btn" data-action="go-settings">去配置</button></div>';
    openModal('拍照录入食材',
      modeHtml +
      '<label class="scan-drop" for="scanFile">' + ic('camera') +
      '<p>点击选择一张冰箱 / 食材照片</p><span>AI 给出候选后由你勾选确认，识别结果不会直接入库</span></label>' +
      '<input type="file" id="scanFile" accept="image/*" style="display:none">' +
      '<div id="scanResult"></div>',
      '<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="submit-scan" id="scanSubmit" disabled>确认入库</button>');
  }
  function renderScanResult() {
    var box = $('scanResult'); if (!box) return;
    if (!scanCandidates.length) { box.innerHTML = ''; return; }
    var srcHtml = '<div class="scan-source ' + lastScanSource + '">' +
      (lastScanSource === 'ai'
        ? '真实 AI 识别完成' + (lastScanReason ? ' · ' + esc(lastScanReason) : '') + '，请核对后勾选'
        : '已回退到演示识别' + (lastScanReason ? '（' + esc(lastScanReason) + '）' : '') + '，请核对后勾选') +
      '</div>';
    box.innerHTML = '<div class="scan-result">' + srcHtml +
      '<div class="mini-title">识别结果 · 请勾选实际有的食材</div>' +
      scanCandidates.map(function (c, i) {
        var f = E.foodById(c.foodId);
        return '<label class="candidate"><input type="checkbox" data-cand="' + i + '"' + (c.checked ? ' checked' : '') + '>' +
          '<span class="c-name">' + esc(f.name) + '</span><span class="c-conf">置信度 ' + Math.round(c.confidence * 100) + '%</span></label>';
      }).join('') +
      '<div class="form-row" style="margin-top:14px"><label class="form-label">统一按剩余天数入库</label>' +
      '<input class="field" id="scanDays" type="number" min="0" max="720" value="5"></div></div>';
    $('scanSubmit').disabled = false;
  }
  function submitScan() {
    var days = Math.max(0, parseInt($('scanDays').value, 10) || 0);
    var picked = scanCandidates.filter(function (c) { return c.checked; });
    if (!picked.length) { toast('至少勾选一样食材'); return; }
    picked.forEach(function (c) {
      S.inventory.push({ uid: uid(), foodId: c.foodId, qty: 1, expiryDate: E.addDays(E.todayStr(), days) });
    });
    save(); refreshRecommend(); closeModal(); renderAll();
    toast('已确认入库 ' + picked.length + ' 样食材，推荐已同步更新');
  }

  function openRecipe(id) {
    var r = E.recipeById(id); if (!r) return;
    // M4 激活率埋点：「生成 → 看做法」是激活的关键一步
    if (S.m4) { S.m4.viewedRecipe = (S.m4.viewedRecipe || 0) + 1; save(); }
    pendingRecipeId = id;
    var owned = {}; S.inventory.forEach(function (x) { owned[x.foodId] = true; });
    var ing = r.ingredients.map(function (i) {
      var f = E.foodById(i.id);
      var miss = !owned[i.id] && !i.optional;
      return '<span class="ing-pill ' + (miss ? 'miss' : '') + '">' + esc(f.name) + ' ' + esc(i.qty) +
        (miss ? ' · 需买' : i.optional ? ' · 可选' : ' · 已有') + '</span>';
    }).join('');
    var score = E.scoreRecipe(r, S);
    var nutri = E.recipeNutrition(r);
    var nutriHtml = '<div class="mini-title">营养参考（整道估算）</div><div class="nutri-table">' +
      [['热量', nutri.kcal + ' kcal'], ['蛋白质', nutri.protein + ' g'], ['脂肪', nutri.fat + ' g'],
       ['碳水', nutri.carb + ' g'], ['膳食纤维', nutri.fiber + ' g']].map(function (nr) {
        return '<div class="nutri-row"><span>' + esc(nr[0]) + '</span><span>' + esc(nr[1]) + '</span></div>';
      }).join('') +
      '</div><div class="muted small" style="margin:6px 0 4px">每份约 ' + nutri.perServing.kcal + ' kcal（' + r.servings + ' 人份）· 含油盐估算，仅供参考</div>';
    openModal(esc(r.name),
      '<div class="muted small" style="margin-bottom:12px">' + esc(r.cat) + ' · ' + r.time + ' 分钟 · ' + esc(r.diff) +
      ' · ' + r.servings + ' 人份 · 约 ' + nutri.kcal + ' kcal · 口味' + esc(r.flavor) + '</div>' +
      (score ? '<div class="reason-list" style="margin-bottom:14px">' + score.reasons.map(function (rs) {
        return '<span class="tag tag-' + rs.type + '">' + esc(rs.text) + '</span>';
      }).join('') + '</div>' : '') +
      '<div class="mini-title">所需食材</div><div class="ing-list">' + ing + '</div>' +
      nutriHtml +
      '<div class="divider"></div><div class="mini-title">做法步骤</div>' +
      '<ol class="step-list">' + r.steps.map(function (s, i) {
        return '<li><span class="step-num">' + (i + 1) + '</span><span>' + esc(s) + '</span></li>';
      }).join('') + '</ol>',
      '<button class="btn" data-action="add-to-shop" data-id="' + r.id + '">加入清单</button>' +
      '<button class="btn btn-primary" data-action="open-feedback" data-id="' + r.id + '">我做了这道菜</button>');
  }

  function openFeedback(id) {
    var r = E.recipeById(id); if (!r) return;
    pendingRecipeId = id; modalRating = 5;
    var owned = {}; S.inventory.forEach(function (x) { owned[x.foodId] = true; });
    var willUse = r.ingredients.filter(function (i) {
      if (i.optional || !owned[i.id]) return false;
      var f = E.foodById(i.id);
      return f && f.cat !== '调味' && f.shelf <= 60; // 常备调味/耐储品不扣减
    }).map(function (i) { return esc(E.foodById(i.id).name); });
    openModal('做完了 · ' + esc(r.name),
      '<div class="form-row"><label class="form-label">这道菜合你口味吗？</label>' +
      '<div class="star-row" id="starRow">' + [1, 2, 3, 4, 5].map(function (n) {
        return '<button class="star ' + (n <= 5 ? 'on' : '') + '" data-action="set-star" data-n="' + n + '">' + ic('star') + '</button>';
      }).join('') + '</div><div class="muted small" id="starText" style="margin-top:6px">5 星 · 很喜欢</div></div>' +
      '<div class="form-row"><label class="check-item lo-check"><input type="checkbox" id="fbLeftover" checked> 这道菜有剩，顺手记进「剩菜盒」</label>' +
      '<div class="muted small" style="margin-top:6px">之后可在「剩菜利用」直接吃掉或改造成新菜，不会重复扣库存</div></div>' +
      '<div class="used-note">' + ic('refresh') + ' 确认后会从冰箱扣掉用到的食材，并把这次评分用于以后的推荐排序' +
      (willUse.length ? '。<br>本次预计消耗：' + willUse.join('、') : '') + '</div>',
      '<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="submit-feedback">确认完成</button>');
  }
  function setStar(n) {
    modalRating = n;
    var row = $('starRow'); if (!row) return;
    var btns = row.querySelectorAll('.star');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', i < n);
    $('starText').textContent = n + ' 星 · ' + ['', '不太合口味', '一般', '还不错', '挺喜欢', '很喜欢'][n];
  }
  /* 把一道菜「真正做完」：扣减库存（优先最早到期批）、写历史、记营养、同步购物清单。
   * 被「我做了」与「周菜单·完成」共用，保证两条入口的闭环行为完全一致。 */
  function consumeAndRecord(recipeId, rating) {
    var r = E.recipeById(recipeId); if (!r) return 0;
    var used = [];
    r.ingredients.forEach(function (i) {
      if (i.optional) return;
      var f = E.foodById(i.id); if (!f) return;
      if (f.cat === '调味' || f.shelf > 60) return; // 常备品不参与消耗
      // 同一样食材有多批库存时，优先消耗最早到期的那批，别把临期的留在冰箱里
      var idx = -1, best = Infinity;
      for (var k = 0; k < S.inventory.length; k++) {
        if (S.inventory[k].foodId !== i.id) continue;
        var dl = E.daysLeft(S.inventory[k].expiryDate);
        if (dl < best) { best = dl; idx = k; }
      }
      if (idx < 0) return;
      var inst = S.inventory[idx];
      var s = E.statusOf(inst);
      used.push({ foodId: i.id, qty: inst.qty, wasUrgent: (s !== 'ok') }); // 临期含 4~7 天
      var dec = (f.unit === 'g') ? 150 : 1; // 按 g 计价的按一份 150g 扣
      if (inst.qty <= dec) S.inventory.splice(idx, 1); else inst.qty -= dec;
    });
    S.history.push({ recipeId: r.id, rating: rating, date: E.todayStr(), usedIds: used });
    E.recordMeal(S, r);   // 把这道菜的营养记到今天，供「每日记录 / 每月回顾」使用
    // 做过的菜从清单里移除，避免重复采购
    S.selected = S.selected.filter(function (x) { return x !== r.id; });
    S.shopping = E.buildShoppingList(S.selected, S).map(function (n) {
      var old = S.shopping.filter(function (o) { return o.foodId === n.foodId && o.checked; })[0];
      return old ? Object.assign(n, { checked: true }) : n;
    });
    return used.length;
  }
  function submitFeedback() {
    var r = E.recipeById(pendingRecipeId); if (!r) { closeModal(); return; }
    // 勾选框必须在 closeModal 之前读，之后模态 DOM 就没了
    var loBox = $('fbLeftover');
    var hasLeftover = !!(loBox && loBox.checked);
    var used = consumeAndRecord(pendingRecipeId, modalRating);
    if (hasLeftover) addLeftoverFromRecipe(pendingRecipeId, true);
    save(); closeModal();
    refreshRecommend();
    renderAll();
    toast('已记录！用掉 ' + used.length + ' 样食材' + (hasLeftover ? '，剩菜已放进剩菜盒' : '') + '，下次推荐会更准');
  }

  /* ---------- 购物清单动作 ---------- */
  function addToShop(id) {
    if (S.selected.indexOf(id) < 0) S.selected.push(id);
    var prevChecked = {};
    S.shopping.forEach(function (x) { if (x.checked) prevChecked[x.foodId] = true; });
    S.shopping = E.buildShoppingList(S.selected, S).map(function (n) {
      return Object.assign(n, { checked: !!prevChecked[n.foodId] });
    });
    save(); renderAll();
    var r = E.recipeById(id);
    toast('已把「' + r.name + '」的缺料加进清单');
  }
  function purgeExpired() {
    var before = S.inventory.length;
    S.inventory = S.inventory.filter(function (x) { return E.statusOf(x) !== 'expired'; });
    var n = before - S.inventory.length;
    save(); refreshRecommend(); renderAll();
    toast(n ? '已清理 ' + n + ' 样过期食材' : '没有过期食材，冰箱很干净');
  }

  /* ============================================================
   * 全局事件委托
   * ============================================================ */
  document.addEventListener('click', function (ev) {
    var v = ev.target.closest('[data-view]');
    if (v) { switchView(v.getAttribute('data-view')); return; }
    var el = ev.target.closest('[data-action]');
    if (!el) return;
    var a = el.getAttribute('data-action');
    var id = el.getAttribute('data-id');

    if (a === 'mask') { if (ev.target === el) closeModal(); return; }
    ev.preventDefault();

    switch (a) {
      case 'close-modal': closeModal(); break;
      case 'generate': generate(); break;
      case 'go-settings': closeModal(); switchView('settings'); break;
      case 'install':
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function () { deferredPrompt = null; });
          var ib = document.getElementById('installBtn'); if (ib) ib.style.display = 'none';
          var ih = document.getElementById('installHint'); if (ih) ih.textContent = '已触发安装，按提示完成即可';
        } else {
          toast('当前环境暂不支持一键安装，请用浏览器菜单「添加到主屏幕 / 安装」');
        }
        break;
      case 'toggle-ai-enabled':
        A.setConfig({ enabled: !A.getConfig().enabled }); renderAIConfig(); break;
      case 'save-ai':
        var oldAi = A.getConfig();
        var keyVal = $('aiKey').value;
        A.setConfig({
          baseUrl: $('aiBase').value.trim(),
          model: $('aiModel').value.trim(),
          apiKey: keyVal || oldAi.apiKey,
          timeoutMs: Math.max(3000, parseInt($('aiTimeout').value, 10) || 20000)
        });
        renderAIConfig(); toast('AI 配置已保存'); break;
      case 'test-ai':
        toast('正在测试连接…');
        A.testConnection().then(function (r) {
          toast(r.ok ? r.message : '连接失败：' + r.message);
        });
        break;
      case 'clear-ai':
        A.clearConfig(); renderAIConfig(); toast('已清除配置，回到演示识别'); break;
      case 'open-add': openAdd(); break;
      case 'submit-add': submitAdd(); break;
      case 'open-scan': openScan(); break;
      case 'submit-scan': submitScan(); break;
      case 'delete-food':
        S.inventory = S.inventory.filter(function (x) { return x.uid !== el.getAttribute('data-uid'); });
        save(); refreshRecommend(); renderAll(); toast('已移除'); break;
      case 'purge-expired': purgeExpired(); break;
      case 'filter': filterCat = el.getAttribute('data-cat'); renderFridge(); break;
      case 'open-recipe': openRecipe(id); break;
      case 'add-to-shop': closeModal(); addToShop(id); break;
      case 'open-feedback': openFeedback(id); break;
      case 'set-star': setStar(parseInt(el.getAttribute('data-n'), 10)); break;
      case 'submit-feedback': submitFeedback(); break;
      case 'toggle-shop':
        S.shopping[parseInt(el.getAttribute('data-i'), 10)].checked = !S.shopping[parseInt(el.getAttribute('data-i'), 10)].checked;
        save(); renderShop(); updateBadges(); break;
      case 'clear-checked':
        S.shopping = S.shopping.filter(function (x) { return !x.checked; });
        save(); renderShop(); updateBadges(); toast('已清除已购项'); break;
      case 'copy-list':
        if (!S.shopping.length) { toast('清单还是空的'); break; }
        copyText(E.shoppingText(S.shopping), '清单已复制，粘贴到任意买菜 App 即可'); break;
      case 'platform':
        if (!S.shopping.length) { toast('清单还是空的'); break; }
        copyText(E.shoppingText(S.shopping), '清单已复制，打开「' + el.getAttribute('data-name') + '」粘贴即可'); break;
      case 'toggle-quick': S.prefs.quick = !S.prefs.quick; save(); refreshRecommend(); renderAll(); break;
      case 'toggle-remind': S.prefs.remind = !S.prefs.remind; save(); renderAll(); break;
      case 'save-prefs':
        S.prefs.people = parseInt($('prefPeople').value, 10);
        S.prefs.flavor = $('prefFlavor').value;
        S.prefs.goal = $('prefGoal').value;
        S.prefs.avoid = Array.prototype.slice.call(document.querySelectorAll('[data-avoid]:checked'))
          .map(function (x) { return x.getAttribute('data-avoid'); });
        save(); refreshRecommend(); renderAll(); switchView('plan');
        toast('偏好已保存，推荐已重新排序'); break;
      case 'reset-demo': rebuildState(true); refreshRecommend(); renderAll(); toast('已恢复示例数据（验证打卡记录已保留）'); break;
      case 'confirm-clear':
        openModal('确认清空全部数据？',
          '<p class="muted">这会删除冰箱库存、做饭记录、购物清单与偏好，并恢复为一份空冰箱。此操作不可撤销。</p>',
          '<button class="btn" data-action="close-modal">取消</button><button class="btn btn-danger" data-action="clear-all">确认清空</button>');
        break;
      case 'clear-all':
        rebuildState(false); refreshRecommend(); closeModal(); renderAll(); switchView('fridge');
        toast('已清空，现在可以添加真实食材了（验证打卡记录已保留）'); break;
      case 'm4-yes': m4Check(true); break;
      case 'm4-no': m4Check(false); break;
      case 'm4-export': exportM4Csv(); break;
      case 'nut-prev': nutMonth = shiftMonth(nutMonth || E.todayStr().slice(0, 7), -1); renderNutrition(); break;
      case 'nut-next': nutMonth = shiftMonth(nutMonth || E.todayStr().slice(0, 7), 1); renderNutrition(); break;
      case 'gen-week': genWeek(); break;
      case 'gen-week-confirm': doGenWeek(); break;
      case 'clear-week': clearWeek(); break;
      case 'clear-week-confirm': clearWeekConfirm(); break;
      case 'add-week': openWeekPicker(parseInt(el.getAttribute('data-day'), 10), el.getAttribute('data-slot')); break;
      case 'pick-week': pickWeek(id); break;
      case 'remove-week': removeWeekMeal(parseInt(el.getAttribute('data-day'), 10), el.getAttribute('data-slot')); break;
      case 'week-done': weekDone(id, parseInt(el.getAttribute('data-day'), 10)); break;
      case 'week-copy': weekCopyList(); break;
      case 'open-leftover-add': openLeftoverAdd(); break;
      case 'submit-leftover': submitLeftover(); break;
      case 'quick-leftover': quickLeftover(id); break;
      case 'lo-edit': openLeftoverAdd(el.getAttribute('data-uid')); break;
      case 'lo-eat': removeLeftover(el.getAttribute('data-uid'), 'eat'); break;
      case 'lo-discard': removeLeftover(el.getAttribute('data-uid'), 'discard'); break;
      case 'lo-remove': removeLeftover(el.getAttribute('data-uid'), 'remove'); break;
      case 'reuse-pick': toggleReusePick(id); break;
      case 'reuse-done': finishReuse([id], 'remake'); break;
      case 'reuse-batch': finishReuse(reusePicked.slice(), 'batch'); break;
      case 'backup-export': exportBackup(); break;
      case 'backup-pick': openBackupPicker(); break;
      case 'backup-import-confirm': confirmBackupImport(); break;
    }
  });

  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.id === 'backupFile' && t.files && t.files.length) {
      readBackupFile(t.files[0]);
    }
    if (t.id === 'scanFile' && t.files && t.files.length) {
      var file = t.files[0];
      var box = $('scanResult');
      if (box) box.innerHTML = '<div class="scan-loading">' + ic('refresh') + '识别中，请稍候…</div>';
      // 真实识别是异步网络请求；无论成功失败适配层都会 resolve，UI 不会卡住
      var job = A ? A.recognize(file) : Promise.resolve({
        items: E.simulateRecognition(file.name), source: 'mock', reason: '适配层未加载'
      });
      job.then(function (res) {
        if (!$('scanResult')) return; // 用户已关闭模态，丢弃结果
        scanCandidates = res.items || [];
        lastScanSource = res.source || 'mock';
        lastScanReason = res.reason || '';
        renderScanResult();
        toast(lastScanSource === 'ai' ? 'AI 识别完成，请勾选确认' : '演示识别完成，请勾选确认');
      });
    }
    if (t.hasAttribute && t.hasAttribute('data-cand')) {
      scanCandidates[parseInt(t.getAttribute('data-cand'), 10)].checked = t.checked;
    }
    if (t.hasAttribute && t.hasAttribute('data-avoid')) {
      var lab = t.closest('.check-item'); if (lab) lab.classList.toggle('on', t.checked);
    }
  });

  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeModal(); });

  /* ---------- PWA：安装到主屏提示（beforeinstallprompt 捕获） ---------- */
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();          // 阻止浏览器默认的小气泡，改用我们自己的按钮
    deferredPrompt = e;
    var btn = document.getElementById('installBtn');
    var hint = document.getElementById('installHint');
    if (btn) btn.style.display = '';
    if (hint) hint.textContent = '点击下方按钮，把它装到主屏';
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    var btn = document.getElementById('installBtn');
    var hint = document.getElementById('installHint');
    if (btn) btn.style.display = 'none';
    if (hint) hint.textContent = '已安装到主屏 ✓';
    toast('已安装到主屏，断网也能用');
  });

  /* ---------- 启动 ---------- */
  load();
  initM4();            // 每次打开记一次「今天来过」，是留存计算的原始依据
  refreshRecommend();
  renderAll();
  switchView('home');
})();
