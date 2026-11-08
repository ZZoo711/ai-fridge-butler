/* ============================================================
 * ai-proxy.js —— M5 零依赖本地转发代理（Node 自带模块，无需 npm install）
 *
 * 解决的三个真实问题：
 *  1) 浏览器直连第三方大模型会被 CORS 拦截 —— 同源代理绕过；
 *  2) API Key 不该出现在前端 —— 只放在环境变量，由代理注入；
 *  3) 一条命令同时起「页面 + 接口」，不用开两个服务器。
 *
 * 启动（Windows Git Bash / macOS / Linux 均可）：
 *   AI_BASE_URL="https://厂商域名/v1/chat/completions" \
 *   AI_API_KEY="sk-xxxx" \
 *   AI_MODEL="模型名" \
 *   node ai-proxy.js
 * 然后打开 http://127.0.0.1:8787/index.html
 * 在「设置 → 真实 AI 识别」里：
 *   Base URL 填 http://127.0.0.1:8787/v1/chat/completions
 *   API Key 留空（由代理注入）
 *   模型名与 AI_MODEL 保持一致
 *
 * 也可以不用代理：设置页直接填厂商端点与 Key（需该端点支持 CORS）。
 * ============================================================ */
'use strict';

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');

var ROOT = __dirname;
var PORT = parseInt(process.env.PORT || '8787', 10);
var UPSTREAM = process.env.AI_BASE_URL || '';
var API_KEY = process.env.AI_API_KEY || '';
var DEFAULT_MODEL = process.env.AI_MODEL || '';
var MAX_BODY = 12 * 1024 * 1024; // 压缩后的图片 base64 通常远小于此

var MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/* ---------- 静态文件 ---------- */
function serveStatic(req, res, pathname) {
  var rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  var full = path.resolve(ROOT, '.' + rel);
  var inside = path.relative(ROOT, full);
  // 严格判断：不允许 ../ 逃逸、绝对路径或跨盘符，避免同级目录前缀绕过
  if (inside === '..' || inside.indexOf('..' + path.sep) === 0 || path.isAbsolute(inside)) {
    json(res, 403, { error: '禁止访问' }); return;
  }
  fs.stat(full, function (err, stat) {
    if (err || !stat.isFile()) { json(res, 404, { error: '文件不存在' }); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(full).pipe(res);
  });
}

/* ---------- 转发到大模型 ---------- */
function forward(req, res, raw) {
  if (!UPSTREAM) {
    json(res, 500, { error: '未设置 AI_BASE_URL：请用环境变量传入厂商 chat/completions 完整地址' });
    return;
  }
  var target;
  try { target = new URL(UPSTREAM); } catch (e) {
    json(res, 500, { error: 'AI_BASE_URL 不是合法 URL' }); return;
  }
  var payload;
  try {
    var obj = JSON.parse(raw.toString('utf8'));
    if (!obj.model && DEFAULT_MODEL) obj.model = DEFAULT_MODEL; // 允许前端不填模型
    payload = Buffer.from(JSON.stringify(obj));
  } catch (e) { json(res, 400, { error: '请求体不是合法 JSON' }); return; }

  var headers = {
    'Content-Type': 'application/json',
    'Content-Length': payload.length
  };
  if (API_KEY) headers['Authorization'] = 'Bearer ' + API_KEY;

  var mod = target.protocol === 'https:' ? https : http;
  var upstream = mod.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + (target.search || ''),
    method: 'POST',
    headers: headers,
    timeout: 30000
  }, function (up) {
    var chunks = [];
    up.on('data', function (c) { chunks.push(c); });
    up.on('end', function () {
      var buf = Buffer.concat(chunks);
      cors(res);
      res.writeHead(up.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(buf);
    });
  });
  upstream.on('timeout', function () { upstream.destroy(new Error('上游超时')); });
  upstream.on('error', function (err) {
    json(res, 502, { error: '上游请求失败：' + err.message });
  });
  upstream.write(payload);
  upstream.end();
}

var server = http.createServer(function (req, res) {
  var pathname = url.parse(req.url).pathname;
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/api/recognize')) {
    readBody(req).then(function (raw) { forward(req, res, raw); },
      function (err) { json(res, 400, { error: err.message }); });
    return;
  }
  if (req.method === 'GET' && pathname === '/health') {
    json(res, 200, { ok: true, upstreamConfigured: !!UPSTREAM, modelConfigured: !!DEFAULT_MODEL });
    return;
  }
  if (req.method === 'GET') { serveStatic(req, res, pathname); return; }
  json(res, 405, { error: '不支持的请求方法' });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('鲜知 M5 本地服务已启动： http://127.0.0.1:' + PORT + '/index.html');
  console.log('代理接口： POST http://127.0.0.1:' + PORT + '/v1/chat/completions');
  console.log('健康检查： GET  http://127.0.0.1:' + PORT + '/health');
  console.log('上游配置： ' + (UPSTREAM ? '已配置' : '未配置（页面仍可用，识别会回退演示模式）'));
  console.log('密钥来源： 环境变量（不会打印、不会下发到浏览器）');
});
