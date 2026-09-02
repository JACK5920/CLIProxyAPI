# 🚀 云端多协议免翻反向代理网关扩展说明 (Cloud Gateway Extension)

本仓库在保留原生 **CLIProxyAPI**（Go 语言完整常驻服务端架构）的基础上，额外扩展了**云端免翻墙、四协议自适应智能反向代理网关**，可一键免费托管至 **Vercel** 或 **Render**。

---

## 📌 架构与设计原则

- **零侵入**：完全不修改原项目的任何 Go 核心代码（`cmd/`、`internal/`、`sdk/` 保持 100% 原生纯净）；
- **双引擎并行**：
  - **本地端**：继续运行 `CLIProxyAPI` 处理反重力、Codex、xAI 等 OAuth 凭证与持久化账号轮询；
  - **云端**：提供永久免翻直连的美国本土边缘出口，彻底解决客户端直连 Google 时的 `400 User location is not supported` 地区风控。

---

## 📁 新增文件清单与职责

| 文件路径 | 运行环境 | 功能职责 |
| :--- | :--- | :--- |
| `vercel.json` | Vercel | Vercel 平台的路由重写配置，捕获所有端点请求指向 Edge 函数 |
| `api/proxy.js` | Vercel Edge | Vercel 边缘函数核心代码，基于 V8 运行时，原生支持流式 SSE 打字输出 |
| `render.yaml` | Render | Render 蓝图（Blueprint）自动部署规范文件，声明部署地区（Oregon）与规格 |
| `Dockerfile.render` | Render Docker | 基于轻量 `node:20-alpine` 的容器镜像配置，与原生 Go Dockerfile 完全隔离 |
| `render-server.mjs` | Render Container | Node.js 原生 HTTP 双工网关服务，支持长连接与流式协议转换 |

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
- **国内免翻直连**：两大平台均具备优质海外 CDN 入口，国内网络无需开启代理软件即可流畅通信。
