/* 鲜知·冰箱大脑 — Service Worker：离线缓存应用壳（network-first） */
/* 策略说明（v4 修复）：
   - 早期版本用 stale-while-revalidate，先返回缓存再后台更新。分享站点对
     不带 sharecode 的直链资源返回 403，导致 install 里的 cache.addAll 整体
     reject，skipWaiting 不执行，新 SW 一直 waiting；老访问者于是出现
     「新 index.html + 旧 app.js」错配 —— 页面看得到新按钮，点了却没反应。
   - 现在改为 network-first：在线时永远取最新脚本，成功后写入缓存；断网才
     回退缓存。这样 HTML 与 JS 不可能来自不同版本，离线能力也完整保留。
   - install 逐个缓存且忽略单项失败，任何 403/离线都不会阻塞 skipWaiting。 */
var CACHE = 'xz-fridge-v5';
var BUILD = '1.6.2';
var ASSETS = [
  './',
  'index.html',
  'styles.css',
  'data.js',
  'engine.js',
  'app.js',
  'ai-adapter.js',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'manifest.json'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (u) {
        return c.add(u).catch(function () { /* 单项失败不影响其余资源与激活 */ });
      }));
    }).then(function () {
      return self.skipWaiting();
    }).catch(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // 不缓存跨域请求（如真实 AI 识别 API），避免污染缓存
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        var copy = res.clone();
        e.waitUntil(caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {}));
        return res;
      }
      // 非 200（例如分享站点对不带分享码的直链返回 403）：改用已缓存副本
      return caches.match(req).then(function (hit) { return hit || res; });
    }).catch(function () {
      // 断网或网络错误：回退缓存；导航请求再回退到缓存首页
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') {
          return caches.match('./').then(function (idx) {
            return idx || caches.match('index.html');
          });
        }
        return new Response('离线不可用', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      });
    })
  );
});
