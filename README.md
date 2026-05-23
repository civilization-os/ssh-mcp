# ssh-mcp

> AI-powered remote server management via the Model Context Protocol. Persistent SSH sessions, full SFTP operations, system monitoring, and log tools.

🌐 **Other languages:** [中文](README.zh-CN.md)

---

### Overview

**ssh-mcp** is an MCP (Model Context Protocol) server that turns any AI coding agent into a full-featured remote server administration tool. It maintains persistent SSH connections, executes commands, transfers files, monitors system health, and searches logs — all through natural language conversations.

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

#### Usage Examples

**Session mode** (recommended — reuse connection):

```
ssh_connect  host="192.168.1.1"  username="root"  password="xxx"
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

#### Smart Timeout

All `ssh_exec` commands automatically wrap with `nohup`. If a command exceeds the timeout (default 10 min), it converts to a background task and returns a `runId` so you can:

- Check output: `ssh_exec_bg_result sessionId="..." runId="bg_xxx"`
- Stop it: `ssh_exec_stop sessionId="..." runId="bg_xxx"`

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
