/* ============================================================
 * verify-proxy.js —— M5 代理链路离线自检（无需真实厂商/密钥）
 * 运行：node verify-proxy.js
 *
 * 用一个本地「假上游」替代大模型服务，验证：
 *   1) 代理能把请求转发到上游并原样返回；
 *   2) API Key 由代理从环境变量注入，浏览器侧完全不需要带；
 *   3) 前端未填 model 时代理用 AI_MODEL 补全；
 *   4) 多模态 image_url 内容能完整透传；
 *   5) CORS 预检、静态托管、路径防护均正常。
 * ============================================================ */
'use strict';

var http = require('http');
var path = require('path');
var cp = require('child_process');

var UP_PORT = 18899;
var PROXY_PORT = 18788;
var SECRET = 'sk-local-test-only';
var seen = {};
var pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [通过] ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  [失败] ' + name + (extra ? ' — ' + extra : '')); }
}

var upstream = http.createServer(function (req, res) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    var raw = Buffer.concat(chunks).toString('utf8');
    try {
      var body = JSON.parse(raw);
      seen.auth = req.headers['authorization'] || '';
      seen.model = body.model;
      seen.hasImage = raw.indexOf('data:image/jpeg;base64,') >= 0;
      seen.messages = (body.messages || []).length;
    } catch (e) { seen.parseError = e.message; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '[{"name":"番茄","confidence":0.95}]' } }] }));
  });
});

function request(port, method, pathname, body, headers) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    var req = http.request({ hostname: '127.0.0.1', port: port, path: pathname, method: method, headers: h }, function (res) {
      var cs = [];
      res.on('data', function (c) { cs.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(cs).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function waitHealth(tries) {
  return request(PROXY_PORT, 'GET', '/health').then(function (r) {
    if (r.status === 200) return r;
    throw new Error('未就绪');
  }).catch(function () {
    if (tries <= 0) throw new Error('代理启动超时');
    return new Promise(function (res) { setTimeout(res, 120); }).then(function () { return waitHealth(tries - 1); });
  });
}

upstream.listen(UP_PORT, '127.0.0.1', function () {
  var env = Object.assign({}, process.env, {
    PORT: String(PROXY_PORT),
    AI_BASE_URL: 'http://127.0.0.1:' + UP_PORT + '/v1/chat/completions',
    AI_API_KEY: SECRET,
    AI_MODEL: 'test-vision-model'
  });
  var child = cp.spawn(process.execPath, [path.join(__dirname, 'ai-proxy.js')], {
    cwd: __dirname, env: env, stdio: 'ignore'
  });

  console.log('\nM5 代理链路自检（本地假上游，无真实密钥）');
  waitHealth(25).then(function (health) {
    var h = JSON.parse(health.text);
    ok('代理健康检查显示上游已配置', h.ok === true && h.upstreamConfigured === true && h.modelConfigured === true);
    ok('健康检查不泄露密钥', health.text.indexOf(SECRET) < 0);

    // 模拟前端经代理发出的多模态请求：不带 Authorization、不带 model
    var frontBody = {
      messages: [
        { role: 'system', content: '识别食材' },
        { role: 'user', content: [
          { type: 'text', text: '识别' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }
        ] }
      ]
    };
    return request(PROXY_PORT, 'POST', '/v1/chat/completions', frontBody).then(function (r) {
      var data = JSON.parse(r.text);
      ok('转发返回 200 且内容完整', r.status === 200 && data.choices[0].message.content.indexOf('番茄') >= 0);
      ok('密钥由代理注入（前端未携带）', seen.auth === 'Bearer ' + SECRET, seen.auth);
      ok('前端未填 model 时代理自动补全', seen.model === 'test-vision-model', seen.model);
      ok('多模态 image_url 完整透传', seen.hasImage === true && seen.messages === 2);
      ok('响应带 CORS 头', r.headers['access-control-allow-origin'] === '*');
    });
  }).then(function () {
    return request(PROXY_PORT, 'OPTIONS', '/v1/chat/completions', null,
      { Origin: 'http://example.com', 'Access-Control-Request-Method': 'POST' });
  }).then(function (r) {
    ok('CORS 预检返回 204', r.status === 204);
    return request(PROXY_PORT, 'GET', '/index.html');
  }).then(function (r) {
    ok('代理同时可静态托管页面', r.status === 200 && r.text.indexOf('ai-adapter.js') >= 0);
    return request(PROXY_PORT, 'GET', '/%2e%2e/%2e%2e/etc/passwd');
  }).then(function (r) {
    ok('路径穿越被拒绝且未泄漏文件', r.status === 403 || r.status === 404, 'HTTP ' + r.status);
  }).catch(function (err) {
    fail++; console.log('  [失败] 链路异常 — ' + err.message);
  }).then(function () {
    child.kill();
    upstream.close();
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
  });
});
