# ssh-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-007ACC.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/civilization-os/ssh-mcp/pulls)
[![MCP Server](https://img.shields.io/badge/MCP-Server-7C3AED.svg)](https://modelcontextprotocol.io)

> 面向 AI Agent 的有状态服务器操作运行时：持久化 SSH、交互式 PTY、Shell 输出流、终端缓冲区读取、SFTP、Kubernetes 工具，以及内置浏览器运维控制台。

🌐 **English version:** [README.md](README.md)

---

### 概述

**ssh-mcp** 是一个面向人机协作的 MCP（Model Context Protocol）服务器。

它并不只是一个远程命令执行器。`ssh-mcp` 会维护长生命周期 SSH 会话，暴露交互式 PTY 状态，允许 Agent 读取当前终端缓冲区并继续输入，同时支持通过 MCP Resource 实时订阅 Shell 输出，并提供完整的 SFTP 文件操作能力。

这使它非常适合 Claude Code、Codex、Cursor 等 AI Coding Agent 对远程 Linux 服务器进行长生命周期、可观察、可控制的交互式操作，并且人类用户可以随时观察、校验和接管整个过程。

项目同时内置了浏览器运维控制台，可用于终端访问、SFTP 文件管理、Kubernetes 操作以及系统监控。

### Features

| 分类 | 工具 | 功能说明 |
|------|------|----------|
| **会话管理** | `ssh_connect`, `k8s_connect`, `ssh_disconnect`, `ssh_sessions` | 持久化 SSH 或本地 Kubernetes 连接池 |
| **文件操作** | `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_file_delete`, `ssh_file_rename`, `ssh_file_mkdir`, `ssh_file_chmod`, `ssh_file_stat` | 完整 SFTP 功能：读写、上传、递归删除、权限管理等 |
| **系统监控** | `ssh_sysinfo`, `ssh_processes`, `ssh_disk_usage` | 系统信息、进程列表（按 CPU/内存排序）、磁盘使用 |
| **交互式 Shell** | `ssh_shell`, `ssh_shell_read`, `ssh_shell_write`, `ssh_shell_resize`, `ssh_shell_close`, `ssh_shell_list` | 完整 PTY 支持，具备 `expect` 匹配、ANSI 剥离、`tailLines` 快照、`peek` 读取及 `keepAlive` 心跳 |
| **Resources** | `mcp://ssh/shell/{shellId}/output`, `mcp://ssh/sessions`, `mcp://ssh/shells` | 用于实时 Shell 输出和会话状态的 MCP Resource |
| **Kubernetes** | `ssh_k8s_list_pods`, `ssh_k8s_pod_logs`, `ssh_k8s_pod_exec`, `ssh_k8s_pod_cp`, `ssh_k8s_arthas_attach` | 完整 Pod 管理及基于 Arthas 的 Java 诊断。支持本地或远程执行。 |

### Kubernetes 多执行引擎 (v2.0)

`ssh-mcp` v2.0 引入了 **Multi-Executor** 架构。这解决了在严苛 PaaS 环境中 SSH 用户缺乏 root/kubectl 权限的问题。

1. **远程执行 (SSH)**：默认模式，通过 SSH 在远程宿主机执行 `kubectl`。
2. **本地执行 (Direct)**：使用 `k8s_connect` 并提供 `kubeconfig` 内容，或直接提供 `server`、CA、客户端证书/私钥、`token` 等 API Server 凭据。MCP Server 会生成临时 kubeconfig 并在本地执行 `kubectl`，完全绕过 SSH。

使用 API Server 证书直连时，`k8s_connect` 示例：

```json
{
  "name": "prod-cluster",
  "server": "https://10.0.0.1:6443",
  "certificateAuthority": "/path/to/ca.crt",
  "clientCertificate": "/path/to/client.crt",
  "clientKey": "/path/to/client.key",
  "namespace": "default"
}
```

使用 Bearer Token 直连时，`k8s_connect` 示例：

```json
{
  "name": "prod-cluster",
  "server": "https://10.0.0.1:6443",
  "token": "YOUR_BEARER_TOKEN",
  "insecureSkipTlsVerify": true
}
```

### 快速开始

完整安装说明请查看 [install.md](install.md)，其中包含 Codex 全局配置、项目级 `.mcp.json`、`npx` 和本地开发安装方式。

#### 选项 1：使用 `npx`（最简单，无需安装）

无需克隆代码，直接在 MCP 客户端配置中使用：

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

然后将 MCP 客户端指向 `/absolute/path/to/ssh-mcp/build/index.js`。

### 运维控制台 (Dashboard UI)

当 MCP Server 被 Claude、Cursor 等客户端启动后，内置浏览器运维控制台默认运行在：

👉 **http://localhost:12222**

如果已经有另一个 `ssh-mcp` 进程在提供浏览器运维控制台，新的 Agent 进程会直接复用这个已有 UI 服务，而不会再额外启动一个新的界面。

如果 `12222` 是被其他程序占用，且当前没有可复用的 `ssh-mcp` UI，`ssh-mcp` 会自动尝试下一个可用端口，请以启动日志输出为准。

控制台包含：

- **💻 WebShell**：支持实时色彩渲染的交互式 PTY 终端。
- **📂 SFTP 文件管理器**：可视化浏览远程目录树。
- **☸️ Kubernetes 管理**：Pod 管理、日志查看、Arthas 诊断。
- **📊 系统监控**：实时服务器负载与进程监控。

### 针对 Agent 的智能特性

- **有状态会话**：跨多次工具调用复用同一 SSH 连接。
- **交互式 PTY**：支持持续输入，而不是一次性执行孤立命令。
- **Shell 输出流**：支持订阅 `mcp://ssh/shell/{shellId}/output` 获取实时终端输出。
- **`expect` 匹配**：等待指定 Prompt 或正则出现后再返回。
- **ANSI 剥离**：减少终端颜色控制符，提高 AI 可读性。
- **Read Cursor / Peek 读取**：`ssh_shell_read` 默认返回自上次 `ssh_shell_write` 以来累计的增量输出；重复读取会保持同一增量窗口，直到下一次写入或显式 `clear: true`。如需完整缓冲区快照，请使用 `peek: true`。
- **KeepAlive 心跳**：防止严格服务器因 `TMOUT` 自动断开。

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
├── index.ts          # 入口：Server 初始化、工具注册、请求路由
├── server.ts         # HTTP 服务：REST API、WebSockets、静态 UI 托管
├── session.ts        # 会话管理器（持久化连接池）
├── types.ts          # TypeScript 接口与参数校验
└── handlers/
    ├── sftp.ts       # 全功能 SFTP 操作
    ├── shell.ts      # 交互式 PTY Shell 逻辑
    ├── system.ts     # 系统监控工具
    └── k8s.ts        # Kubernetes Pod 管理
```

### License

MIT
