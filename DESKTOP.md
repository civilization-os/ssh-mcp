# SSH-MCP Desktop

SSH-MCP Desktop owns the local SSH service and is the only authority that can enable MCP access.

## User flow

1. Install and open **SSH-MCP Desktop**.
2. Turn on **MCP access** in the left sidebar.
3. Configure your MCP client to run the installed `ssh-mcp-bridge.cmd` file.
4. Keep the Desktop app open while using SSH tools.

The bridge exposes no SSH tools while the switch is off. Closing the Desktop window disables MCP, closes SSH and shell sessions, stops the managed service, terminates registered MCP bridge processes, and removes the runtime authorization file.

Interactive PTY output is rendered twice from the same byte stream: the App receives the original stream for xterm.js, while MCP reads receive terminal-interpreted text with control characters applied. Terminal resize events keep both views on the same rows and columns.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run desktop:dev
```

Create the Windows x64 NSIS installer with:

```powershell
npm run desktop:dist
```

Artifacts are written to `release/`. The assisted installer supports choosing an installation directory, creates Start Menu and desktop shortcuts, stops an existing Desktop process during upgrades, and asks whether application data should also be removed during uninstall.

## Proxy and online updates

Open **Application settings** in the sidebar to choose the system proxy, a direct connection, or a manual HTTP(S)/SOCKS proxy. Manual proxies support username/password authentication. Passwords are encrypted with the operating system's secure storage and are never returned to the renderer. The proxy applies to Desktop web traffic and GitHub update checks/downloads; local MCP traffic and SSH target connections bypass it.

Online updates use the public `civilization-os/ssh-mcp` GitHub Releases feed. A tag such as `v2.5.0` triggers the Windows release workflow when the tag matches `package.json`. The workflow publishes the NSIS installer, block map, and `latest.yml` metadata required by the in-app updater.
