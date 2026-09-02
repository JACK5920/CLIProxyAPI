# 🚀 云端多协议免翻反向代理网关扩展说明 (Cloud Gateway Extension)

本仓库在保留原生 **CLIProxyAPI**（Go 语言完整常驻服务端架构）的基础上，额外扩展了**云端免翻墙、四协议自适应智能反向代理网关**，可一键免费托管至 **Vercel** 或 **Render**。

---

## 📌 架构与设计原则

- **零侵入**：完全不修改原项目的任何 Go 核心代码（`cmd/`、`internal/`、`sdk/` 保持 100% 原生纯净）；
- **双引擎并行**：
  - **本地端**：继续运行 `CLIProxyAPI` 处理反重力、Codex、xAI 等 OAuth 凭证与持久化账号轮询；
  - **云端**：提供永久免翻直连的美国本土边缘出口，彻底解决客户端直连 Google 时的 `400 User location is not supported` 地区风控。

---

## 📊 场景决策与方案结果对照表

小码酱基于全链路实测抓取数据，汇总出以下**全场景选择与功能对照表**，方便在不同场景下直接对号入座：

| 使用场景 / 工具需求 | 推荐网关方案 | 协议与配置端点 | 代理软件依赖 | 方案实测表现与优势 |
| :--- | :--- | :--- | :---: | :--- |
| **日常编程：ZCode / 编程代理** | **本地 CLIProxyAPI**<br>`http://127.0.0.1:8317/v1` | 协议：`Chat Completions`<br>Key：`sk-local-...`<br>模型：`gemini-3.7-flash-high` | **需要**<br>(固定美国 IPLC 专线) | 🟢 **10/10 压测全胜**。自动轮询多 Google 反重力账号，不扣 API 费用，本地秒回 |
| **日常开发：Google 反重力软件**<br>(Antigravity 客户端) | **原生客户端直连**<br>(运行原始启动脚本) | 官方原生端点<br>(底层走本地 10809 端口) | **需要**<br>(固定美国 IPLC 专线) | 🟢 **真美国出口** (154.16.x.x)。彻底告别 Cloudflare 动态乱飘香港导致的 400 地区封锁 |
| **外部设备免翻直连**<br>(手机端、iPad、办公电脑) | **Render 云端网关**<br>`https://<服务名>.onrender.com` | 四协议自适应<br>Key：Google AI Studio Key<br>模型：`gemini-3.7-flash` 等 | ❌ **无需代理**<br>(国内网络直接裸连) | 🟢 **独立纯净出口**。实测裸连耗时仅 887ms；闲置 15 分钟休眠，首请求需唤醒 |
| **高并发免翻调用 / 快速备用**<br>(网页插件、沉浸式翻译) | **Vercel 云端网关**<br>`https://<服务名>.vercel.app` | 四协议自适应<br>Key：Google AI Studio Key<br>模型：`gemini-3.7-flash` 等 | ❌ **无需代理**<br>(国内网络直接裸连) | 🟢 **零冷启动秒开**。全网 CDN 加速，响应极快；高并发下偶受公共 IP 全局限频影响 |

---

## 🌐 三大直连网关连通性与网络实测对比

在本地网络环境完全关闭代理（国内宽带裸连）的情况下，实机 5 次采样测速结果：

| 平台与域名 | 平均直连延迟 | 最快响应 | 稳定性表现 | 推荐指数 |
| :--- | :---: | :---: | :--- | :---: |
| **Vercel** (`*.vercel.app`) | **~1067 ms** | **690 ms** | 🟢 **极稳**，Anycast 全球 CDN，零冷启动秒开 | ⭐⭐⭐⭐⭐ (首选) |
| **Render** (`*.onrender.com`) | **~1657 ms** | **750 ms** | 🟢 **较好**，独立机房出口；免费版带休眠机制 | ⭐⭐⭐⭐☆ (备用) |
| **Koyeb** (`*.koyeb.app`) | **~5200 ms** | **2309 ms** | 🔴 **卡顿**，国内路由跳数多，常有 7~8 秒长等待 | ⭐☆☆☆☆ (不推荐) |

---

## 📁 新增文件清单与职责

| 文件路径 | 运行环境 | 功能职责 |
| :--- | :--- | :--- |
| `vercel.json` | Vercel | Vercel 平台的路由重写配置，捕获所有端点请求指向 Edge 函数 |
| `api/proxy.js` | Vercel Edge | Vercel 边缘函数核心代码，基于 V8 运行时，原生支持流式 SSE 打字输出 |
| `render.yaml` | Render | Render 蓝图（Blueprint）自动部署规范文件，声明部署地区（Oregon）与规格 |
| `Dockerfile.render` | Render Docker | 基于轻量 `node:20-alpine` 的容器镜像配置，与原生 Go Dockerfile 完全隔离 |
| `render-server.mjs` | Render Container | Node.js 原生 HTTP 双工网关服务，支持长连接与流式协议转换 |
| `GATEWAY_EXTENSION_README.md` | 文档 | 本扩展功能与多场景结果对照完整说明文档 |

---

## ⚡ 支持的 4 大 API 协议

云端网关内置**智能协议嗅探与实时转换引擎**，无论客户端使用何种方言，网关均会自动将其转换为 Google 规范并流式返回：

1. **OpenAI Chat Completions**：
   - 请求端点：`/v1/chat/completions`
   - 模型列表：`/v1/models`
   - 适用场景：NextChat、Chatbox、Cherry Studio、ZCode、以及各类标准 OpenAI 兼容客户端
2. **OpenAI Responses**：
   - 请求端点：`/v1/responses`
   - 适用场景：OpenAI 新版 Responses API 客户端
3. **Anthropic Messages**：
   - 请求端点：`/v1/messages`
   - 适用场景：Claude 官方格式客户端、Claude Code CLI 兼容插件
4. **Google Gemini 原生协议**：
   - 请求端点：`/v1beta/models/...`、`/v1internal/...`
   - 适用场景：Google AI Studio 官方 SDK、沉浸式翻译、Bob、Raycast

---

## 🛠️ 客户端接入配置指南

### 方式 A：OpenAI 兼容协议客户端（如 ZCode、NextChat、Cherry Studio）
- **协议类型**：`OpenAI` / `Chat Completions`
- **Base URL**：
  - 首选 (Render)：`https://<你的服务名>.onrender.com/v1`
  - 备用 (Vercel)：`https://<你的服务名>.vercel.app/v1`
- **API Key**：填入 Google AI Studio API Key（格式如 `AQ...` 或 `AIzaSy...`）
- **模型名称**：`gemini-3.7-flash`、`gemini-3.6-flash`、`gemini-3.5-flash`（支持网关内置的 50+ 模型）

### 方式 B：Anthropic 协议客户端
- **协议类型**：`Anthropic Messages`
- **Base URL**：`https://<你的服务名>.onrender.com`（或 Vercel 域名）
- **API Key**：填入 Google AI Studio API Key
- **请求头**：自动识别 `x-api-key` 或 `Authorization: Bearer`

---

## 🔒 网络与风控特性

- **固定机房出口**：Vercel 锁定美国旧金山（`sfo1`），Render 锁定美国俄勒冈（`oregon`），确保请求到达 Google 时 100% 判定为合规地区；
- **指纹清洗**：自动剥离 `x-forwarded-for`、`x-real-ip` 等可能导致地域泄露的 HTTP 追踪标头；
- **国内免翻直连**：三大平台均具备海外 CDN 入口，国内网络无需开启代理软件即可流畅通信。
