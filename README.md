# QClaw

> **AI 智能编程助手 · AI 集合体**  
> 一个具备自我进化能力的 Electron 桌面 AI 助手

[![Version](https://img.shields.io/badge/version-2.0.1-blue.svg)](https://github.com/AKAhanfei/qclaw/releases/tag/v2.0.1)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)]()
[![License](https://img.shields.io/badge/license-Private-red.svg)]()

---

## 简介

QClaw 是一款运行在 Windows 上的 Electron 桌面应用，集成了多个 AI Provider（Ollama 本地模型、OpenAI、Anthropic Claude、Google Gemini），提供智能编程辅助、工具调用、知识库检索等功能。

QClaw 最独特的能力是内置的**自我进化引擎**——应用能够定期审视自身后端代码，借助 AI 发现缺陷，并在安全机制保护下自主更新自己。

---

## 核心功能

### 🤖 多 Provider AI 对话
- 支持 **Ollama**（本地私有部署，默认）、**OpenAI**、**Anthropic Claude**、**Google Gemini**
- 流式输出（Server-Sent Events）
- 工具调用：文件操作、系统命令执行、网页搜索、知识库检索

### 🧬 自我进化引擎（v2.0 核心亮点）
- **自我扫描**：每 4 小时扫描全部后端 JS 文件（7 条规则：大函数 / 空 catch / 内存泄漏等）
- **AI 驱动建议**：调用本地 Ollama 生成代码改进方案，降级时使用规则引擎兜底
- **安全热替换**：备份 → `node --check` 语法验证 → 写入 → 失败自动回滚
- **版本自动递增**：每次进化成功后自动 bump patch 版本，记录进化历史
- **安全边界**：仅修改 `server/` 目录，不触及 Electron 主进程，不修改自身

### 🧠 智能上下文管理（ContextEngine v3.0）
- SlidingSummary：超长对话滑动摘要，旧消息压缩节省 50%+ token
- DedupeFilter：Jaccard trigram 相似度去重
- PriorityPruning：优先保留最近 + 重要消息
- 双层 KV 缓存：Hot（RAM）+ Cold（SSD 持久化）
- 长对话 token 节省目标：**40~70%**

### 💾 染色体记忆系统
- 长期记忆持久化（`~/.qclaw/memory.json`）
- **四维情绪模型**：警觉度 / 情绪效价 / 好奇驱动 / 行动信心
- 痛觉学习：记录错误惩罚，存入 `~/.qclaw/nociception.json`
- 主动探索：基于情绪状态触发主动行为

### 🔌 MCP 协议支持
- 标准 Model Context Protocol 客户端
- 通过子进程 stdio 启动 MCP Server
- JSON-RPC 2.0 协议（`tools/list`、`tools/call`）
- Windows 特殊处理（`shell: true` for `.cmd` scripts）

### 🧩 AstrBot 风格插件系统
- 完整的插件生态框架（参考 AstrBot star_manager.py）
- 12 个事件钩子（onMessage / onLLMRequest / onLLMResponse 等）
- 文件监视热重载（开发友好）
- 插件目录：`server/plugins/<plugin-id>/`

### 🛡️ 工具安全防护（Tool Guard）
4 级防护机制：
| 级别 | 行为 |
|------|------|
| `SAFE` | 直接执行（`ls/dir/git status` 等白名单命令）|
| `WARN` | 提示用户确认（5s 超时自动拒绝）|
| `DANGER` | 需要明确批准 |
| `BLOCK` | 直接拒绝 + 记录日志（`rm -rf /` 等危险模式）|

### ⚡ ContinuousBatch 调度器（oMLX 移植）
- Continuous Batching：新请求随时插入，不等待整个 batch 完成
- 三级优先级队列：`HIGH`（fastMode）> `NORMAL` > `LOW`（后台任务）
- 高优先级请求可抢占低优先级

### 🎛️ 控制中心仪表盘
集成 OpenClaw-bot-review 核心功能：
- 🏠 总览：Stat 卡片 + Token 趋势 + 实时告警
- 🧬 进化中心：实时引擎状态 + 扫描问题 + AI 建议双栏对比 + 进化历史
- 🤖 机器人：Agent 卡片墙（emoji、模型、平台绑定、状态）
- 🧠 模型：Provider 列表 + 模型切换 + 健康检测
- 📊 统计：Token 消耗趋势 + 响应时间趋势
- 🔧 技能：技能列表 + 搜索筛选
- 🔔 告警：规则管理 + 触发历史（CRUD）
- 🕹️ 像素办公室：Agent 像素动画漫步场景

---

## 技术栈

### 前端（Renderer）
| 技术 | 说明 |
|------|------|
| React 18.2 | Hooks + lazy/Suspense + memo |
| Zustand 4.4.7 | 全局状态管理 |
| electron-vite 2.0 + Vite 5.0 | 构建工具 |
| react-markdown + remark-gfm | Markdown 渲染 |
| react-syntax-highlighter | 代码高亮 |

### 后端（Node.js Express Server）
| 技术 | 说明 |
|------|------|
| Express.js | Web 框架，运行于 `localhost:3001` |
| SSE | Server-Sent Events 流式对话 |
| MCP | Model Context Protocol，JSON-RPC 2.0 over stdio |
| CORS | 仅允许本地访问（安全限制）|

### Electron 主进程
| 能力 | 说明 |
|------|------|
| electron 28 | 主框架 |
| electron-builder 24.9 | NSIS 安装包（x64）|
| electron-updater 6.1.7 | 自动更新 |

---

## 架构概览

```
┌─────────────────── Electron 主进程 ───────────────────┐
│  out/main/index.js                                    │
│  ├── spawn → resources/server/index.js (后端服务)      │
│  ├── BrowserWindow (加载 app.asar → React SPA)        │
│  └── 进程生命周期管理 (quit/restart/taskkill)          │
└───────────────────────────────────────────────────────┘
           │ HTTP localhost:3001          │ IPC
           ▼                             ▼
┌─────────────────────┐    ┌───────────────────────────┐
│  Express 后端        │    │  React 前端               │
│  ├── routes/         │◀──▶│  ├── ActivityBar (左导航)  │
│  │   ├── chat.js     │    │  ├── ChatPanel (主对话)    │
│  │   ├── tools.js    │    │  ├── DashboardView        │
│  │   ├── knowledge.js│    │  ├── PluginsView          │
│  │   ├── dashboard.js│    │  ├── MCPView              │
│  │   └── plugins.js  │    │  └── TodoListPanel        │
│  ├── providers/      │    └───────────────────────────┘
│  │   ├── Ollama (默认)│
│  │   ├── OpenAI      │
│  │   ├── Anthropic   │
│  │   └── Gemini      │
│  └── services/ (13个)│
│      ├── 🧬 self-evolution-engine  ← AI 自我进化
│      ├── 🧠 context-engine         ← 上下文压缩
│      ├── 💾 memory-engine          ← 染色体记忆+情绪
│      ├── 🔌 mcp-client             ← MCP 协议扩展
│      ├── 🧩 plugin-engine          ← AstrBot 插件系统
│      ├── ⚡ omlx-scheduler         ← 连续批处理调度
│      ├── 🔧 auto-optimizer         ← 自动修复+Web优化
│      ├── 🗄️ tiered-kv-cache        ← 双层持久化缓存
│      ├── 🔑 prefix-cache           ← 前缀指纹缓存
│      ├── 🎮 engine-pool            ← 多模型 LRU 管理
│      ├── 🛡️ tool-guard             ← 五层安全防护
│      ├── ⏱️ scheduled-skills       ← 定时 AI 任务
│      └── ⌨️ command-processor      ← /命令系统
└─────────────────────┘
```

---

## 目录结构

```
qclaw/
├── QClaw.exe                    # 主程序（169MB）
├── main.js                      # 备用入口（app.asar 不可用时）
├── config.json                  # 运行时版本配置
├── resources/
│   ├── app.asar                 # 前端打包产物（React SPA）
│   └── server/                  # 后端 Node.js 服务
│       ├── index.js             # Express 服务入口（port 3001）
│       ├── providers/           # AI Provider 层（Ollama/OpenAI/Anthropic/Gemini）
│       ├── routes/              # API 路由（chat/tools/knowledge/dashboard/plugins）
│       ├── services/            # 核心服务模块（13个）
│       └── node_modules/        # 后端依赖
└── locales/                     # 国际化文件
```

**持久化数据目录**（`~/.qclaw/`）：
```
~/.qclaw/
├── memory.json          # 长期记忆
├── emotion.json         # 情绪状态
├── nociception.json     # 痛觉学习记录
├── jobs.json            # 定时任务配置
├── optimizer.json       # 自动优化记录
├── alert-rules.json     # 告警规则
├── evolution.json       # 进化历史
├── evolution-plan.json  # 进化计划
├── evolution-backups/   # 代码进化备份
├── kv-cache/            # Cold Tier KV 缓存
└── web-opt-hints.json   # Web 检索优化建议缓存
```

---

## 快速开始

### 运行要求
- Windows 10 / 11（x64）
- [Node.js](https://nodejs.org/) 18+ （后端服务需要）
- [Ollama](https://ollama.ai/)（可选，本地 AI 推理）

### 启动方法

双击 `QClaw.exe` 即可运行。

> 如果使用 Ollama 本地模型，请先启动 Ollama 服务（默认 `http://localhost:11434`）。

### 快捷键
| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+P` | 打开设置 |
| `Ctrl+N` | 打开任务列表 |
| `Ctrl+B` | 折叠/展开侧边栏 |
| `Ctrl+W` | 打开/关闭工作空间抽屉 |
| `Esc` | 关闭侧边栏 / 抽屉 |

### 命令系统
在对话框输入 `/` 开头的命令：

| 命令 | 说明 |
|------|------|
| `/status` | 显示当前服务状态 |
| `/reset` | 重置当前会话 |
| `/new` | 新建会话 |
| `/think [level]` | 设置思考深度（low/medium/high/max）|
| `/verbose` | 切换详细输出模式 |
| `/session` | 显示会话信息 |
| `/export` | 导出对话记录 |
| `/clear` | 清空当前对话 |
| `/help` | 显示帮助 |

---

## 版本历史

### v2.0.1（2026-03-16）—— 性能优化 + 稳定性提升
- 日志 5MB 自动轮转，防止日志文件无限增长
- WorkspacePanel 懒加载，加快首屏启动
- Notifications 组件 memo 优化
- 新增全局 `uncaughtException` / `unhandledRejection` 保护
- `gracefulShutdown` 加入 3s 超时保护
- 修复 `before-quit` 进程递归清理

### v2.0.0（2026-03-16）—— 自我进化引擎
- 新增 **Self-Evolution Engine**（自我进化引擎）
- WorkBuddy 风格任务列表 UI 全面升级
- 所有功能集成到 Electron 主窗口（无独立浏览器页面）

### v1.2.0（2026-03-16）—— 控制中心仪表盘
- 集成 OpenClaw-bot-review 全部核心功能
- 新增 Web 控制中心（http://localhost:3001/dashboard）
- 会话管理、技能管理、告警中心、像素办公室

### v0.1.0（2026-03-16）
- 集成 OpenClaw-bot-review 功能框架
- 新增消息平台适配器（WhatsApp/Telegram/Discord）
- 新增自主代理能力框架

### v0.0.0（初始版本）
- 文件操作、系统命令执行、网页搜索、知识库检索

---

## 版本回退

如需回退到历史版本：

1. 访问 [Releases 页面](https://github.com/AKAhanfei/qclaw/releases)
2. 找到目标版本，下载 `QClaw.exe` 替换当前文件
3. 或从 git 历史中切换：
   ```bash
   git checkout v2.0.1
   ```

---

## 灵感来源

QClaw 在架构设计上参考了多个优秀开源项目的核心理念：

| 模块 | 灵感来源 |
|------|----------|
| 自我进化引擎 | 独创 |
| 染色体记忆系统 | MiniClaw |
| ContinuousBatch 调度器 | Apple Silicon oMLX |
| 分层 KV 缓存 | oMLX Paged KV Cache |
| 插件系统 | AstrBot star_manager.py |
| 工具安全防护 | CoPaw Security Layer |
| 定时技能任务 | CoPaw cron skills |
| MCP 集成 | electron-ai-chatbot / Open WebUI |
| 控制中心仪表盘 | OpenClaw-bot-review |

---

*QClaw 2025 — 让 AI 真正成为你的编程伙伴*
