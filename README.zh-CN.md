# SSH-MCP Desktop

[![最新版本](https://img.shields.io/github/v/release/civilization-os/ssh-mcp?display_name=tag&sort=semver)](https://github.com/civilization-os/ssh-mcp/releases/latest)
[![桌面版发布](https://github.com/civilization-os/ssh-mcp/actions/workflows/desktop-release.yml/badge.svg)](https://github.com/civilization-os/ssh-mcp/actions/workflows/desktop-release.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.19-339933.svg)](https://nodejs.org/)
[![许可证：MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 让 AI 执行，让人始终掌舵。

SSH-MCP Desktop 是一个面向 Windows 的人机协同运维工作台，让 AI Agent 与用户共享同一个真实 SSH 终端。Desktop App 负责运行时、连接、授权开关和完整生命周期：只有 APP 正在运行且 **MCP 访问**已开启时，MCP 客户端才能使用 SSH 能力。

**语言：** [English](README.md) · 简体中文

## 为什么选择 SSH-MCP Desktop？

许多 SSH 自动化工具执行的是彼此隔离的命令，用户既看不到完整状态，也很难中途介入。SSH-MCP 使用长时间运行的 PTY：

- AI 与用户看到同一份终端输出；
- 双方都能继续向同一个 Shell 输入；
- `sudo`、`su`、交互式安装器、Docker、Kubernetes 和容器 Shell 等流程可以保持上下文；
- APP 始终是可见的授权边界与关闭入口。

它面向的是有人监督的 AI 运维，而不是隐藏的无人值守命令执行。

## 控制模型

```text
AI 客户端（Codex / Claude / Cursor / Windsurf）
                    │ stdio
                    ▼
               已安装的 MCP Bridge
                    │ 运行时令牌
                    ▼
       SSH-MCP Desktop ── MCP 访问开关
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
      共享 SSH PTY        SFTP / 系统监控
          ▲
          └──── 用户在 APP 中输入
```

- **MCP 访问关闭**时，Bridge 不发布任何 SSH 工具或资源。
- 打开开关后，连接的 MCP 客户端才能发现这些能力。
- 关闭 APP 会禁用 MCP、关闭 SSH 与 PTY 会话、停止托管的核心运行时和已登记的 Bridge 进程，并删除运行时授权文件。
- 本地控制面只监听回环地址，Desktop 请求使用每次启动随机生成的授权令牌。

## 核心能力

### 共享且理解终端语义的 PTY

APP 使用 xterm.js 渲染原始 SSH 字节流；MCP 读取则将同一份字节流交给无头终端模型处理。因此，回车、退格、制表符、ANSI 擦除与游标移动、备用屏幕和宽字符都会按真实终端语义生效。

`ssh_shell_read` 支持：

- 只对程序输出执行 `expect` 匹配，避免命令回显提前命中；
- `content`、`inputEcho` 和 `programOutput` 三种输出视图；
- 增量读取、`peek`、`tailLines` 和输出长度限制；
- 游标与终端尺寸信息；
- 可选的保活心跳。

即使 Bash 提示符回显了完整命令，完成标记也不会在程序真正输出之前被误判。

### 人工随时接管

系统不存在另一个隐藏的命令执行通道。Agent 输入的命令会出现在 Desktop 终端中，用户可以检查输出、补充输入、按 `Ctrl+C` 中断，或者随时直接接管 Shell。

### Desktop 运维工作台

- SSH 连接档案与可恢复会话
- 实时 PTY 交互终端
- SFTP 文件浏览与编辑
- 系统信息、进程与磁盘使用情况
- 自动生成 MCP JSON 和 Codex TOML 配置
- 英文与简体中文界面

### APP 级网络与更新

- 系统代理、直连或手动 HTTP(S)/SOCKS 代理
- 可选的代理用户名与密码认证
- 代理绕过规则；本地 MCP 流量和目标 SSH 连接不走 APP 代理
- 在 APP 内检查 GitHub Release、显示下载进度并安装更新
- 可选的自动检查更新

## 安装与连接

### 1. 安装 Desktop App

从 [GitHub Releases](https://github.com/civilization-os/ssh-mcp/releases/latest) 下载最新的 Windows x64 NSIS 安装程序。安装向导支持自定义安装目录，并会创建开始菜单和桌面快捷方式。

### 2. 添加 SSH 连接

打开 SSH-MCP Desktop，选择 **新建 SSH 连接**，填写主机、端口、用户名，并提供密码或私钥。

### 3. 连接 AI 客户端

点击左侧控制栏中的 **连接 AI** 并复制自动生成的配置。APP 会填入当前安装位置的准确路径，自定义安装目录也无需手动推测。

Claude Desktop、Claude Code、Cursor、Windsurf 及其他使用 `mcpServers` 的客户端采用 JSON：

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "C:\\Users\\YOUR_NAME\\AppData\\Local\\Programs\\SSH-MCP Desktop\\ssh-mcp-bridge.cmd"
    }
  }
}
```

Codex 使用 `~/.codex/config.toml`：

```toml
[mcp_servers."ssh-mcp"]
command = "C:\\Users\\YOUR_NAME\\AppData\\Local\\Programs\\SSH-MCP Desktop\\ssh-mcp-bridge.cmd"
```

请优先复制 APP 生成的配置，不要手工修改示例路径。

### 4. 授权 MCP

保持 SSH-MCP Desktop 运行并打开 **MCP 访问**。如果添加配置后 AI 客户端没有立即发现 Bridge，请重启该客户端。

> Bridge 不是独立服务器，也不会自行启动 Desktop 运行时。仅使用 `npx` 的配置已经不是当前支持的架构。

## MCP 能力

MCP 访问开启时，当前 Bridge 共发布 23 个工具。

| 分组 | 工具 | 用途 |
|---|---|---|
| 会话 | `ssh_connect`、`ssh_disconnect`、`ssh_sessions`、`ssh_web_start` | 创建、恢复、查看或断开连接，也可打开本地工作台 |
| 共享 Shell | `ssh_shell`、`ssh_shell_write`、`ssh_shell_read`、`ssh_shell_resize`、`ssh_shell_close`、`ssh_shell_list` | 操作长时间运行的交互式 PTY |
| 文件 | `ssh_file_read`、`ssh_file_write`、`ssh_file_upload`、`ssh_file_download`、`ssh_file_list`、`ssh_file_delete`、`ssh_file_rename`、`ssh_file_mkdir`、`ssh_file_chmod`、`ssh_file_stat` | 通过 SFTP 管理远程文件并双向流式传输二进制文件 |
| 监控 | `ssh_sysinfo`、`ssh_processes`、`ssh_disk_usage` | 查看远程系统、进程和存储状态 |

MCP 资源提供当前会话、Shell 状态和渲染后的终端输出：

- `mcp://ssh/sessions`
- `mcp://ssh/shells`
- `mcp://ssh/shell/{shellId}/output`

`ssh_file_upload` 接收 Desktop 电脑上的绝对路径 `localPath` 和远程目标 `path`。文件会先流式写入远程临时路径，传输完成后再重命名，因此二进制文件和大文件无需经过 JSON 或完整内存缓冲。

`ssh_file_download` 把远程 `path` 流式下载到 Desktop 电脑上的绝对路径 `localPath`。传输完成后会核对字节数，再把临时文件落到目标位置。默认保护已有本地文件；只有显式传入 `overwrite: true` 才会替换，`mkdir: true` 可创建缺失的本地父目录。

## 安全与本地数据

- Electron 开启上下文隔离与渲染器沙箱，并关闭 Node 集成。
- Desktop 运行时仅监听 `127.0.0.1`，每次启动都会生成随机 Bearer Token。
- APP 开关控制 MCP 工具与资源是否可发现。
- SSH 连接档案和凭据保存在 Desktop AppData 中，以便重启后恢复连接；凭据字段写入磁盘前使用 AES-256-GCM 加密。
- 手动代理的密码由 Electron `safeStorage` 保护，且不会返回给渲染器。
- 卸载时可以选择同时删除连接档案、加密凭据、设置和日志。

本地加密不能替代操作系统账户安全。请保护 Windows 账户及其应用数据目录的访问权限。

## 本地开发

环境要求：

- 打包版 Desktop App：Windows 10/11 x64
- Node.js 20.19 或更高版本
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

构建生产文件：

```powershell
npm run build
```

在 `release/` 中生成本地 NSIS 安装包：

```powershell
npm run desktop:dist
```

## 项目结构

```text
desktop/
├── main.ts              # Electron 生命周期、MCP 开关、代理与关闭流程
├── updateManager.ts     # GitHub Release 更新检查与安装
├── bridge/              # 安装到本地的 MCP Bridge 启动器
└── installer/           # NSIS 生命周期钩子
src/
├── index.ts             # MCP stdio Bridge
├── daemon.ts            # Desktop 托管核心入口
├── server.ts            # 本地 REST/WebSocket 控制面
├── desktopRuntime.ts    # 运行时发现与授权
├── session.ts           # SSH 档案、连接池与恢复逻辑
├── terminalView.ts      # 终端语义输出模型
└── handlers/
    ├── shell.ts         # 交互式 PTY 操作
    ├── sftp.ts          # 远程文件操作
    ├── system.ts        # 系统监控
    └── mcp.ts           # MCP 工具与资源路由
ui/src/                  # React Desktop 渲染器
```

## 发布

`v2.5.5` 这样的标签必须与 `package.json` 中的版本一致。Desktop Release 工作流会校验版本、执行类型检查和测试、构建 Windows NSIS 安装包，并发布 APP 在线更新所需的安装包、block map 和 `latest.yml`。

## 许可证

[MIT](LICENSE)
