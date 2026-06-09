# ssh-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-007ACC.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/civilization-os/ssh-mcp/pulls)
[![MCP Server](https://img.shields.io/badge/MCP-Server-7C3AED.svg)](https://modelcontextprotocol.io)

> 基于 MCP 协议的 AI 远程服务器管理工具。支持持久化 SSH 会话、全功能 SFTP、系统监控，以及内置 UI 的交互式 Shell (PTY)。

🌐 **English version:** [README.md](README.md)

---

### 概述

**ssh-mcp** 是一个 MCP（Model Context Protocol）服务器，能将任何 AI 编程助手变成全功能的远程服务器管理工具。它维护持久化的 SSH 连接，执行命令，传输文件，监控系统状态 — 全部通过自然语言对话完成。它还内置了一个 Web 控制台，用于可视化终端和文件管理。

### 功能一览

| 分类 | 工具 | 功能说明 |
|------|------|----------|
| **会话管理** | `ssh_connect`, `ssh_disconnect`, `ssh_sessions` | 持久化连接池，30 分钟空闲自动清理 |
| **命令执行** | `ssh_exec`, `ssh_script`, `ssh_exec_bg`, `ssh_exec_stop`, `ssh_exec_bg_result` | 运行命令，支持 cwd/env/sudo。智能超时可自动转后台 |
| **文件操作** | `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_file_delete`, `ssh_file_rename`, `ssh_file_mkdir`, `ssh_file_chmod`, `ssh_file_stat` | 完整 SFTP 功能：读写、上传、递归删除、权限管理等 |
| **系统监控** | `ssh_sysinfo`, `ssh_processes`, `ssh_disk_usage` | 系统信息、进程列表（按 CPU/内存排序）、磁盘使用 |
| **交互式 Shell** | `ssh_shell`, `ssh_shell_read`, `ssh_shell_write`, `ssh_shell_resize`, `ssh_shell_close` | 完整 PTY 支持，具备 `expect` 模式匹配、ANSI 剥离、`tailLines` 快照及 `keepAlive` 心跳 |

### 快速开始

#### 选项 1：使用 `npx`（最简单，无需安装）

无需克隆代码。直接在 MCP 客户端配置中使用 `npx`，这将始终确保使用最新版本。

```json
"mcpServers": {
  "ssh-mcp": {
    "command": "npx",
    "args": ["-y", "github:civilization-os/ssh-mcp"]
  }
}
```

#### 选项 2：本地安装

```bash
git clone https://github.com/civilization-os/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

然后将您的 MCP 客户端指向 `/绝对路径/to/ssh-mcp/build/index.js`。

### 运维控制台 (Dashboard UI)

当 MCP 服务器被您的客户端（Claude, Cursor 等）启动后，内置 UI 将自动可用：

👉 **[http://localhost:12222](http://localhost:12222)**

该 UI 整合了：
- **💻 交互终端 (WebShell)**：支持实时色彩渲染的交互式 PTY 控制台。
- **📂 文件管理器 (SFTP Explorer)**：可视化浏览远程目录树。
- **☸️ Kubernetes 管理**：Pod 管理、实时日志及 Arthas 诊断面板。
- **📊 系统监控**：实时服务器负载统计和进程监控。

### 针对 Agent 的智能特性

- **`expect` 匹配**：`ssh_shell_read` 可以等待特定的正则模式（如提示符）出现后再返回。
- **ANSI 剥离**：可选剥离终端颜色代码，节省 Token 并提高 AI 可读性。
- **读取游标 (Read Cursor)**：防止 `expect` 匹配到之前命令的历史输出。
- **心跳维持 (Keep-Alive)**：可选发送心跳包 (`\x00`)，防止严苛服务器上的 `TMOUT` 断开。
- **智能超时**：`ssh_exec` 命令自动转后台运行并返回 `runId`。

### MCP 配置示例

#### Claude Desktop / Claude Code

`.mcp.json`：
```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": ["-y", "github:civilization-os/ssh-mcp"]
    }
  }
}
```

#### Cursor / Windsurf / Continue / OpenCode

如果选择本地安装，请将 `/path/to/` 替换为您的实际构建路径。

```json
{
  "name": "ssh-mcp",
  "type": "command",
  "command": "node",
  "args": ["/path/to/ssh-mcp/build/index.js"]
}
```

### 架构设计

```
src/
├── index.ts          # 入口：Server 初始化，工具注册，请求路由
├── server.ts         # HTTP 服务：REST API, WebSockets, 静态 UI 托管
├── session.ts        # 会话管理器（持久化连接池）
├── types.ts          # TypeScript 接口与校验
└── handlers/
    ├── exec.ts       # 命令执行 (exec, script, bg, stop, bg_result)
    ├── sftp.ts       # 全功能 SFTP 操作
    ├── shell.ts      # 交互式 PTY Shell 逻辑
    ├── system.ts     # 系统监控工具
    └── k8s.ts        # Kubernetes Pod 管理
```

### License

MIT
