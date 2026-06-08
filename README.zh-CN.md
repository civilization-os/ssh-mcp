# ssh-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-007ACC.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/civilization-os/ssh-mcp/pulls)
[![MCP Server](https://img.shields.io/badge/MCP-Server-7C3AED.svg)](https://modelcontextprotocol.io)

> 基于 MCP 协议的 AI 远程服务器管理工具。持久化 SSH 会话、全功能 SFTP、系统监控、日志查看 — 让 AI 像使用 Xshell + Xsftp 一样管理服务器。

🌐 **English version:** [README.md](README.md)

---

### 概述

**ssh-mcp** 是一个 MCP（Model Context Protocol）服务器，能将任何 AI 编程助手变成全功能的远程服务器管理工具。它维护持久化的 SSH 连接，执行命令，传输文件，监控系统状态，搜索日志 — 全部通过自然语言对话完成。

### 功能一览

| 分类 | 工具 | 功能说明 |
|------|------|----------|
| **会话管理** | `ssh_connect`, `ssh_disconnect`, `ssh_sessions` | 持久化连接池，30 分钟空闲自动清理 |
| **命令执行** | `ssh_exec`, `ssh_script`, `ssh_exec_bg`, `ssh_exec_stop`, `ssh_exec_bg_result` | 运行命令，支持 cwd/env/sudo。会话模式下智能超时可自动转后台 |
| **文件操作** | `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_file_delete`, `ssh_file_rename`, `ssh_file_mkdir`, `ssh_file_chmod`, `ssh_file_stat` | 完整 SFTP 功能：读写、上传、递归删除目录、重命名、创建目录（-p）、改权限、查看详情 |
| **系统监控** | `ssh_sysinfo`, `ssh_processes`, `ssh_disk_usage` | 系统信息、进程列表（按 CPU/内存排序）、磁盘使用 |
| **日志查看** | `ssh_log_tail`, `ssh_log_search` | 查看日志尾部、grep 搜索（支持上下文行数） |

### 快速开始

#### 环境要求

- Node.js >= 18
- npm

#### 安装

```bash
git clone https://github.com/civilization-os/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

#### 使用示例

**会话模式**（推荐 — 复用连接）：

```
ssh_connect    host="192.168.1.1"  username="root"  password="xxx"  kubectlPath="/usr/local/bin/kubectl"  kubeconfig="/root/.kube/config"
→ 会话已创建: sess_xxx

ssh_exec       sessionId="sess_xxx"  command="top -b -n 1 | head -5"
ssh_file_write sessionId="sess_xxx"  path="/tmp/test.txt"  content="你好世界"
ssh_sysinfo    sessionId="sess_xxx"
ssh_disconnect sessionId="sess_xxx"
```

**直连模式**（每次调用传入凭据）：

```
ssh_exec  host="192.168.1.1"  username="root"  password="xxx"  command="whoami"
```

对于 Kubernetes 相关工具，`ssh_connect` 还支持以下可选参数：

- `kubectlPath`：远端主机上的自定义 `kubectl` 可执行文件路径
- `kubeconfig`：远端主机上的自定义 kubeconfig 文件路径

如果不传，服务端会在远端自动探测这两个配置。

#### 智能超时

所有 `ssh_exec` 命令自动通过 `nohup` 包装运行。在会话模式下，如果命令超过超时时间（默认 10 分钟），不会报错退出，而是自动转为后台任务，返回 `runId`：

- 查看输出：`ssh_exec_bg_result sessionId="..." runId="bg_xxx"`
- 停止任务：`ssh_exec_stop sessionId="..." runId="bg_xxx"`

在直连模式下，超时后的远端进程仍可能继续运行，但不会提供可恢复查询的 `runId`。如果需要管理长时间运行任务，建议先 `ssh_connect` 再执行。

### 各客户端 MCP 配置

#### Claude Desktop / Claude Code

`.mcp.json`：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/absolute/path/to/ssh-mcp/build/index.js"]
    }
  }
}
```

CLI 方式：

```bash
claude mcp add ssh -- node /path/to/ssh-mcp/build/index.js
```

#### Cursor

Cursor 设置 → Features → MCP Servers → 添加：

```json
{
  "name": "ssh",
  "type": "command",
  "command": "node",
  "args": ["/path/to/ssh-mcp/build/index.js"]
}
```

#### Windsurf

在 `.windsurf/config.json` 或全局 MCP 配置中：

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

#### Continue (VS Code / JetBrains)

`~/.continue/config.json`：

```json
{
  "experimental": {
    "mcpServers": {
      "ssh": {
        "command": "node",
        "args": ["/path/to/ssh-mcp/build/index.js"]
      }
    }
  }
}
```

#### OpenCode

在 OpenCode 配置中：

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

> **注意：** 所有客户端都遵循相同的 [MCP stdio 协议](https://modelcontextprotocol.io)，唯一区别是配置文件存放位置不同。请将 `/path/to/ssh-mcp/` 替换为你的实际安装目录。

### 前端运维控制台 (Dashboard UI)

为了提供更直观、跨维度的运维协同体验，项目内置了一个现代科技感、毛玻璃风格的图形化控制台。

#### 核心面板功能
1. **💻 交互终端 (WebShell Terminal)**：支持键盘输入及 ANSI 彩色代码渲染的伪终端 (PTY) 协作控制台。
2. **📂 文件管理器 (SFTP Explorer)**：可视化浏览服务器文件系统、双击下钻目录、上级返回。
3. **☸️ Kubernetes 管理器 (K8s Board)**：展示不同 Namespaces 下的 Pod 列表状态，一键查看实时日志流，执行容器内命令和跨主机拷贝文件。集成 **Arthas 智能诊断面板**，支持**全离线模式**（可自带 Arthas 资源和定制化 JDK，完全脱离外网）。搭载 **K8s 智能探测** 引擎，全自动寻找 `kubeconfig` 证书与 `kubectl` 路径，并提供 UI 手动覆写入口。
4. **📊 系统监控中心 (System Monitor)**：监控服务器 CPU/内存/磁盘负载情况，按 CPU/内存占用率展示实时活跃进程。
5. **🔌 会话连接管理器 (Connection Manager)**：侧边栏支持随时点击 `+` 按钮，通过图形界面输入主机 IP、端口、用户名和密码/私钥直连新服务器。

#### 本地启动调试

若要在本地联调并操作 Mock 服务或真实远程会话：

##### 1. 编译并启动联调后端
```bash
npm run build
node run_local_mock.mjs
```
此命令将启动本地 Mock SSH 服务器（监听 `22222`）以及核心 HTTP/WebSocket REST 服务（监听 `12222`），并向连接池中注入示例连接 `Mock-Server-Local`。

##### 2. 运行前端看板
```bash
cd ui
npm run dev
```
启动后在浏览器中访问：`http://localhost:5174/`。

##### 3. 使用界面
在浏览器控制台，您不仅可以查看已注入的 Mock 示例，还可以点击侧边栏 `SSH 会话列表` 旁边的 **`+`** 按钮或使用主界面的新建连接引导，填写表单并直接与您的真实远程服务器建立 SSH 连接。选中会话后，上方将激活四个维度的操作看板，按需随意切换。

### 架构设计

```
src/
├── index.ts          # 入口：Server 初始化，工具注册，请求路由
├── session.ts        # 会话管理器（持久化连接池）
├── types.ts          # TypeScript 接口定义与校验
└── handlers/
    ├── exec.ts       # 命令执行（exec, script, bg, stop, bg_result）
    ├── sftp.ts       # 全功能 SFTP 操作
    └── system.ts     # 系统监控与日志工具
```

双模式设计：
- **会话模式**：先 `ssh_connect` 获取 `sessionId`，后续调用复用
- **直连模式**：每次调用传入 `host`/`username`/`password`

### License

MIT
