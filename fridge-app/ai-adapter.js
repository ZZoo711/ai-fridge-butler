/* ============================================================
 * ai-adapter.js —— M5 真实多模态识别适配层（可插拔）
 *
 * 设计理由：
 *  1) 只替换 engine.js 的 simulateRecognition，不动推荐/清单/统计逻辑，
 *     「AI 候选 → 人工勾选确认」的交互完全不变（PRD §14 M5 约定）。
 *  2) 默认未配置时自动回退本地模拟 —— 离线演示永不崩，也不误导用户。
 *  3) 采用 OpenAI 兼容的 chat/completions + image_url 格式，
 *     换个 baseUrl/model 就能接混元、通义、豆包、OpenAI 等任意厂商。
 *  4) 密钥只存本机 localStorage，不写日志、不进页面文本；也支持
 *     Key 完全不进浏览器 —— 走同目录 ai-proxy.js 由环境变量注入。
 *  5) 图片先压缩再上传，控制 token/费用；请求带超时，任何失败都回退。
 *  6) 纯函数式的解析与映射单独导出，方便离线自检（verify.js 第 9 节）。
 * ============================================================ */
(function (w) {
  'use strict';

  var D = w.XZ_DATA;
  var E = w.XZ_ENGINE;
  var KEY = 'xianzhi.ai.v1';

  var DEFAULTS = {
    enabled: false,
    baseUrl: '',      // 例：https://api.xxx.com/v1/chat/completions 或 http://127.0.0.1:8787/v1/chat/completions
    apiKey: '',       // 留空 = 使用本地代理（代理端用环境变量注入 Key）
    model: '',        // 例：hunyuan-vision / qwen-vl-max / gpt-4o-mini
    timeoutMs: 20000,
    maxSide: 1024     // 图片压缩最长边
  };

  function merge(base, saved, opts) {
    var o = {};
    Object.keys(base).forEach(function (k) { o[k] = base[k]; });
    Object.keys(saved || {}).forEach(function (k) { o[k] = saved[k]; });
    Object.keys(opts || {}).forEach(function (k) { o[k] = opts[k]; });
    return o;
  }
  function getConfig() {
    try {
      var raw = w.localStorage && w.localStorage.getItem(KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return merge(DEFAULTS, obj, null);
    } catch (e) { return merge(DEFAULTS, null, null); }
  }
  function setConfig(cfg) {
    var next = merge(DEFAULTS, getConfig(), cfg || {});
    try { w.localStorage && w.localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) {}
    return next;
  }
  function clearConfig() {
    try { w.localStorage && w.localStorage.removeItem(KEY); } catch (e) {}
  }

  /* ---------- 食材名归一化：模型输出中文俗名，需映射到库内 id ----------
   * 顺序有意义：更具体的词放前面，避免「鸡蛋」被单字「蛋」抢先命中。 */
  var ALIAS = [
    ['西红柿', 'tomato'], ['番茄', 'tomato'], ['圣女果', 'tomato'],
    ['鸡蛋', 'egg'], ['土鸡蛋', 'egg'], ['鸭蛋', 'egg'],
    ['青椒', 'pepper'], ['尖椒', 'pepper'], ['柿子椒', 'pepper'], ['彩椒', 'pepper'],
    ['马铃薯', 'potato'], ['土豆', 'potato'],
    ['洋葱', 'onion'], ['圆葱', 'onion'],
    ['五花肉', 'pork'], ['里脊', 'pork'], ['猪肉', 'pork'], ['肉馅', 'pork'], ['瘦肉', 'pork'],
    ['豆腐', 'tofu'], ['豆制品', 'tofu'],
    ['小葱', 'scallion'], ['大葱', 'scallion'], ['香葱', 'scallion'], ['葱', 'scallion'],
    ['生姜', 'ginger'], ['姜', 'ginger'],
    ['大蒜', 'garlic'], ['蒜瓣', 'garlic'], ['蒜', 'garlic'],
    ['生抽', 'soy'], ['酱油', 'soy'],
    ['黄瓜', 'cucumber'], ['胡萝卜', 'carrot'], ['茄子', 'eggplant'],
    ['西兰花', 'broccoli'], ['花椰菜', 'broccoli'],
    ['小白菜', 'greens'], ['青菜', 'greens'], ['油菜', 'greens'], ['菠菜', 'greens'],
    ['香菇', 'mushroom'], ['金针菇', 'mushroom'], ['蘑菇', 'mushroom'],
    ['鸡翅', 'chicken'], ['鸡肉', 'chicken'],
    ['虾', 'shrimp'], ['鲜鱼', 'fish'], ['鱼', 'fish'], ['紫菜', 'seaweed'],
    ['牛奶', 'milk'], ['香蕉', 'banana'], ['苹果', 'apple'],
    ['挂面', 'noodle'], ['面条', 'noodle'], ['大米', 'rice'], ['米饭', 'rice'],
    ['陈醋', 'vinegar'], ['醋', 'vinegar'], ['食用油', 'oil'], ['食盐', 'salt'],
    ['白糖', 'sugar'], ['冰糖', 'sugar'], ['干辣椒', 'chili'], ['辣椒', 'chili'],
    ['蛋', 'egg'], ['米', 'rice'], ['糖', 'sugar'], ['盐', 'salt']
  ];

  function resolveFood(name) {
    var raw = String(name == null ? '' : name).trim();
    if (!raw) return null;
    var n = raw.toLowerCase().replace(/[\s（）()【】\[\]]/g, '');
    var i;
    for (i = 0; i < D.FOODS.length; i++) if (D.FOODS[i].name === raw) return D.FOODS[i].id;
    for (i = 0; i < ALIAS.length; i++) if (n.indexOf(ALIAS[i][0]) >= 0) return ALIAS[i][1];
    for (i = 0; i < D.FOODS.length; i++) if (n.indexOf(D.FOODS[i].name) >= 0) return D.FOODS[i].id;
    return null;
  }

  /* ---------- 提示词：把标准食材名给模型，显著提高归一化命中率 ---------- */
  function buildPrompt() {
    return '你是食材识别助手。只识别照片中清晰可见的食材，最多 8 项，不要猜测。\n' +
      '只输出 JSON 数组，格式为 [{"name":"食材名","confidence":0.95}]，不要输出任何解释文字或 markdown。\n' +
      '食材名优先使用以下标准名称：' + D.FOODS.map(function (f) { return f.name; }).join('、') + '。\n' +
      '不要输出菜名、厨具、包装、品牌或文字内容。若什么都识别不出，输出 []。';
  }

  function buildBody(base64, model) {
    return {
      model: model,
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        { role: 'system', content: buildPrompt() },
        { role: 'user', content: [
          { type: 'text', text: '请识别这张照片里的食材，只返回 JSON 数组。' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } }
        ] }
      ]
    };
  }

  /* ---------- 容错解析：模型常带 ```json 或前后废话 ---------- */
  function parseResponse(text) {
    var s = String(text == null ? '' : text).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    var a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a < 0 || b <= a) throw new Error('模型未返回 JSON 数组');
    var arr = JSON.parse(s.slice(a, b + 1));
    if (!Array.isArray(arr)) throw new Error('返回格式不是数组');
    return arr.map(function (x) {
      return {
        name: x && (x.name || x.food || x.食材 || x.label) || '',
        confidence: Math.min(1, Math.max(0, Number(x && x.confidence) || 0.8))
      };
    }).filter(function (x) { return x.name; });
  }

  function mapItems(parsed) {
    var seen = {}, out = [];
    parsed.forEach(function (p) {
      var id = resolveFood(p.name);
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push({ foodId: id, confidence: p.confidence, checked: true });
    });
    return out;
  }

  /* ---------- 图片压缩：canvas 缩到最长边 maxSide，控制费用 ---------- */
  function compress(file, maxSide) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('图片读取失败')); };
      fr.onload = function () {
        var raw = String(fr.result);
        var fallback = raw.indexOf(',') >= 0 ? raw.split(',')[1] : raw;
        var img = new Image();
        img.onload = function () {
          try {
            var scale = Math.min(1, (maxSide || 1024) / Math.max(img.width, img.height));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.width * scale));
            c.height = Math.max(1, Math.round(img.height * scale));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL('image/jpeg', 0.8).split(',')[1]);
          } catch (e) { resolve(fallback); }
        };
        img.onerror = function () { resolve(fallback); };
        img.src = raw;
      };
      try { fr.readAsDataURL(file); } catch (e) { reject(e); }
    });
  }

  function headersOf(cfg) {
    var h = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) h['Authorization'] = 'Bearer ' + cfg.apiKey;
    return h;
  }
  function doRequest(cfg, body) {
    var fn = cfg._fetch || (typeof w.fetch === 'function' ? w.fetch : null);
    if (!fn) return Promise.reject(new Error('当前环境不支持网络请求'));
    var ctrl = typeof w.AbortController === 'function' ? new w.AbortController() : null;
    var timer = null;
    if (ctrl && typeof w.setTimeout === 'function') {
      timer = w.setTimeout(function () { ctrl.abort(); }, cfg.timeoutMs || 20000);
    }
    var init = { method: 'POST', headers: headersOf(cfg), body: JSON.stringify(body) };
    if (ctrl) init.signal = ctrl.signal;
    return fn(cfg.baseUrl, init).then(function (res) {
      if (timer && typeof w.clearTimeout === 'function') w.clearTimeout(timer);
      if (!res || res.ok === false) throw new Error('接口返回 ' + (res && res.status ? res.status : '异常'));
      return Promise.resolve(typeof res.json === 'function' ? res.json() : res).then(function (data) {
        var choices = data && data.choices;
        if (!choices || !choices[0]) throw new Error('返回结构缺少 choices');
        var msg = choices[0].message || {};
        var content = msg.content;
        if (Array.isArray(content)) {
          content = content.map(function (p) { return p && p.text ? p.text : ''; }).join('');
        }
        return String(content || '');
      });
    }, function (err) {
      if (timer && typeof w.clearTimeout === 'function') w.clearTimeout(timer);
      throw new Error(err && err.name === 'AbortError' ? '请求超时' : (err && err.message) || '网络错误');
    });
  }

  function fallback(file, reason) {
    return {
      items: E.simulateRecognition(file && file.name),
      source: 'mock',
      reason: reason || '',
      model: ''
    };
  }

  /* ---------- 主入口：永远 resolve，绝不把异常抛给 UI ---------- */
  function recognize(file, opts) {
    var cfg = merge(DEFAULTS, getConfig(), opts || {});
    if (!cfg.enabled || !cfg.baseUrl || !cfg.model) {
      return Promise.resolve(fallback(file, '未配置真实识别'));
    }
    var compressFn = cfg._compress || compress;
    return Promise.resolve()
      .then(function () { return compressFn(file, cfg.maxSide); })
      .then(function (b64) { return doRequest(cfg, buildBody(b64, cfg.model)); })
      .then(function (text) {
        var items = mapItems(parseResponse(text));
        if (!items.length) throw new Error('未识别出已知食材');
        return { items: items, source: 'ai', reason: '', model: cfg.model };
      })
      .catch(function (err) {
        return fallback(file, (err && err.message) || '识别失败');
      });
  }

  /* ---------- 连通性测试：纯文本、不传图，成本极低 ---------- */
  function testConnection(opts) {
    var cfg = merge(DEFAULTS, getConfig(), opts || {});
    if (!cfg.baseUrl || !cfg.model) {
      return Promise.resolve({ ok: false, message: '请先填写 Base URL 与模型名' });
    }
    var body = {
      model: cfg.model, max_tokens: 16,
      messages: [{ role: 'user', content: '只回复 OK 两个字母' }]
    };
    return doRequest(cfg, body).then(function () {
      return { ok: true, message: '连接成功，模型可用' };
    }, function (err) {
      return { ok: false, message: (err && err.message) || '连接失败' };
    });
  }

  w.XZ_AI = {
    DEFAULTS: DEFAULTS, KEY: KEY,
    getConfig: getConfig, setConfig: setConfig, clearConfig: clearConfig,
    resolveFood: resolveFood, buildPrompt: buildPrompt, buildBody: buildBody,
    parseResponse: parseResponse, mapItems: mapItems, compress: compress,
    recognize: recognize, testConnection: testConnection, fallback: fallback
  };
})(typeof window !== 'undefined' ? window : globalThis);
