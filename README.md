# ssh-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-007ACC.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/civilization-os/ssh-mcp/pulls)
[![MCP Server](https://img.shields.io/badge/MCP-Server-7C3AED.svg)](https://modelcontextprotocol.io)

> A stateful server operations runtime for AI agents: long-lived SSH, interactive PTY, shell output streaming, terminal buffer reading, SFTP, Kubernetes tools, and a built-in browser console.

🌐 **Other languages:** [中文](README.zh-CN.md)

---

### Overview

**ssh-mcp** is an MCP (Model Context Protocol) server for human-AI collaborative server operations.

It is not just a remote command executor. It keeps long-lived SSH sessions, exposes interactive Shell (PTY) state, allows agents to read the current terminal buffer and continue input, supports real-time shell output updates through MCP resources, and provides full SFTP file operations.

This makes it suitable for Claude Code, Codex, Cursor, and other AI coding agents that need long-lived, observable, and controllable interactions with remote Linux servers while keeping the human user able to observe, verify, and take over at any time.

It also includes a built-in browser operations console for visual terminal access, SFTP file management, Kubernetes operations, and system monitoring.

For security, `ssh-mcp` keeps SSH passwords, private keys, and local kubeconfig content in process memory only. They are not persisted to disk and are not restored after process restart.

### Features

| Category | Tools | Description |
|----------|-------|-------------|
| **Session** | `ssh_connect`, `k8s_connect`, `ssh_disconnect`, `ssh_sessions` | Persistent SSH or local Kubernetes connection pool |
| **SFTP** | `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_file_delete`, `ssh_file_rename`, `ssh_file_mkdir`, `ssh_file_chmod`, `ssh_file_stat` | Full file operations with recursive directory delete/chmod, mkdir -p support |
| **Monitoring** | `ssh_sysinfo`, `ssh_processes`, `ssh_disk_usage` | OS info, process list sorted by CPU/memory, disk usage |
| **Interactive Shell** | `ssh_shell`, `ssh_shell_read`, `ssh_shell_write`, `ssh_shell_resize`, `ssh_shell_close`, `ssh_shell_list` | Full PTY support with `expect` pattern matching, ANSI stripping, `tailLines` snapshots, `peek` reads, and `keepAlive` heartbeats |
| **Resources** | `mcp://ssh/shell/{shellId}/output`, `mcp://ssh/sessions`, `mcp://ssh/shells` | MCP resources for active session state and real-time shell output updates |
| **Kubernetes** | `ssh_k8s_list_pods`, `ssh_k8s_pod_logs`, `ssh_k8s_pod_exec`, `ssh_k8s_pod_cp`, `ssh_k8s_arthas_attach` | Full pod management and Java diagnostics via Arthas. Supports local or remote execution. |

### Kubernetes Multi-Executor (v2.0)

`ssh-mcp` v2.0 introduces a **Multi-Executor** architecture for Kubernetes tools. This solves the "Permission Denied" issue in strict PaaS environments where SSH users lack root/kubectl access.

1. **Remote Executor (SSH)**: The default mode. Connects via SSH and runs `kubectl` on the remote host.
2. **Local Executor (Direct)**: Use `k8s_connect` with your `kubeconfig` content. The MCP server will run `kubectl` locally on your machine, bypassing SSH entirely. This is ideal for managing clusters where you only have Root access via a proprietary PaaS web shell.

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

Once the MCP server is started by your client (Claude, Cursor, etc.), the built-in browser console is available by default at:

👉 **[http://localhost:12222](http://localhost:12222)**

If another `ssh-mcp` process is already serving the browser console, new agent processes will reuse that existing UI service instead of starting another one.

If port `12222` is occupied by a different process and no existing `ssh-mcp` UI is found, `ssh-mcp` automatically tries the next available port. Check the startup logs for the actual UI address.

This console bundles:

- **💻 Terminal (WebShell)**: Interactive PTY console with live color rendering.
- **📂 Files (SFTP Explorer)**: Visual file navigator for remote directory trees.
- **☸️ Kubernetes**: Pod management, real-time logs, and Arthas diagnostic panel.
- **📊 Monitoring**: Real-time server load statistics and process monitoring.

### Smart Features for Agents

- **Stateful sessions**: Reuse the same SSH connection across multiple tool calls.
- **Interactive PTY**: Continue input in long-running shell programs instead of executing isolated commands.
- **Shell output streaming**: Subscribe to `mcp://ssh/shell/{shellId}/output` for real-time shell updates.
- **`expect` matching**: `ssh_shell_read` can wait for a specific regex pattern, such as a prompt, before returning.
- **ANSI stripping**: Optional stripping of terminal color codes to save tokens and improve AI readability.
- **Read cursor / peek reads**: Inspect current terminal state without accidentally matching stale output.
- **Keep-alive**: Optional heartbeats (`\x00`) to prevent `TMOUT` session disconnects on strict servers.

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
├── session.ts        # Session manager (runtime connection pool)
├── types.ts          # TypeScript interfaces & validators
└── handlers/
    ├── sftp.ts       # Full SFTP operations
    ├── shell.ts      # Interactive PTY Shell logic
    ├── system.ts     # System monitoring tools
    └── k8s.ts        # Kubernetes pod management
```

### License

MIT
