/* ============================================================
 * engine.js —— 纯逻辑层（无 DOM、无副作用、可在 Node 里单测）
 * 理由：
 *  1) 推荐/统计/清单都是「输入 state → 输出结果」的纯函数，方便你逐条检查；
 *  2) 与界面解耦，日后把模拟数据换成真实大模型 API 只改这一层；
 *  3) 评分逻辑刻意做成「可解释」：每条推荐都会给出推荐理由，
 *     而不是黑盒打分 —— 这是与现有菜谱 App 的关键体验差异。
 * ============================================================ */
(function (w) {
  'use strict';

  var D = w.XZ_DATA;
  if (!D) { throw new Error('data.js 必须先于 engine.js 加载'); }

  /* ---------- 日期工具：统一用 YYYY-MM-DD 字符串，规避时区偏移 ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function toStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayStr() { return toStr(new Date()); }
  function addDays(dateStr, n) {
    var p = dateStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + n);
    return toStr(d);
  }
  function daysLeft(dateStr) {
    var p = dateStr.split('-');
    var a = new Date(+p[0], +p[1] - 1, +p[2]);
    var b = new Date(); b.setHours(0, 0, 0, 0);
    return Math.round((a - b) / 86400000);
  }
  function fmtDate(dateStr) {
    var p = dateStr.split('-');
    return +p[1] + '月' + (+p[2]) + '日';
  }
  /* 返回某日期所在周的周一（中国习惯周一开始），用于周菜单的周定位 */
  function mondayOf(dateStr) {
    var p = dateStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var wd = d.getDay();                 // 0=周日 .. 6=周六
    var diff = (wd === 0) ? -6 : (1 - wd);
    d.setDate(d.getDate() + diff);
    return toStr(d);
  }

  /* ---------- 基础查询 ---------- */
  function foodById(id) {
    for (var i = 0; i < D.FOODS.length; i++) { if (D.FOODS[i].id === id) return D.FOODS[i]; }
    return null;
  }
  function recipeById(id) {
    for (var i = 0; i < D.RECIPES.length; i++) { if (D.RECIPES[i].id === id) return D.RECIPES[i]; }
    return null;
  }
  function catStyle(cat) { return D.CATS[cat] || D.CATS['调味']; }

  /* ---------- 临期分级：过期 / 紧急(≤3天) / 留意(4~7天) / 正常 ---------- */
  function statusByDays(d) {
    if (d < 0) return 'expired';
    if (d <= 3) return 'urgent';
    if (d <= 7) return 'soon';
    return 'ok';
  }
  function statusOf(inst) { return statusByDays(daysLeft(inst.expiryDate)); }
  var STATUS_TEXT = { expired: '已过期', urgent: '马上要坏', soon: '留意', ok: '新鲜' };

  /* 「临期」统一定义为剩余 ≤7 天（含已过期）。
   * 修复背景：此前只有 ≤3 天算临期，剩 4~7 天的食材在概览、推荐加权里
   * 全部静默消失；用户看到的「临期食品没显示」多数来自这里。
   * 同一食材允许有多条库存（手动添加/拍照可重复），必须取最早到期的那条：
   * 否则后写入的较新鲜记录会把「1 天」覆盖成「3 天」，紧急加权不升反降。 */
  var NEAR_DAYS = 7;
  function nearExpiryMap(state) {
    var map = {};
    (state.inventory || []).forEach(function (it) {
      var dl = daysLeft(it.expiryDate);
      if (dl > NEAR_DAYS) return;
      if (!(it.foodId in map) || dl < map[it.foodId]) map[it.foodId] = dl;
    });
    return map;
  }
  function nearItems(state) {
    var map = nearExpiryMap(state);
    return (state.inventory || []).filter(function (it) {
      return it.foodId in map;
    }).sort(function (a, b) { return daysLeft(a.expiryDate) - daysLeft(b.expiryDate); });
  }

  /* ============================================================
   * 推荐引擎（核心）
   * 评分维度与权重，全部可追溯：
   *  + 库存覆盖率      ×60   —— 家里已有的越多越该做
   *  + 临期食材消耗    +18/+12/+6 —— ≤1天18，2~3天12，4~7天6（越急越优先）
   *  - 缺少食材        -6/样 —— 少买一样更省事
   *  + 口味匹配        +8
   *  + 快手偏好        +8
   *  + 健康目标        +10
   *  ± 历史反馈        (评分-3)×6，且每做过一次 -2 防吃腻
   *  - 份量偏差        -3/人
   *  忌口命中         直接排除
   *  已过期食材        不加分 —— 食品安全：不诱导食用，只在清单里提示丢弃
   * ============================================================ */
  function scoreRecipe(recipe, state) {
    var inv = state.inventory || [];
    var prefs = state.prefs || {};
    var history = state.history || [];
    var owned = {};
    inv.forEach(function (it) { owned[it.foodId] = true; });
    var nearMap = nearExpiryMap(state);

    // 忌口：任一食材命中即整道菜排除
    var avoid = prefs.avoid || [];
    if (avoid.length && recipe.ingredients.some(function (i) { return avoid.indexOf(i.id) >= 0; })) return null;

    var required = recipe.ingredients.filter(function (i) { return !i.optional; });
    var ownedCount = required.filter(function (i) { return owned[i.id]; }).length;
    var missing = required.filter(function (i) { return !owned[i.id]; }).map(function (i) { return i.id; });
    if (required.length === 0) return null;

    var score = (ownedCount / required.length) * 60;
    var nearSaved = [];
    recipe.ingredients.forEach(function (i) {
      var dl = nearMap[i.id];
      if (dl === undefined || dl < 0) return; // 已过期：不加分，避免诱导食用
      nearSaved.push(i.id);
      score += dl <= 1 ? 18 : dl <= 3 ? 12 : 6;
    });
    score -= missing.length * 6;
    if (prefs.flavor && recipe.flavor === prefs.flavor) score += 8;
    if (prefs.quick && recipe.time <= 15) score += 8;
    if (prefs.goal === '减脂' && recipe.tags.indexOf('低卡') >= 0) score += 10;
    if (prefs.goal === '增肌' && recipe.tags.indexOf('高蛋白') >= 0) score += 10;
    if (prefs.goal === '省时间' && recipe.time <= 15) score += 6;

    var mine = history.filter(function (h) { return h.recipeId === recipe.id; });
    if (mine.length) {
      var sum = 0;
      mine.forEach(function (h) { sum += (h.rating || 3); });
      score += ((sum / mine.length) - 3) * 6;
      score -= mine.length * 2; // 防重复，保证「每天不重样」
    }
    score -= Math.abs(recipe.servings - (prefs.people || 2)) * 3;

    // 生成人话理由，最多 4 条
    var reasons = [];
    if (nearSaved.length) {
      // 写出具体食材名，用户才能把「临期提醒」和「今晚推荐」一一对上
      var nearNames = nearSaved.slice(0, 3).map(function (id) {
        var f = foodById(id); return f ? f.name : id;
      }).join('、');
      reasons.push({ type: 'urgent', text: '先用掉临期：' + nearNames + (nearSaved.length > 3 ? ' 等' : '') });
    }
    if (ownedCount === required.length) {
      reasons.push({ type: 'good', text: '家里食材全都有，不用买' });
    } else {
      reasons.push({ type: 'info', text: '已有 ' + ownedCount + '/' + required.length + ' 样主料' });
    }
    if (recipe.time <= 15) reasons.push({ type: 'info', text: recipe.time + ' 分钟快手' });
    if (prefs.flavor && recipe.flavor === prefs.flavor) reasons.push({ type: 'good', text: '合你口味·' + recipe.flavor });
    if (mine.length) reasons.push({ type: 'info', text: '你上次给过 ' + mine[mine.length - 1].rating + ' 星' });

    return {
      recipe: recipe,
      score: Math.round(score * 10) / 10,
      ownedCount: ownedCount,
      requiredCount: required.length,
      missing: missing,
      urgentSaved: nearSaved,   // 兼容旧字段；语义已扩展为「剩余 ≤7 天的临期食材」
      nearSaved: nearSaved,
      reasons: reasons.slice(0, 4)
    };
  }

  function recommend(state, limit) {
    var out = [];
    D.RECIPES.forEach(function (r) {
      var s = scoreRecipe(r, state);
      if (s && s.ownedCount > 0) out.push(s); // 至少要有 1 样主料，否则推荐无意义
    });
    out.sort(function (a, b) { return b.score - a.score || a.recipe.time - b.recipe.time; });
    return out.slice(0, limit || 6);
  }

  /* ---------- 临期覆盖报告 ----------
   * 目的：Top6 只是排序结果，不保证覆盖每一件临期食材。
   * 这里逐件列出「冰箱里所有 ≤7 天的食材」及其可用菜谱与未出现的原因，
   * 让「今晚吃什么」对临期食材做到 100% 可见、可解释、可点开做。
   * 纯函数：第二参数是当前展示的菜谱 id 列表（用于标「已进入今晚推荐」）。 */
  function nearExpiryReport(state, shownRecipeIds) {
    var map = nearExpiryMap(state);
    var avoid = (state.prefs || {}).avoid || [];
    var shown = {};
    (shownRecipeIds || []).forEach(function (id) { shown[id] = true; });

    var candidates = [];
    D.RECIPES.forEach(function (r) {
      var s = scoreRecipe(r, state); // 忌口命中的菜在这里已被排除
      if (s && s.ownedCount > 0) candidates.push(s);
    });
    candidates.sort(function (a, b) { return b.score - a.score || a.recipe.time - b.recipe.time; });

    var rows = [];
    Object.keys(map).forEach(function (id) {
      var f = foodById(id);
      if (!f) return; // 脏数据直接跳过，不让界面崩
      var dl = map[id];
      var insts = (state.inventory || []).filter(function (it) {
        return it.foodId === id && daysLeft(it.expiryDate) <= NEAR_DAYS;
      });
      var earliest = insts.slice().sort(function (a, b) {
        return daysLeft(a.expiryDate) - daysLeft(b.expiryDate);
      })[0];
      var matches = candidates.filter(function (s) {
        return s.recipe.ingredients.some(function (i) { return i.id === id; });
      });
      rows.push({
        foodId: id,
        food: f,
        daysLeft: dl,
        status: statusByDays(dl),
        expired: dl < 0,
        qty: insts.reduce(function (sum, it) { return sum + (Number(it.qty) || 0); }, 0),
        unit: f.unit,
        expiryDate: earliest ? earliest.expiryDate : '',
        pantry: f.shelf >= 180,          // 常备耐储品：不强行配菜
        blockedByAvoid: avoid.indexOf(id) >= 0,
        recipes: matches.map(function (s) {
          return { id: s.recipe.id, name: s.recipe.name, score: s.score, shown: !!shown[s.recipe.id] };
        }),
        shownCount: matches.filter(function (s) { return !!shown[s.recipe.id]; }).length
      });
    });
    rows.sort(function (a, b) { return a.daysLeft - b.daysLeft; });
    return rows;
  }

  /* ---------- 购物清单：多道菜缺料合并去重 ---------- */
  function buildShoppingList(recipeIds, state) {
    var owned = {};
    (state.inventory || []).forEach(function (it) { owned[it.foodId] = true; });
    var map = {};
    recipeIds.forEach(function (rid) {
      var r = recipeById(rid);
      if (!r) return;
      r.ingredients.forEach(function (ing) {
        if (ing.optional || owned[ing.id]) return;
        if (!map[ing.id]) map[ing.id] = { foodId: ing.id, qty: ing.qty, from: [], checked: false };
        if (map[ing.id].from.indexOf(r.name) < 0) map[ing.id].from.push(r.name);
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function shoppingText(list) {
    if (!list.length) return '（清单为空）';
    var groups = {};
    list.forEach(function (it) {
      var f = foodById(it.foodId);
      var cat = f ? f.cat : '其他';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push((f ? f.name : it.foodId) + ' × ' + it.qty);
    });
    var lines = ['【鲜知 · 买菜清单】' + fmtDate(todayStr())];
    Object.keys(groups).forEach(function (cat) {
      lines.push('', '· ' + cat + '：' + groups[cat].join('、'));
    });
    return lines.join('\n');
  }

  /* ---------- 统计：把「少浪费」量化成钱和件数 ---------- */
  function computeStats(state) {
    var history = state.history || [];
    var savedItems = 0, moneySaved = 0, urgentSaved = 0, ratingSum = 0, rated = 0;
    history.forEach(function (h) {
      (h.usedIds || []).forEach(function (u) {
        savedItems++;
        var f = foodById(u.foodId);
        if (f) moneySaved += f.price * (u.qty || 1);
        if (u.wasUrgent) urgentSaved++;
      });
      if (h.rating) { ratingSum += h.rating; rated++; }
    });
    return {
      cookCount: history.length,
      savedItems: savedItems,
      urgentSaved: urgentSaved,
      moneySaved: Math.round(moneySaved * 10) / 10,
      avgRating: rated ? Math.round(ratingSum / rated * 10) / 10 : 0,
      generatedCount: state.generatedCount || 0,
      adoptRate: state.generatedCount ? Math.round(history.length / state.generatedCount * 100) : 0
    };
  }

  /* ============================================================
   * 营养计算
   * 菜谱 ingredients.qty 是人类可读文本（"2 个" / "150g" / "少许"），
   * 先统一换算成克，再按每 100g 营养累加。
   * 片 / 瓣 / 勺 / 碗 用全局小单位表；其余自然单位用 food.unitG；
   * "少许 / 适量" 等无法定量 → 0（调味微量，对总营养影响极小；
   *   烹调用油因此不计入，界面已标注「参考值，不含烹调用油」）。
   * ============================================================ */
  var SMALL_UNIT = { '片': 4, '瓣': 5, '勺': 15, '碗': 250 };
  function parseGrams(ing, food) {
    var q = ing.qty || '';
    var m;
    if ((m = q.match(/(\d+(?:\.\d+)?)\s*(?:g|克|ml|ML)/))) return parseFloat(m[1]);
    if ((m = q.match(/(\d+(?:\.\d+)?)\s*片/))) return parseFloat(m[1]) * SMALL_UNIT['片'];
    if ((m = q.match(/(\d+(?:\.\d+)?)\s*瓣/))) return parseFloat(m[1]) * SMALL_UNIT['瓣'];
    if ((m = q.match(/(\d+(?:\.\d+)?)\s*勺/))) return parseFloat(m[1]) * SMALL_UNIT['勺'];
    if ((m = q.match(/(\d+(?:\.\d+)?)\s*碗/))) return parseFloat(m[1]) * SMALL_UNIT['碗'];
    if ((m = q.match(/(\d+(?:\.\d+)?)/))) return parseFloat(m[1]) * (food && food.unitG ? food.unitG : 100);
    return 0;
  }
  function round1(x) { return Math.round(x * 10) / 10; }
  function recipeNutrition(recipe) {
    var total = { kcal: 0, P: 0, F: 0, C: 0, fiber: 0 };
    recipe.ingredients.forEach(function (ing) {
      var food = foodById(ing.id);
      if (!food || !food.nutrition) return;
      var g = parseGrams(ing, food);
      var n = food.nutrition;
      total.kcal += n.kcal * g / 100;
      total.P += n.P * g / 100;
      total.F += n.F * g / 100;
      total.C += n.C * g / 100;
      total.fiber += n.fiber * g / 100;
    });
    var per = recipe.servings || 1;
    return {
      kcal: Math.round(total.kcal),
      protein: round1(total.P), fat: round1(total.F), carb: round1(total.C), fiber: round1(total.fiber),
      perServing: {
        kcal: Math.round(total.kcal / per),
        protein: round1(total.P / per), fat: round1(total.F / per),
        carb: round1(total.C / per), fiber: round1(total.fiber / per)
      }
    };
  }

  /* 每日营养目标：按健康目标给预设；prefs.targetKcal 可手动覆盖。
   * 仅作为「均衡饮食参考」，不做医疗建议。 */
  function dailyGoal(prefs) {
    var goal = (prefs && prefs.goal) || '均衡';
    var g = ({
      '均衡': { kcal: 1800, protein: 60, fat: 50, carb: 240 },
      '减脂': { kcal: 1500, protein: 75, fat: 42, carb: 180 },
      '增肌': { kcal: 2200, protein: 95, fat: 62, carb: 290 },
      '省时间': { kcal: 1800, protein: 60, fat: 50, carb: 240 }
    })[goal] || { kcal: 1800, protein: 60, fat: 50, carb: 240 };
    if (prefs && prefs.targetKcal) g = Object.assign({}, g, { kcal: prefs.targetKcal });
    return g;
  }

  /* 把一道菜的营养记录到「今天」的日志（被 app 的「我做了」调用）。
   * 按整道菜记录：做了一道菜即记一道，家庭多人共食场景更直观。 */
  function recordMeal(state, recipe) {
    if (!state.nutritionLog) state.nutritionLog = {};
    var nutri = recipeNutrition(recipe);
    var today = todayStr();
    var entry = state.nutritionLog[today] || {
      meals: [],
      totals: { kcal: 0, protein: 0, fat: 0, carb: 0, fiber: 0 }
    };
    entry.meals.push({
      recipeId: recipe.id, name: recipe.name,
      kcal: nutri.kcal, protein: nutri.protein, fat: nutri.fat, carb: nutri.carb, fiber: nutri.fiber
    });
    entry.totals = {
      kcal: entry.totals.kcal + nutri.kcal,
      protein: round1(entry.totals.protein + nutri.protein),
      fat: round1(entry.totals.fat + nutri.fat),
      carb: round1(entry.totals.carb + nutri.carb),
      fiber: round1(entry.totals.fiber + nutri.fiber)
    };
    state.nutritionLog[today] = entry;
    return entry;
  }

  /* 月度回顾：给定 'YYYY-MM'，返回当月每日热量（有无记录）、累计、日均、最常做的菜。
   * 纯函数，便于单测与界面复用。 */
  function monthlyReport(state, yearMonth) {
    var log = state.nutritionLog || {};
    var parts = String(yearMonth).split('-');
    var year = +parts[0], month = +parts[1];
    var daysInMonth = new Date(year, month, 0).getDate();
    var sumKcal = 0, sumP = 0, sumF = 0, sumC = 0, sumFiber = 0, daysWithData = 0, recipeCount = 0;
    var freq = {};
    var days = [];
    for (var d = 1; d <= daysInMonth; d++) {
      var ds = year + '-' + pad(month) + '-' + pad(d);
      var entry = log[ds];
      if (entry) {
        daysWithData++;
        sumKcal += entry.totals.kcal;
        sumP += entry.totals.protein; sumF += entry.totals.fat;
        sumC += entry.totals.carb; sumFiber += entry.totals.fiber;
        entry.meals.forEach(function (m) {
          recipeCount++;
          freq[m.name] = (freq[m.name] || 0) + 1;
        });
        days.push({ date: ds, kcal: entry.totals.kcal, has: true });
      } else {
        days.push({ date: ds, kcal: 0, has: false });
      }
    }
    var topRecipes = Object.keys(freq).map(function (k) { return { name: k, count: freq[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 3);
    return {
      year: year, month: month, daysInMonth: daysInMonth, days: days,
      daysWithData: daysWithData, recipeCount: recipeCount,
      totals: { kcal: sumKcal, protein: round1(sumP), fat: round1(sumF), carb: round1(sumC), fiber: round1(sumFiber) },
      avg: daysWithData ? {
        kcal: Math.round(sumKcal / daysWithData),
        protein: round1(sumP / daysWithData), fat: round1(sumF / daysWithData),
        carb: round1(sumC / daysWithData), fiber: round1(sumFiber / daysWithData)
      } : { kcal: 0, protein: 0, fat: 0, carb: 0, fiber: 0 },
      topRecipes: topRecipes
    };
  }

  /* ============================================================
   * 周菜单规划（P0-1）
   * 目标：把冰箱里快坏的食材排进未来 7 天，自动生成早午晚，减少决策疲劳与浪费。
   * 全部为纯函数，便于单测与界面复用。
   * 设计取舍：
   *  1) 临期食材优先锚定到本周更早的餐次（dinner→lunch→breakfast 偏序），
   *     保证快坏的先被吃掉，而非只是排进推荐列表；
   *  2) 单道菜整周最多出现 2 次，保证「每天不重样」；
   *  3) 早餐偏向轻快 / 免开火 / 一人食类，贴合真实作息；
   *  4) 周采购清单直接复用 buildShoppingList（已扣除当前库存），
   *     周营养概览基于 recipeNutrition 累加，与「每日记录」同一口径。
   * ============================================================ */
  function weekMealsSkeleton() {
    var m = {};
    for (var d = 0; d < 7; d++) m[d] = { breakfast: null, lunch: null, dinner: null };
    return m;
  }
  function isLight(r) {
    if (!r) return false;
    if (r.kcal <= 260) return true;
    var t = r.tags || [];
    return t.indexOf('免开火') >= 0 || t.indexOf('早餐') >= 0 ||
           t.indexOf('快手') >= 0 || t.indexOf('一人食') >= 0 || t.indexOf('凉菜') >= 0;
  }
  function generateWeekPlan(state) {
    var weekStart = mondayOf(todayStr());
    var meals = weekMealsSkeleton();
    var scored = recommend(state, 60);
    var pool = scored.map(function (x) { return x.recipe; });
    if (pool.length < 14) pool = recommend(state, 120).map(function (x) { return x.recipe; });

    var usedCount = {};
    function placeEarliest(rid) {
      var order = ['dinner', 'lunch', 'breakfast'];
      for (var d = 0; d < 7; d++) {
        for (var s = 0; s < order.length; s++) {
          var slot = order[s];
          if (!meals[d][slot]) { meals[d][slot] = rid; return true; }
        }
      }
      return false;
    }
    // 1) 临期锚定：每件 ≤7 天且未过期/未忌口/非常备的食材，挑一道用它的菜放到最早的空餐次
    var near = nearExpiryReport(state, []);
    near.forEach(function (row) {
      if (row.expired || row.pantry || row.blockedByAvoid || !row.recipes.length) return;
      var cand = pool.filter(function (r) {
        return (usedCount[r.id] || 0) < 2 && r.ingredients.some(function (i) { return i.id === row.foodId; });
      });
      if (!cand.length) return;
      var rid = cand[0].id;
      if (placeEarliest(rid)) usedCount[rid] = (usedCount[rid] || 0) + 1;
    });
    // 2) 填充剩余空位：早餐偏轻快，其余按推荐分依次取，单菜 ≤2 次
    function pick(lightOnly) {
      for (var i = 0; i < pool.length; i++) {
        var r = pool[i];
        if ((usedCount[r.id] || 0) >= 2) continue;
        if (lightOnly && !isLight(r)) continue;
        usedCount[r.id] = (usedCount[r.id] || 0) + 1;
        return r.id;
      }
      return null;
    }
    for (var d2 = 0; d2 < 7; d2++) {
      ['breakfast', 'lunch', 'dinner'].forEach(function (slot) {
        if (meals[d2][slot]) return;
        var rid = pick(slot === 'breakfast');
        if (rid) meals[d2][slot] = rid;
      });
    }
    return { weekStart: weekStart, meals: meals };
  }
  function weekRecipeIds(plan) {
    var ids = [];
    if (!plan || !plan.meals) return ids;
    for (var d = 0; d < 7; d++) {
      ['breakfast', 'lunch', 'dinner'].forEach(function (slot) {
        var rid = plan.meals[d][slot];
        if (rid) ids.push(rid);
      });
    }
    return ids;
  }
  function weekShoppingList(plan, state) {
    return buildShoppingList(weekRecipeIds(plan), state);
  }
  function weekNutritionSummary(plan) {
    var total = { kcal: 0, protein: 0, fat: 0, carb: 0, fiber: 0 }, count = 0;
    weekRecipeIds(plan).forEach(function (rid) {
      var r = recipeById(rid); if (!r) return;
      var n = recipeNutrition(r);
      total.kcal += n.kcal; total.protein += n.protein; total.fat += n.fat;
      total.carb += n.carb; total.fiber += n.fiber; count++;
    });
    return {
      count: count,
      total: { kcal: total.kcal, protein: round1(total.protein), fat: round1(total.fat), carb: round1(total.carb), fiber: round1(total.fiber) },
      avgPerDay: {
        kcal: Math.round(total.kcal / 7), protein: round1(total.protein / 7),
        fat: round1(total.fat / 7), carb: round1(total.carb / 7), fiber: round1(total.fiber / 7)
      }
    };
  }

  /* ============================================================
   * C4 剩菜再利用
   * 与生鲜库存分开建模：leftovers[] 是「已做成菜但没吃完」的熟食，或用户
   * 手动登记的零散边角料。它们不进 inventory —— 食材在第一次做菜时已经
   * 扣减过，再利用时再扣一次会重复扣库存、重复记营养。
   * 食品安全：熟食冷藏建议 2 天内吃完；超期的只提示丢弃，绝不进入方案
   * （与 scoreRecipe「已过期食材不加分」保持一致）。
   * ============================================================ */
  var REUSE_SHELF_DAYS = 2;
  function dateDiff(a, b) {
    var pa = a.split('-'), pb = b.split('-');
    return Math.round((new Date(+pb[0], +pb[1] - 1, +pb[2]) -
                       new Date(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
  }
  function leftoverStatus(lv, today) {
    var t = today || todayStr();
    var due = addDays(lv.date || t, REUSE_SHELF_DAYS);
    var left = dateDiff(t, due);
    return {
      due: due, daysLeft: left, safe: left >= 0, expired: left < 0,
      label: left < 0 ? '已超建议期 · 建议丢弃'
           : left === 0 ? '今天吃掉'
           : left === 1 ? '明天前吃掉' : '还可放 ' + left + ' 天'
    };
  }
  /* 一份剩菜的价值按它关联的食材参考价累加，用于「少浪费」量化（估算值） */
  function leftoverValue(lv) {
    var sum = 0;
    (lv.foodIds || []).forEach(function (id) { var f = foodById(id); if (f) sum += f.price; });
    return Math.round(sum * 10) / 10;
  }
  function safeLeftovers(state, today) {
    return (state.leftovers || []).filter(function (lv) { return leftoverStatus(lv, today).safe; });
  }
  function reuseFoodIds(state, today) {
    var set = {};
    safeLeftovers(state, today).forEach(function (lv) {
      (lv.foodIds || []).forEach(function (id) { if (foodById(id)) set[id] = true; });
    });
    return set;
  }
  /* 方案排序完全复用 scoreRecipe 的忌口 / 临期 / 口味 / 历史 / 份量逻辑，
   * 再叠加「命中剩料数 ×22」与「清库存标签 +10」；命中 0 样的菜不出现。 */
  function reuseIdeas(state, today, limit) {
    var set = reuseFoodIds(state, today);
    if (!Object.keys(set).length) return [];
    // 熟食剩菜若是某道菜剩下的，就不再推荐「原样重做这道菜」
    var origin = {};
    safeLeftovers(state, today).forEach(function (lv) { if (lv.fromRecipeId) origin[lv.fromRecipeId] = true; });
    var out = [];
    D.RECIPES.forEach(function (r) {
      if (origin[r.id]) return;
      var base = scoreRecipe(r, state);
      if (!base) return;                       // 忌口命中，整道菜排除
      var hits = [];
      r.ingredients.forEach(function (i) {
        if (!i.optional && set[i.id] && hits.indexOf(i.id) < 0) hits.push(i.id);
      });
      if (!hits.length) return;
      var bonus = hits.length * 22 + ((r.tags || []).indexOf('清库存') >= 0 ? 10 : 0);
      out.push({
        recipe: r,
        score: Math.round((base.score + bonus - base.missing.length * 2) * 10) / 10,
        hits: hits, hitCount: hits.length,
        hitNames: hits.map(function (id) { return foodById(id).name; }),
        missing: base.missing,
        missingNames: base.missing.map(function (id) { var f = foodById(id); return f ? f.name : id; }),
        kcal: recipeNutrition(r).kcal, time: r.time,
        reuseTagged: (r.tags || []).indexOf('清库存') >= 0
      });
    });
    out.sort(function (a, b) { return b.score - a.score || b.hitCount - a.hitCount || a.recipe.time - b.recipe.time; });
    return out.slice(0, limit || 8);
  }
  /* 「凑一锅」覆盖：勾选多道菜时实时算出一共能吃掉几样剩料、还剩哪些没安排 */
  function reuseCoverage(state, recipeIds, today) {
    var set = reuseFoodIds(state, today);
    var covered = {};
    (recipeIds || []).forEach(function (rid) {
      var r = recipeById(rid); if (!r) return;
      r.ingredients.forEach(function (i) { if (!i.optional && set[i.id]) covered[i.id] = true; });
    });
    var all = Object.keys(set);
    function names(ids) { return ids.map(function (id) { var f = foodById(id); return f ? f.name : id; }); }
    var coveredIds = all.filter(function (id) { return covered[id]; });
    var restIds = all.filter(function (id) { return !covered[id]; });
    return {
      total: all.length, coveredCount: coveredIds.length,
      coveredIds: coveredIds, uncoveredIds: restIds,
      coveredNames: names(coveredIds), uncoveredNames: names(restIds)
    };
  }
  function reuseSummary(state, today) {
    var t = today || todayStr();
    var lvs = state.leftovers || [];
    var safe = 0, overdue = 0;
    lvs.forEach(function (lv) { leftoverStatus(lv, t).safe ? safe++ : overdue++; });
    var log = state.reuseLog || [];
    var items = 0, money = 0, month = 0;
    log.forEach(function (x) {
      items += x.itemCount || 0;
      money += x.money || 0;
      if ((x.date || '').slice(0, 7) === t.slice(0, 7)) month++;
    });
    return {
      total: lvs.length, safe: safe, overdue: overdue, handled: log.length,
      savedItems: items, money: Math.round(money * 10) / 10, thisMonth: month
    };
  }

  /* ---------- 模拟拍照识别 ----------
   * 真实产品里这一步换成多模态大模型 API（返回食材 + 置信度），
   * 但「AI 给出候选 → 用户勾选确认」的交互流程完全一致。
   * 保留人工确认，是因为识别错了让用户改，比识别错了直接入库安全得多。 */
  function simulateRecognition(fileName) {
    var name = (fileName || '').toLowerCase();
    var rules = [
      { keys: ['tomato', '番茄', '西红柿', '柿'], ids: ['tomato', 'egg', 'scallion'] },
      { keys: ['egg', '蛋'], ids: ['egg', 'tomato', 'scallion'] },
      { keys: ['pepper', '椒', '青椒'], ids: ['pepper', 'pork', 'potato'] },
      { keys: ['meat', 'pork', '肉'], ids: ['pork', 'pepper', 'ginger'] },
      { keys: ['tofu', '豆腐', '豆'], ids: ['tofu', 'scallion', 'pepper'] },
      { keys: ['fridge', '冰箱', '菜', 'vegetable', 'img', 'photo', 'image'], ids: ['tomato', 'pepper', 'tofu', 'cucumber', 'egg'] }
    ];
    var ids = null;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].keys.some(function (k) { return name.indexOf(k) >= 0; })) { ids = rules[i].ids; break; }
    }
    if (!ids) ids = ['tomato', 'pepper', 'egg', 'tofu']; // 兜底：给出常见候选
    return ids.map(function (id, idx) {
      return { foodId: id, confidence: Math.max(0.72, 0.96 - idx * 0.06 - Math.random() * 0.05), checked: true };
    });
  }

  /* ============================================================
   * M4 冷启动验证数据导出
   * 设计要点：导出「从 startedAt 到今天」的连续日期，而不是只导出有记录的日子。
   * 缺勤日 opened=0 是留存计算的分母，只导出打卡日会把留存算成 100%。
   * 纯函数、不碰 DOM / localStorage，便于 verify.js 单测。
   * ============================================================ */
  function m4ExportRows(state, today) {
    var s = state || {};
    var m4 = s.m4 || {};
    var end = today || todayStr();
    var start = m4.startedAt || end;
    var days = [], cur = start, guard = 0;
    while (cur <= end && guard < 400) { days.push(cur); cur = addDays(cur, 1); guard++; }

    var checkIns = m4.checkIns || {};
    var hist = s.history || [];
    var stats = computeStats(s);
    return days.map(function (d) {
      var c = checkIns[d] || {};
      var cookedToday = hist.filter(function (h) { return h.date === d; }).length;
      return {
        date: d,
        userId: m4.userId || '',
        baseline: m4.baseline || '',
        startedAt: start,
        opened: (c.opened || cookedToday > 0) ? 1 : 0,   // 当天做过饭必然打开过，兜底防漏记
        cooked: (c.cooked === true || c.cooked === false) ? (c.cooked ? 1 : 0) : '',
        cookCount: cookedToday,
        viewedRecipe: m4.viewedRecipe || 0,
        generatedCount: s.generatedCount || 0,
        urgentSaved: stats.urgentSaved,
        blocker: c.blocker || ''
      };
    });
  }

  var M4_COLS = ['date', 'userId', 'baseline', 'startedAt', 'opened', 'cooked',
                 'cookCount', 'viewedRecipe', 'generatedCount', 'urgentSaved', 'blocker'];
  function m4Cell(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function m4ToCsv(state, today) {
    var rows = m4ExportRows(state, today);
    var lines = [M4_COLS.join(',')];
    rows.forEach(function (r) {
      lines.push(M4_COLS.map(function (c) { return m4Cell(r[c]); }).join(','));
    });
    return lines.join('\r\n');
  }

  /* ============================================================
   * B2：全量数据备份（本地 JSON，不联网、不改隐私承诺）
   * 目的：换设备 / 清缓存 / 误点清空后能把整个状态搬回来，包括 14 天打卡记录。
   * 设计：纯函数层只做「白名单 + 结构校验 + 清洗」，存储与 UI 交给 app.js。
   * 导入的文件是不可信输入，因此必须限制数组长度、字符串长度与对象键数，
   * 并过滤 __proto__ / constructor / prototype，避免原型污染与超大文件卡死页面。
   * ============================================================ */
  var APP_BUILD = '1.6.2';
  var BACKUP_APP = 'xianzhi.fridge';
  var BACKUP_SCHEMA = 1;
  var BACKUP_FIELDS = ['version', 'inventory', 'prefs', 'history', 'shopping', 'selected',
    'generatedIds', 'generatedCount', 'lastGeneratedAt', 'nutritionLog', 'weekPlan',
    'leftovers', 'reuseLog', 'm4'];
  var BACKUP_LIMITS = { arrays: 5000, text: 500, keys: 400 };
  var BACKUP_BLOCKED_KEYS = ['__proto__', 'constructor', 'prototype'];

  function backupSanitize(v, depth) {
    if (depth > 6) return null;
    if (typeof v === 'string') return v.slice(0, BACKUP_LIMITS.text);
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
    if (Array.isArray(v)) {
      return v.slice(0, BACKUP_LIMITS.arrays).map(function (x) {
        return backupSanitize(x, depth + 1);
      });
    }
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).slice(0, BACKUP_LIMITS.keys).forEach(function (k) {
        if (BACKUP_BLOCKED_KEYS.indexOf(k) >= 0) return;
        out[k] = backupSanitize(v[k], depth + 1);
      });
      return out;
    }
    return null;
  }
  function backupNowText(d) {
    var x = d || new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()) +
      ' ' + p(x.getHours()) + ':' + p(x.getMinutes());
  }
  function makeBackup(state, nowText) {
    var clean = {};
    BACKUP_FIELDS.forEach(function (k) {
      if (state && state[k] !== undefined && state[k] !== null) {
        clean[k] = backupSanitize(state[k], 0);
      }
    });
    return {
      app: BACKUP_APP,
      schemaVersion: BACKUP_SCHEMA,
      build: APP_BUILD,
      exportedAt: String(nowText || backupNowText()),
      state: clean
    };
  }
  function backupToText(state, nowText) {
    return JSON.stringify(makeBackup(state, nowText), null, 2);
  }
  function parseBackup(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4 * 1024 * 1024) {
      return { ok: false, reason: '文件为空或超过 4MB' };
    }
    var obj;
    try { obj = JSON.parse(text); } catch (e) {
      return { ok: false, reason: '不是有效的 JSON 文件' };
    }
    if (!obj || typeof obj !== 'object' || obj.app !== BACKUP_APP) {
      return { ok: false, reason: '不是鲜知的备份文件' };
    }
    if (obj.schemaVersion !== BACKUP_SCHEMA) {
      return { ok: false, reason: '备份格式不兼容（schemaVersion ' + obj.schemaVersion + '）' };
    }
    var st = obj.state;
    if (!st || typeof st !== 'object' || Array.isArray(st)) {
      return { ok: false, reason: '备份缺少数据内容' };
    }
    if (!Array.isArray(st.inventory) || !st.prefs ||
        typeof st.prefs !== 'object' || Array.isArray(st.prefs) ||
        !Array.isArray(st.history)) {
      return { ok: false, reason: '数据结构不完整（库存 / 偏好 / 做饭记录）' };
    }
    var bigArrays = ['inventory', 'history', 'shopping', 'selected', 'generatedIds', 'leftovers', 'reuseLog'];
    for (var i = 0; i < bigArrays.length; i++) {
      var k = bigArrays[i];
      if (Array.isArray(st[k]) && st[k].length > BACKUP_LIMITS.arrays) {
        return { ok: false, reason: k + ' 数据量超出上限，已拒绝导入' };
      }
    }
    var clean = {};
    BACKUP_FIELDS.forEach(function (k) {
      if (st[k] !== undefined && st[k] !== null) clean[k] = backupSanitize(st[k], 0);
    });
    // m4 打卡记录必须完整保留，否则换设备后 14 天验证会断档
    if (!clean.m4 || typeof clean.m4 !== 'object' || Array.isArray(clean.m4)) clean.m4 = {};
    if (!clean.m4.checkIns || typeof clean.m4.checkIns !== 'object' || Array.isArray(clean.m4.checkIns)) {
      clean.m4.checkIns = {};
    }
    return {
      ok: true,
      state: clean,
      exportedAt: String(obj.exportedAt || '').slice(0, BACKUP_LIMITS.text),
      build: String(obj.build || '').slice(0, BACKUP_LIMITS.text),
      counts: {
        inventory: (clean.inventory || []).length,
        history: (clean.history || []).length,
        leftovers: (clean.leftovers || []).length,
        checkInDays: Object.keys(clean.m4.checkIns).length
      }
    };
  }

  w.XZ_ENGINE = {
    // 构建号：index.html 会核对它，防止 Service Worker 旧缓存把新页面与旧脚本混在一起。
    // 每次发版必须同时更新 engine.js 的 BUILD 与 index.html 的 XZ_EXPECT_BUILD。
    BUILD: APP_BUILD,
    todayStr: todayStr, addDays: addDays, daysLeft: daysLeft, fmtDate: fmtDate, mondayOf: mondayOf,
    foodById: foodById, recipeById: recipeById, catStyle: catStyle,
    statusOf: statusOf, statusByDays: statusByDays, STATUS_TEXT: STATUS_TEXT,
    nearExpiryMap: nearExpiryMap, nearItems: nearItems, nearExpiryReport: nearExpiryReport,
    scoreRecipe: scoreRecipe, recommend: recommend,
    buildShoppingList: buildShoppingList, shoppingText: shoppingText,
    computeStats: computeStats, simulateRecognition: simulateRecognition,
    recipeNutrition: recipeNutrition, parseGrams: parseGrams, dailyGoal: dailyGoal,
    recordMeal: recordMeal, monthlyReport: monthlyReport,
    generateWeekPlan: generateWeekPlan, weekShoppingList: weekShoppingList, weekNutritionSummary: weekNutritionSummary,
    m4ExportRows: m4ExportRows, m4ToCsv: m4ToCsv, M4_COLS: M4_COLS,
    REUSE_SHELF_DAYS: REUSE_SHELF_DAYS, dateDiff: dateDiff,
    leftoverStatus: leftoverStatus, leftoverValue: leftoverValue,
    safeLeftovers: safeLeftovers, reuseFoodIds: reuseFoodIds,
    reuseIdeas: reuseIdeas, reuseCoverage: reuseCoverage, reuseSummary: reuseSummary,
    BACKUP_APP: BACKUP_APP, BACKUP_SCHEMA: BACKUP_SCHEMA,
    backupNowText: backupNowText, makeBackup: makeBackup,
    backupToText: backupToText, parseBackup: parseBackup
  };
})(typeof window !== 'undefined' ? window : globalThis);
