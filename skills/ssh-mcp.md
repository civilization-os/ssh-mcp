---
name: ssh-mcp
description: 🔧 SSH 远程服务器管理 MCP — 工具速查与使用指南
---

# 🔧 ssh-mcp — SSH Remote Server Management

一个 MCP 服务器，提供 SSH 远程连接、命令执行、文件传输、系统监控和日志查看功能。

## 连接模式

**Session 模式（推荐多步操作）**：先用 `ssh_connect` 建立会话，返回 `sessionId`，后续操作复用该 ID。

```
ssh_connect host="192.168.1.1" username="root" password="xxx"
→ sess_xxx

ssh_exec sessionId="sess_xxx" command="whoami"
ssh_file_read sessionId="sess_xxx" path="/etc/hostname"

ssh_disconnect sessionId="sess_xxx"
```

**Stateless 模式（一次性命令）**：每次调用都传完整认证信息。

```
ssh_exec host="192.168.1.1" username="root" password="xxx" command="uptime"
```

默认 30 分钟无操作自动清理空闲会话。

## 认证参数（所有工具共享）

| 参数 | 类型 | 说明 |
|------|------|------|
| `host` | string | 服务器地址（必填） |
| `port` | number | SSH 端口，默认 22 |
| `username` | string | 用户名，默认 root |
| `password` | string | 密码（与 privateKey 二选一） |
| `privateKey` | string | 私钥内容字符串 |
| `passphrase` | string | 私钥密码 |
| `timeout` | number | 超时毫秒数 |

## 工具清单

### 会话管理

| 工具 | 必填参数 | 说明 |
|------|----------|------|
| `ssh_connect` | `host` | 创建持久 SSH 会话，返回 sessionId |
| `ssh_disconnect` | `sessionId` | 关闭指定会话 |
| `ssh_sessions` | 无 | 列出所有活跃会话 |

### 命令执行

| 工具 | 必填参数 | 说明 |
|------|----------|------|
| `ssh_exec` | `command` | 执行命令，支持 `cwd`/`sudo`/`env` |
| `ssh_script` | `script` | 执行多行脚本，支持 `interpreter`(sh/bash/python) |
| `ssh_exec_bg` | `sessionId`, `command` | 后台运行命令（非阻塞），返回 runId |
| `ssh_exec_bg_result` | `sessionId`, `runId` | 查询后台任务状态和输出 |
| `ssh_exec_stop` | `sessionId` (+ `runId`/`pid`) | 停止后台任务，`force=true` 发 SIGKILL |

**Smart Timeout**：`ssh_exec` 默认 10 分钟超时。超时后自动转后台，返回 runId，可用 `ssh_exec_bg_result` 查结果。

### SFTP 文件操作

| 工具 | 必填参数 | 说明 |
|------|----------|------|
| `ssh_file_read` | `path` | 读取远程文件内容 |
| `ssh_file_write` | `path`, `content` | 写入远程文件，`mkdir=true` 自动创建父目录 |
| `ssh_file_list` | `path` | 列出目录内容（权限/大小/时间） |
| `ssh_file_delete` | `path` | 删除文件或目录，`recursive=true` 递归删除 |
| `ssh_file_rename` | `source`, `dest` | 重命名或移动文件 |
| `ssh_file_mkdir` | `path` | 创建目录，`parents=true` 类似 mkdir -p |
| `ssh_file_chmod` | `path`, `mode` | 修改权限，`mode="755"`，支持 recursive |
| `ssh_file_stat` | `path` | 获取文件/目录详细信息 |

### 系统监控

| 工具 | 说明 |
|------|------|
| `ssh_sysinfo` | OS/内核/CPU/内存/磁盘/运行时间/负载 |
| `ssh_processes` | 进程列表，`sort` 按 cpu/memory/pid 排序，`limit` 控制数量 |
| `ssh_disk_usage` | 磁盘使用情况，`path` 指定路径 |

### 日志查看

| 工具 | 必填参数 | 说明 |
|------|----------|------|
| `ssh_log_tail` | `path` | 查看文件尾部，`lines` 指定行数（默认 50，0 为全文） |
| `ssh_log_search` | `path`, `pattern` | grep 搜索，`context` 设置上下文行数 |

## 使用建议

1. **多步操作请用 session 模式**，避免反复创建 TCP 连接
2. **长时间运行的任务**用 `ssh_exec_bg`，避免超时
3. **文件操作优先用 SFTP 工具**（`ssh_file_*`），不要在 exec 里用 cat/echo/重定向
4. **私钥内容要包含完整的头和换行符**（`\n` 转义）
5. **用完记得 `ssh_disconnect`**，避免耗尽服务端 MaxSessions
6. **脚本中有变量引用时注意转义**，或者用 `ssh_script` 传多行内容
7. **环境变量**通过 `env={ "KEY": "value" }` 参数传递
