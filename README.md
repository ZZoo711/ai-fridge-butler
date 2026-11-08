# 鲜知 · 冰箱大脑

> 不绑定任何电商的饮食助手：用你冰箱里现有的食材，少浪费，每天不愁吃什么。

一个**纯前端、零后端、零外部依赖**的饮食管理网页版。数据全部存在你自己浏览器的 `localStorage`，没有账号、没有上传、没有埋点回传。

**当前版本 v1.6.2**（2026-11-08 发布）。在线体验：
`https://xianzhi-fridge.app.workbuddy.host/?sharecode=SKSE4SNXI2`
（这是平台生成的公开演示链接；站点不保存任何用户数据。若不希望公开该参数，删除 `?sharecode=...` 即可，本地运行不受影响。）

---

## 验证状态（请先读这一段）

| 项 | 状态 |
|---|---|
| 功能与文档 | 已完成（PRD、竞品分析、M4 开跑包齐全） |
| 自动化质量保障 | 已完成（242 项主自检 + 33 项真实 Chrome 回归） |
| **M4 冷启动验证（20 人 × 14 天）** | **未执行** |

代码里的打卡埋点、CSV 导出、`m4-report.js` 判定脚本都是**为这 14 天准备的工具链**。目前没有任何真实使用数据，因此**没有 GO / NO-GO 结论**。请勿把「功能已完成」理解为「已验证有人每天用」。

判定口径见 `AI饮食管家_产品需求文档_PRD.md` §11 / §13：7 日留存 ≥25% 且推荐采纳率 ≥20% 才继续投入；样本不足时脚本会输出 `INCOMPLETE`，不会强行下结论。

---

## 功能

- **今晚吃什么**：按临期、库存、忌口、口味、历史评分推荐菜谱；临期食材全覆盖面板
- **我的冰箱**：批次与保质期管理，做饭时优先消耗最早到期批次
- **周菜单**：7 天规划、自动采购清单、营养概览、临期锚定
- **营养**：每道菜的估算热量与三大营养素、每日记录、月度回顾
- **剩菜利用**（C4）：剩菜盒、改造方案排序、凑一锅、熟食 2 天安全护栏
- **统计**：下厨次数、临期救回数、估算节省金额
- **数据备份**（B2）：一键导出 / 导入全量 JSON，结构校验 + 二次确认覆盖，换设备不断档
- **PWA**：离线可用、可添加到主屏、network-first 缓存策略
- **M4 验证套件**：每日轻打卡、匿名编号、连续日期 CSV 导出、自动判定报告
- **M5 真实识别适配层**：代码就绪但**默认关闭**，需自行填写端点与凭据启用

共 9 个视图、31 种食材、30 道菜谱，全部数据内联在 `data.js`，无网络请求。

## 目录结构

```
.
├── fridge-app/                   # 网页版全部源码（15 个文件，纯静态）
│   ├── index.html / styles.css
│   ├── data.js / engine.js / app.js
│   ├── ai-adapter.js / ai-proxy.js
│   ├── sw.js / manifest.json / icon-*.png
│   ├── verify.js / verify-proxy.js / m4-report.js
├── e2e-regression.js             # 真实 Chrome 端到端回归（零依赖，本机跑）
├── make-icons.js                 # PWA 图标生成脚本
├── AI饮食管家_产品需求文档_PRD.md
├── AI饮食管家_M4开跑包.md
├── AI饮食管家_竞品与市场分析报告.md
├── LICENSE
└── README.md
```

分层约定：`data.js` 数据层 → `engine.js` 纯函数层（可单测）→ `app.js` 状态与 DOM 层。使用经典 `<script>` 顺序加载，因此直接以 `file://` 打开也能运行。

## 本地运行

```bash
# 方式一：直接双击 fridge-app/index.html（功能可用；PWA / Service Worker 不生效）
# 方式二：起本地服务（推荐，SW 在 localhost 下生效）
cd fridge-app
python -m http.server 8000
# 浏览器打开 http://localhost:8000
```

## 质量验证

```bash
cd fridge-app
node verify.js                 # 242 项：纯函数 + 结构 + DOM 桩冒烟
node verify-proxy.js           # 10 项：本地 AI 代理链路
node m4-report.js --selftest   # 17 项：CSV 判定口径

cd ..
node e2e-regression.js         # 33 项：真实 Chrome 回归，需本机安装 Chrome
```

`e2e-regression.js` 自动探测 Chrome，也可用 `CHROME_PATH` 或 `--chrome=<路径>` 指定；支持 `--scene=a|b|all`、`--keep`。临时探针与 profile 自动清理。

M4 回收 CSV 后出报告：

```bash
cd fridge-app
node m4-report.js ../m4-csv/*.csv --out ../AI饮食管家_M4冷启动验证报告.md
```

## 隐私与数据

- 所有业务数据只在浏览器 `localStorage`，**没有服务端、没有账号、没有自动上传**。
- 备份导出的是**明文 JSON**（含偏好、做饭与营养记录、剩菜、打卡记录），请自行保管；导入为覆盖式恢复，操作不可撤销。
- M4 的 CSV 必须由用户**手动点击导出**，脚本不会主动发送。
- 真实多模态识别默认关闭；启用后密钥只存在本机 `localStorage` 或本地代理的环境变量里，不写日志、不回显。
- 忌口/过敏护栏在推荐层硬排除，但营养值为估算、熟食 2 天为统一经验值，详见 PRD §17.3。

## 路线图

M5 真实识别（填凭据启用）→ M6 微信小程序 → M7 商业化。其中 **M7 的前置条件是 M4 数据达标**。剩余 backlog 里 C5 云端同步（登录 + 同步层）优先级最高，其余 C6 分享卡、C1 一键下单按既定顺序延后。详见 PRD §14。

## 许可证

[MIT](LICENSE)
