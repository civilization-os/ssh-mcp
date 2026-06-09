# ssh-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-007ACC.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/civilization-os/ssh-mcp/pulls)
[![MCP Server](https://img.shields.io/badge/MCP-Server-7C3AED.svg)](https://modelcontextprotocol.io)

> AI-powered remote server management via the Model Context Protocol. Persistent SSH sessions, full SFTP operations, system monitoring, and interactive Shell (PTY) with built-in UI.

🌐 **Other languages:** [中文](README.zh-CN.md)

---

### Overview

**ssh-mcp** is an MCP (Model Context Protocol) server that turns any AI coding agent into a full-featured remote server administration tool. It maintains persistent SSH connections, executes commands, transfers files, and monitors system health — all through natural language conversations. It also features a built-in Web UI for visual terminal and file management.

### Features

| Category | Tools | Description |
|----------|-------|-------------|
| **Session** | `ssh_connect`, `ssh_disconnect`, `ssh_sessions` | Persistent connection pool with 30-min idle auto-cleanup |
| **Execution** | `ssh_exec`, `ssh_script`, `ssh_exec_bg`, `ssh_exec_stop`, `ssh_exec_bg_result` | Run commands with smart timeout. Session mode can auto-convert long-running commands to background. Supports cwd, env, sudo |
| **SFTP** | `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_file_delete`, `ssh_file_rename`, `ssh_file_mkdir`, `ssh_file_chmod`, `ssh_file_stat` | Full file operations with recursive directory delete/chmod, mkdir -p support |
| **Monitoring** | `ssh_sysinfo`, `ssh_processes`, `ssh_disk_usage` | OS info, process list (sorted by CPU/memory), disk usage |
| **Interactive Shell** | `ssh_shell`, `ssh_shell_read`, `ssh_shell_write`, `ssh_shell_resize`, `ssh_shell_close` | Full PTY support with `expect` pattern matching, ANSI stripping, `tailLines` snapshots, and `keepAlive` heartbeats |

### Quick Start

#### Option 1: Use `npx` (Easiest, No Install)

No need to clone the repo. Just use `npx` in your MCP client config. This always uses the latest version.

```json
"mcpServers": {
  "ssh-mcp": {
    "command": "npx",
    "args": ["-y", "github:civilization-os/ssh-mcp"]
  }
}
```

#### Option 2: Local Install

```bash
git clone https://github.com/civilization-os/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

Then point your MCP client to `/absolute/path/to/ssh-mcp/build/index.js`.

### Dashboard UI

Once the MCP server is started by your client (Claude, Cursor, etc.), the built-in UI is automatically available at:

👉 **[http://localhost:12222](http://localhost:12222)**

This UI bundles:
- **💻 Terminal (WebShell)**: Interactive PTY console with live color rendering.
- **📂 Files (SFTP Explorer)**: Visual file navigator for remote directory trees.
- **☸️ Kubernetes**: Pod management, real-time logs, and Arthas diagnostic panel.
- **📊 Monitoring**: Real-time server load statistics and process monitoring.

### Smart Features for Agents

- **`expect` Matching**: `ssh_shell_read` can wait for a specific regex pattern (like a prompt) before returning.
- **ANSI Stripping**: Optional stripping of terminal color codes to save tokens and improve AI readability.
- **Read Cursor**: Prevents `expect` from matching old output from previous commands.
- **Keep-Alive**: Optional heartbeats (`\x00`) to prevent `TMOUT` session disconnects on strict servers.
- **Smart Timeout**: `ssh_exec` commands automatically wrap with `nohup`. If a command exceeds the timeout, it converts to a background task.

### MCP Configuration Examples

#### Claude Desktop / Claude Code

`.mcp.json`:
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

Replace `/path/to/` with your actual build path if installing locally.

```json
{
  "name": "ssh-mcp",
  "type": "command",
  "command": "node",
  "args": ["/path/to/ssh-mcp/build/index.js"]
}
```

### Architecture

```
src/
├── index.ts          # Entry: server init, tool registration, request routing
├── server.ts         # HTTP Server: REST API, WebSockets, and Static UI hosting
├── session.ts        # Session manager (persistent connection pool)
├── types.ts          # TypeScript interfaces & validators
└── handlers/
    ├── exec.ts       # Command execution (exec, script, bg, stop, bg_result)
    ├── sftp.ts       # Full SFTP operations
    ├── shell.ts      # Interactive PTY Shell logic
    ├── system.ts     # System monitoring tools
    └── k8s.ts        # Kubernetes pod management
```

### License

MIT
