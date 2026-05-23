# ssh-mcp

> AI-powered remote server management via the Model Context Protocol. Persistent SSH sessions, full SFTP operations, system monitoring, and log tools — like giving an AI agent Xshell + Xsftp superpowers.

[English](#english) · [中文](#chinese)

---

## English

### Overview

**ssh-mcp** is an MCP (Model Context Protocol) server that turns any AI client (Claude, etc.) into a full-featured remote server administration tool. It maintains persistent SSH connections, executes commands, transfers files, monitors system health, and searches logs — all through natural language conversations.

### Features

| Category | Tools | Description |
|----------|-------|-------------|
| **Session** | `ssh_connect`, `ssh_disconnect`, `ssh_sessions` | Persistent connection pool with 30-min idle auto-cleanup |
| **Execution** | `ssh_exec`, `ssh_script`, `ssh_exec_bg`, `ssh_exec_stop`, `ssh_exec_bg_result` | Run commands with smart timeout (auto-converts to background on timeout). Supports cwd, env, sudo |
| **SFTP** | `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_file_delete`, `ssh_file_rename`, `ssh_file_mkdir`, `ssh_file_chmod`, `ssh_file_stat` | Full file operations with recursive delete/chmod, mkdir -p support |
| **Monitoring** | `ssh_sysinfo`, `ssh_processes`, `ssh_disk_usage` | OS info, process list (sorted by CPU/memory), disk usage |
| **Logs** | `ssh_log_tail`, `ssh_log_search` | View log tails, grep with context |

### Quick Start

#### Prerequisites

- Node.js >= 18
- npm

#### Install

```bash
git clone https://github.com/civilization-os/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

#### Configure MCP

Add to your Claude MCP config (`.mcp.json` or Claude Desktop settings):

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-mcp/build/index.js"]
    }
  }
}
```

#### Usage Examples

**Session mode** (recommended — reuse connection):

```
Connect to server → ssh_connect host="192.168.1.1" username="root" password="xxx"
Run a command     → ssh_exec sessionId="sess_xxx" command="top -b -n 1 | head -5"
Upload a file     → ssh_file_write sessionId="sess_xxx" path="/tmp/test.txt" content="hello"
Check disk        → ssh_disk_usage sessionId="sess_xxx"
Disconnect        → ssh_disconnect sessionId="sess_xxx"
```

**Stateless mode** (credentials per call):

```
ssh_exec host="192.168.1.1" username="root" password="xxx" command="whoami"
```

#### Smart Timeout

All `ssh_exec` commands automatically wrap with `nohup`. If a command exceeds the timeout (default 10 min), it doesn't fail — it converts to a background task and returns a `runId` so you can:

- Check output later: `ssh_exec_bg_result sessionId="..." runId="bg_xxx"`
- Stop it: `ssh_exec_stop sessionId="..." runId="bg_xxx"`

---

## Chinese

### 概述

**ssh-mcp** 是一个基于 MCP 协议的 SSH 远程服务器管理工具，让 AI 客户端（Claude 等）像使用 Xshell + Xsftp 一样管理远程服务器。支持持久化会话、命令执行、文件传输、系统监控和日志查看。

### 功能一览

- **会话管理** — 创建持久化 SSH 连接，30 分钟空闲自动清理
- **命令执行** — 支持单条命令、多行脚本、后台执行。智能超时：超时后自动转为后台任务，不丢输出
- **文件操作** — 读写、上传下载、删除（递归）、重命名、创建目录（-p）、改权限、查看详情
- **系统监控** — 系统信息、进程列表（按 CPU/内存排序）、磁盘使用
- **日志查看** — tail 查看日志尾部、grep 搜索日志内容

### 使用方法

#### 安装

```bash
git clone https://github.com/civilization-os/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

#### MCP 配置

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-mcp/build/index.js"]
    }
  }
}
```

#### 两种模式

**会话模式**（推荐）— 先连接，后续复用：

```
ssh_connect host="8.141.26.176" username="root" password="xxx"
→ 返回 sess_xxx

ssh_exec sessionId="sess_xxx" command="whoami"
ssh_file_list sessionId="sess_xxx" path="/root"
ssh_sysinfo sessionId="sess_xxx"
ssh_disconnect sessionId="sess_xxx"
```

**直连模式** — 每次调用传入认证信息：

```
ssh_exec host="..." username="root" password="..." command="df -h"
```

#### 智能超时

所有命令自动通过 `nohup` 运行。如果命令执行超时（默认 10 分钟），不会报错退出，而是自动转为后台任务，返回 `runId` 供后续查询：

- 查看输出：`ssh_exec_bg_result sessionId="..." runId="bg_xxx"`
- 停止任务：`ssh_exec_stop sessionId="..." runId="bg_xxx"`

### 技术栈

- TypeScript
- [ssh2](https://github.com/mscdex/ssh2) — SSH/SFTP 协议
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — MCP SDK

### License

MIT
