# ssh-mcp Installation Guide

This guide is written for both humans and AI agents. Follow one install path, then restart or reload your MCP client so it can discover the new server.

## Requirements

- Node.js 18 or newer
- npm
- An MCP-compatible client such as Codex, Claude Code, Claude Desktop, Cursor, Windsurf, Continue, or OpenCode

## Option 1: Codex Global Config

Use this when you want `ssh-mcp` available in every Codex project.

1. Clone and build the project:

```bash
git clone https://github.com/civilization-os/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

2. Add this block to your Codex config file.

Windows:

```toml
# C:\Users\<you>\.codex\config.toml
[mcp_servers."ssh-mcp"]
command = "node"
args = ['C:\absolute\path\to\ssh-mcp\build\index.js']
```

macOS/Linux:

```toml
# ~/.codex/config.toml
[mcp_servers."ssh-mcp"]
command = "node"
args = ["/absolute/path/to/ssh-mcp/build/index.js"]
```

3. Reload Codex or open a new task.

4. Verify that tools such as `ssh_connect`, `ssh_sessions`, `ssh_shell`, and `ssh_file_list` are available.

## Option 2: Project-Level `.mcp.json`

Use this when you want `ssh-mcp` enabled only for one workspace.

1. Clone and build:

```bash
git clone https://github.com/civilization-os/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

2. Create `.mcp.json` in your workspace or copy `.mcp.json.example`:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/ssh-mcp/build/index.js"]
    }
  }
}
```

On Windows, forward slashes are also accepted by Node:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "node",
      "args": ["C:/absolute/path/to/ssh-mcp/build/index.js"]
    }
  }
}
```

3. Reload your MCP client or open a new task.

## Option 3: `npx`

Use this when you do not want a local clone.

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

## Option 4: Run Locally for Development

```bash
git clone https://github.com/civilization-os/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
node build/index.js
```

For normal MCP client usage, do not manually keep `node build/index.js` running. Configure the client and let it start the server on demand.

## Dashboard

After the MCP server starts, the built-in browser console is available at:

```text
http://localhost:12222
```

If another `ssh-mcp` UI is already running, new MCP server processes reuse it. If port `12222` is occupied by a different process, `ssh-mcp` tries the next available port and prints the actual URL in startup logs.

## Verify Installation

Ask your MCP client to list tools. A successful install exposes tools such as:

```text
ssh_connect
ssh_disconnect
ssh_sessions
ssh_file_read
ssh_file_write
ssh_file_list
ssh_shell
ssh_shell_write
ssh_shell_read
ssh_shell_close
ssh_shell_list
ssh_sysinfo
ssh_processes
ssh_disk_usage
```

You can also run the local smoke check from this repo:

```bash
node check.mjs
```

Expected output starts with:

```text
Total tools: 21
```

## Troubleshooting

- If tools do not appear, reload the MCP client or open a new task.
- If `build/index.js` is missing, run `npm run build`.
- If the dashboard does not open on `12222`, check startup logs for the actual port.
- If an old daemon is still running, stop the process that owns port `12222`, then let your MCP client start `ssh-mcp` again.
- Credentials are kept in process memory only. SSH passwords, private keys, and kubeconfig content are not persisted across process restarts.
