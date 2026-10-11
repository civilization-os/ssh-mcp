# SSH-MCP Desktop

[![Latest release](https://img.shields.io/github/v/release/civilization-os/ssh-mcp?display_name=tag&sort=semver)](https://github.com/civilization-os/ssh-mcp/releases/latest)
[![Desktop release](https://github.com/civilization-os/ssh-mcp/actions/workflows/desktop-release.yml/badge.svg)](https://github.com/civilization-os/ssh-mcp/actions/workflows/desktop-release.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.19-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Let AI operate. Keep a human at the helm.

SSH-MCP Desktop is a Windows operations workspace that lets AI agents and humans share the same real SSH terminal. The Desktop app owns the runtime, connections, authorization switch, and lifecycle: an MCP client can use SSH capabilities only while the app is running and **MCP access** is enabled.

**Languages:** English · [简体中文](README.zh-CN.md)

## Why SSH-MCP Desktop?

Most SSH automation tools run isolated commands whose state and progress are invisible to the user. SSH-MCP uses a long-lived PTY instead:

- the AI and the user see the same terminal output;
- either side can continue typing into the same shell;
- interactive flows such as `sudo`, `su`, installers, Docker, Kubernetes, and container shells keep working;
- the app remains the visible authorization and shutdown boundary.

This is designed for supervised AI operations, not unattended command execution.

## Control model

```text
AI client (Codex / Claude / Cursor / Windsurf)
                    │ stdio
                    ▼
           Installed MCP Bridge
                    │ runtime token
                    ▼
       SSH-MCP Desktop ── MCP access switch
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
   Shared SSH PTY       SFTP / Monitoring
          ▲
          └──── Human input in the app
```

- With **MCP access off**, the Bridge publishes no SSH tools or resources.
- Turning it on makes the tools available to connected MCP clients.
- Closing the app disables MCP, closes SSH and PTY sessions, stops the managed core runtime and registered Bridge processes, and removes the runtime authorization file.
- The local control plane binds to loopback and Desktop requests use a per-launch authorization token.

## Highlights

### Shared, terminal-aware PTY

The app renders the original SSH byte stream with xterm.js. MCP reads process that same stream through a headless terminal model, so carriage returns, backspace, tabs, ANSI erase and cursor movement, alternate screens, and wide characters have their real terminal meaning.

`ssh_shell_read` supports:

- `expect` matching against program output instead of the echoed command;
- `content`, `inputEcho`, and `programOutput` views;
- incremental reads, `peek`, `tailLines`, and output limits;
- cursor and terminal-size information;
- optional keep-alive heartbeats.

This prevents completion markers in a Bash prompt or command echo from matching before the program actually prints them.

### Human takeover

There is no separate hidden execution channel. Commands entered by an agent appear in the Desktop terminal, and the user can inspect the output, type additional input, interrupt with `Ctrl+C`, or take over the shell at any time.

### Desktop operations workspace

- SSH profiles and reconnectable sessions
- Interactive terminal with live PTY streaming
- SFTP file browser and editor
- System information, processes, and disk usage
- MCP client configuration generator for JSON and Codex TOML
- English and Simplified Chinese interface

### App-level networking and updates

- System proxy, direct connection, or manual HTTP(S)/SOCKS proxy
- Optional proxy username and password authentication
- Proxy bypass rules; local MCP traffic and SSH target connections bypass the app proxy
- In-app GitHub Release checks, download progress, and update installation
- Optional automatic update checks

## Install and connect

### 1. Install the Desktop app

Download the latest Windows x64 NSIS installer from [GitHub Releases](https://github.com/civilization-os/ssh-mcp/releases/latest). The assisted installer supports a custom installation directory and creates Start Menu and desktop shortcuts.

### 2. Add an SSH connection

Open SSH-MCP Desktop, select **New SSH Connection**, and enter the host, port, username, and either a password or private key.

### 3. Connect your AI client

Select **Connect AI** in the left control rail and copy the generated configuration. The app supplies the exact path for the current installation, including custom install locations.

Claude Desktop, Claude Code, Cursor, Windsurf, and other JSON-based clients use:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "C:\\Users\\YOUR_NAME\\AppData\\Local\\Programs\\SSH-MCP Desktop\\ssh-mcp-bridge.cmd"
    }
  }
}
```

Codex uses `~/.codex/config.toml`:

```toml
[mcp_servers."ssh-mcp"]
command = "C:\\Users\\YOUR_NAME\\AppData\\Local\\Programs\\SSH-MCP Desktop\\ssh-mcp-bridge.cmd"
```

Use the configuration copied from the app instead of manually editing the example path.

### 4. Authorize MCP

Keep SSH-MCP Desktop open and turn on **MCP access**. Restart the AI client after adding its MCP configuration if it does not detect the Bridge immediately.

> The Bridge is not a standalone server and does not start the Desktop runtime. An `npx`-only configuration is no longer the supported architecture.

## MCP capabilities

The current Bridge exposes 23 tools while MCP access is enabled.

| Group | Tools | Purpose |
|---|---|---|
| Sessions | `ssh_connect`, `ssh_disconnect`, `ssh_sessions`, `ssh_web_start` | Create, reconnect, inspect, disconnect, or open the local workspace |
| Shared shell | `ssh_shell`, `ssh_shell_write`, `ssh_shell_read`, `ssh_shell_resize`, `ssh_shell_close`, `ssh_shell_list` | Operate long-lived interactive PTY sessions |
| Files | `ssh_file_read`, `ssh_file_write`, `ssh_file_upload`, `ssh_file_download`, `ssh_file_list`, `ssh_file_delete`, `ssh_file_rename`, `ssh_file_mkdir`, `ssh_file_chmod`, `ssh_file_stat` | Manage remote files and stream binary files in either direction through SFTP |
| Monitoring | `ssh_sysinfo`, `ssh_processes`, `ssh_disk_usage` | Inspect the remote operating system, processes, and storage |

MCP resources provide active session state, active shell state, and rendered shell output:

- `mcp://ssh/sessions`
- `mcp://ssh/shells`
- `mcp://ssh/shell/{shellId}/output`

`ssh_file_upload` accepts an absolute `localPath` on the Desktop computer and a remote `path`. It streams the file to a temporary remote path and renames it only after the transfer succeeds, so binary and large files do not pass through JSON or a full-memory buffer.

`ssh_file_download` streams a remote `path` to an absolute Desktop `localPath`. It verifies the transferred byte count and installs the completed temporary file locally. Existing local files are protected unless `overwrite: true` is explicitly provided; `mkdir: true` creates missing local parent directories.

## Security and local data

- Electron runs with context isolation, renderer sandboxing, and Node integration disabled.
- The Desktop runtime listens on `127.0.0.1` and uses a random per-launch bearer token.
- MCP tool and resource discovery is controlled by the app switch.
- SSH profiles and credentials are stored under the Desktop application-data directory so sessions can be reconnected after a restart. Credential fields are encrypted with AES-256-GCM before being written to disk.
- The manual proxy password is protected with Electron `safeStorage` and is never returned to the renderer.
- The uninstaller can optionally remove saved profiles, encrypted credentials, settings, and logs.

Local encryption does not replace operating-system account security. Protect access to the Windows account and its application-data directory.

## Development

Requirements:

- Windows 10/11 x64 for the packaged Desktop app
- Node.js 20.19 or newer
- npm

```powershell
git clone https://github.com/civilization-os/ssh-mcp.git
cd ssh-mcp
npm install
npm --prefix ui install
npm run typecheck
npm test
npm run desktop:dev
```

Build the production application:

```powershell
npm run build
```

Create a local NSIS installer in `release/`:

```powershell
npm run desktop:dist
```

## Project layout

```text
desktop/
├── main.ts              # Electron lifecycle, MCP gate, proxy, and shutdown
├── updateManager.ts     # GitHub Release update checks and installation
├── bridge/              # Installed MCP Bridge launcher
└── installer/           # NSIS lifecycle hooks
src/
├── index.ts             # MCP stdio Bridge
├── daemon.ts            # Desktop-managed core entry point
├── server.ts            # Local REST/WebSocket control plane
├── desktopRuntime.ts    # Runtime discovery and authorization
├── session.ts           # SSH profiles, connection pool, and reconnect logic
├── terminalView.ts      # Terminal-semantic output model
└── handlers/
    ├── shell.ts         # Interactive PTY operations
    ├── sftp.ts          # Remote file operations
    ├── system.ts        # System monitoring
    └── mcp.ts           # MCP tool/resource routing
ui/src/                  # React Desktop renderer
```

## Releases

A tag such as `v2.5.5` must match the version in `package.json`. The Desktop Release workflow validates the version, runs type checks and tests, builds the Windows NSIS installer, and publishes the installer, block map, and `latest.yml` required by the in-app updater.

## License

[MIT](LICENSE)
