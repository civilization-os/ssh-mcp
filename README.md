# ssh-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-007ACC.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/civilization-os/ssh-mcp/pulls)
[![MCP Server](https://img.shields.io/badge/MCP-Server-7C3AED.svg)](https://modelcontextprotocol.io)

> AI-powered remote server management via the Model Context Protocol. Persistent SSH sessions, full SFTP operations, system monitoring, and log tools.

🌐 **Other languages:** [中文](README.zh-CN.md)

---

### Overview

**ssh-mcp** is an MCP (Model Context Protocol) server that turns any AI coding agent into a full-featured remote server administration tool. It maintains persistent SSH connections, executes commands, transfers files, monitors system health, and searches logs — all through natural language conversations.

### Features

| Category | Tools | Description |
|----------|-------|-------------|
| **Session** | `ssh_connect`, `ssh_disconnect`, `ssh_sessions` | Persistent connection pool with 30-min idle auto-cleanup |
| **Execution** | `ssh_exec`, `ssh_script`, `ssh_exec_bg`, `ssh_exec_stop`, `ssh_exec_bg_result` | Run commands with smart timeout. Session mode can auto-convert long-running commands to background. Supports cwd, env, sudo |
| **SFTP** | `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_file_delete`, `ssh_file_rename`, `ssh_file_mkdir`, `ssh_file_chmod`, `ssh_file_stat` | Full file operations with recursive directory delete/chmod, mkdir -p support |
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

#### Usage Examples

**Session mode** (recommended — reuse connection):

```
ssh_connect  host="192.168.1.1"  username="root"  password="xxx"  kubectlPath="/usr/local/bin/kubectl"  kubeconfig="/root/.kube/config"
→ Session created: sess_xxx

ssh_exec     sessionId="sess_xxx"  command="top -b -n 1 | head -5"
ssh_file_write sessionId="sess_xxx"  path="/tmp/test.txt"  content="hello world"
ssh_sysinfo  sessionId="sess_xxx"
ssh_disconnect sessionId="sess_xxx"
```

**Stateless mode** (credentials per call):

```
ssh_exec  host="192.168.1.1"  username="root"  password="xxx"  command="whoami"
```

For Kubernetes-related tools, `ssh_connect` also accepts these optional fields:

- `kubectlPath`: custom `kubectl` binary path on the remote host
- `kubeconfig`: custom kubeconfig path on the remote host

If omitted, the server will try to auto-detect both on the remote host.

#### Smart Timeout

All `ssh_exec` commands automatically wrap with `nohup`. In session mode, if a command exceeds the timeout (default 10 min), it converts to a background task and returns a `runId` so you can:

- Check output: `ssh_exec_bg_result sessionId="..." runId="bg_xxx"`
- Stop it: `ssh_exec_stop sessionId="..." runId="bg_xxx"`

In direct mode, timed-out commands still keep running remotely, but resumable follow-up via `runId` is not available. Use `ssh_connect` first if you need to manage long-running tasks.

### MCP Configuration by Client

#### Claude Desktop / Claude Code

`.mcp.json`:

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

Or via CLI:

```bash
claude mcp add ssh -- node /path/to/ssh-mcp/build/index.js
```

#### Cursor

In Cursor settings → Features → MCP Servers → Add:

```json
{
  "name": "ssh",
  "type": "command",
  "command": "node",
  "args": ["/path/to/ssh-mcp/build/index.js"]
}
```

#### Windsurf

In `.windsurf/config.json` or global MCP config:

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

`~/.continue/config.json`:

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

In OpenCode config:

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

> **Note:** All clients above follow the same [MCP stdio protocol](https://modelcontextprotocol.io). The only difference is where the config file lives. Replace `/path/to/ssh-mcp/` with your actual install directory.

### Dashboard UI

To provide a more intuitive and visual terminal-cooperation workflow, this project embeds a modern, glassmorphic UI dashboard.

#### Core Panels
1. **💻 Terminal (WebShell)**: An interactive pseudo-terminal (PTY) console supporting keyboard inputs and live ANSI color code rendering.
2. **📂 Files (SFTP Explorer)**: A visual file navigator allowing you to browse the remote directory tree, double-click into folders, and navigate back.
3. **☸️ Kubernetes**: Lists Pods across namespaces, displays real-time logs, executes commands, and copies files. Features a built-in **Arthas container diagnostician panel** that operates in **Offline Mode** (bundling its own assets and JDK without requiring internet access). Includes **Smart K8s Discovery** to automatically find `kubeconfig` and `kubectl` paths, with UI fields for manual overrides.
4. **📊 Monitoring**: Displays real-time server load statistics (CPU, Memory, Disk) and active processes sorted by CPU/Memory utilization.
5. **🔌 Connection Manager**: Allows you to click the `+` button in the sidebar to fill in host, port, username, and authentication credentials (password/private key) to launch new SSH sessions directly from the UI.

#### Local Development & Testing

To test the visual dashboard with a local mock environment:

##### 1. Compile & launch mock backend
```bash
npm run build
node run_local_mock.mjs
```
This launches a mock SSH server (port `22222`), spawns the REST API backend (port `12222`), and seeds an active session named `Mock-Server-Local`.

##### 2. Start the Vite UI Server
```bash
cd ui
npm run dev
```
Open `http://localhost:5174/` in your browser.

##### 3. Using the UI
You can immediately view the pre-seeded mock environment or click the **`+`** button next to `SSH Sessions` (or follow the empty state guide card) to input real server credentials and establish direct connections. Once selected, all four tabs will dynamically reload to target the new session context.

### Architecture

```
src/
├── index.ts          # Entry: server init, tool registration, request routing
├── session.ts        # Session manager (persistent connection pool)
├── types.ts          # TypeScript interfaces & validators
└── handlers/
    ├── exec.ts       # Command execution (exec, script, bg, stop, bg_result)
    ├── sftp.ts       # Full SFTP operations
    └── system.ts     # System monitoring & log tools
```

Dual-mode design:
- **Session mode**: `ssh_connect` first → returns `sessionId` → reuse across calls
- **Stateless mode**: Pass `host`/`username`/`password` with every call

### License

MIT
