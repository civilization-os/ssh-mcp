#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket } from "ws";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getDesktopAuthorizationHeaders,
  getDesktopDaemonUrl,
  readDesktopRuntimeState,
  registerDesktopBridge,
  requireEnabledDesktopRuntime,
} from "./desktopRuntime.js";

const server = new Server(
  { name: "ssh-mcp-desktop", version: "2.5.5" },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
    },
  }
);

function runtimeRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
  const runtime = requireEnabledDesktopRuntime();
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(getDesktopAuthorizationHeaders(runtime))) {
    headers.set(name, value);
  }
  return fetch(`${getDesktopDaemonUrl(runtime)}${pathname}`, { ...init, headers });
}

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  if (!readDesktopRuntimeState()?.mcpEnabled) {
    return { resourceTemplates: [] };
  }
  return {
    resourceTemplates: [
      {
        uriTemplate: "mcp://ssh/shell/{shellId}/output",
        name: "Interactive Shell Output Stream",
        description: "Terminal-rendered screen, incremental visible text, cursor, and status from a PTY shell session",
        mimeType: "application/json",
      }
    ],
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  if (!readDesktopRuntimeState()?.mcpEnabled) {
    return { resources: [] };
  }
  try {
    const res = await runtimeRequest("/api/mcp/resources");
    if (!res.ok) throw new Error("Daemon error");
    return await res.json() as any;
  } catch (err: any) {
    throw new McpError(ErrorCode.InternalError, `Failed to list resources: ${err.message}`);
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const res = await runtimeRequest(`/api/mcp/resource?uri=${encodeURIComponent(request.params.uri)}`);
    if (!res.ok) throw new Error("Daemon error");
    return await res.json() as any;
  } catch (err: any) {
    throw new McpError(ErrorCode.InternalError, `Failed to read resource: ${err.message}`);
  }
});

const activeSubscriptions = new Set<string>();

server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  activeSubscriptions.add(request.params.uri);
  return {};
});

server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  activeSubscriptions.delete(request.params.uri);
  return {};
});

let daemonEventsSocket: WebSocket | null = null;

function connectDaemonEvents() {
  const runtime = readDesktopRuntimeState();
  if (!runtime?.mcpEnabled || daemonEventsSocket) return;

  const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws/mcp-events`, {
    headers: getDesktopAuthorizationHeaders(runtime),
  });
  daemonEventsSocket = ws;
  
  ws.on("open", () => {
    // connected
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "resourceUpdated" && activeSubscriptions.has(msg.uri)) {
        server.notification({
          method: "notifications/resources/updated",
          params: { uri: msg.uri },
        });
      }
    } catch (e) {}
  });

  ws.on("close", () => {
    daemonEventsSocket = null;
  });
  
  ws.on("error", () => {
    // The runtime watcher reconnects when the Desktop app is available.
  });
}

const authFields = {
  host: { type: "string" as const, description: "Remote server hostname or IP address" },
  port: { type: "number" as const, description: "SSH port (default: 22)", default: 22 },
  username: { type: "string" as const, description: "SSH username (default: root)", default: "root" },
  password: { type: "string" as const, description: "SSH password (use either password or privateKey)" },
  privateKey: { type: "string" as const, description: "SSH private key content as string" },
  passphrase: { type: "string" as const, description: "Passphrase for the private key" },
  timeout: { type: "number" as const, description: "Operation timeout in milliseconds (default: 30000)", default: 30000 },
};

const TOOL_CATALOG = [
    {
      name: "ssh_connect",
      description: "Create a persistent SSH session or reconnect to an existing one. To reconnect seamlessly, simply pass ONLY the 'sessionId' (credentials will be automatically restored from the saved session). Returns a sessionId that can be reused by other tools.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Optional label for the session" },
          sessionId: { type: "string", description: "Optional session ID to reconnect an existing session directly. If provided, host and credentials are not needed." },
          ...authFields,
        },
      },
    },
    {
      name: "ssh_disconnect",
      description: "Close an active SSH session by sessionId.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID to disconnect" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ssh_sessions",
      description: "List all active SSH sessions.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ssh_web_start",
      description: "Open the built-in Web Dashboard UI in the user's default browser.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ssh_file_read",
      description: "Read the contents of a file on a remote server via SFTP. Supports UTF-8 text and base64 for binary files, as well as range reading (offset, length, tail) for large files.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the remote file" },
          encoding: { type: "string", enum: ["utf-8", "base64"], description: "Encoding to return (default: utf-8). Use base64 for binary files or images.", default: "utf-8" },
          offset: { type: "number", description: "Starting byte offset to read from" },
          length: { type: "number", description: "Maximum number of bytes to read" },
          tail: { type: "number", description: "Read the last N bytes of the file (ideal for log files)" },
          timeout: { type: "number", description: "Operation timeout in milliseconds (default: 30000)" },
        },
        required: ["path"],
      },
    },
    {
      name: "ssh_file_write",
      description: "Write content to a file on a remote server via SFTP. Supports writing UTF-8 text, base64 binary content, and appending to existing files.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the remote file" },
          content: { type: "string", description: "Content to write (text string, or base64 encoded string if encoding=base64)" },
          encoding: { type: "string", enum: ["utf-8", "base64"], description: "Encoding of the content (default: utf-8). Use base64 to write binary files.", default: "utf-8" },
          append: { type: "boolean", description: "If true, append to the file instead of overwriting", default: false },
          mkdir: { type: "boolean", description: "Create parent directories if they don't exist", default: false },
          timeout: { type: "number", description: "Operation timeout in milliseconds (default: 30000)" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "ssh_file_upload",
      description: "Stream a local file from the computer running SSH-MCP Desktop to a remote server via SFTP. The destination 'path' can be a full remote file path or an existing directory path (ending with / or existing directory, where source filename is automatically preserved). Supports binary and large files without loading the complete file into memory.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          localPath: { type: "string", description: "Absolute path to the source file on the SSH-MCP Desktop computer" },
          path: { type: "string", description: "Absolute destination path or destination directory on the remote server" },
          mkdir: { type: "boolean", description: "Create remote parent directories if they do not exist", default: false },
          overwrite: { type: "boolean", description: "Replace an existing remote file (default: false)", default: false },
          timeout: { type: "number", description: "Upload timeout in milliseconds (default: 300000)", default: 300000 },
        },
        required: ["localPath", "path"],
      },
    },
    {
      name: "ssh_file_download",
      description: "Stream a remote file via SFTP to an absolute local path on the computer running SSH-MCP Desktop. 'localPath' can be a full destination file path or an existing local directory (ending with / or existing directory, where remote filename is automatically preserved). The transfer uses a temporary local file and refuses to overwrite an existing file unless overwrite=true.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the source file on the remote server" },
          localPath: { type: "string", description: "Absolute destination path or destination directory on the SSH-MCP Desktop computer" },
          mkdir: { type: "boolean", description: "Create local parent directories if they do not exist", default: false },
          overwrite: { type: "boolean", description: "Replace an existing local file (default: false)", default: false },
          timeout: { type: "number", description: "Download timeout in milliseconds (default: 300000)", default: 300000 },
        },
        required: ["path", "localPath"],
      },
    },
    {
      name: "ssh_file_list",
      description: "List files and directories in a remote path via SFTP with permissions, size, and timestamps.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the remote directory" },
        },
        required: ["path"],
      },
    },
    {
      name: "ssh_file_delete",
      description: "Delete a file on a remote server via SFTP, or delete a directory recursively when recursive=true.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the file or directory" },
          recursive: { type: "boolean", description: "Recursively delete directories", default: false },
        },
        required: ["path"],
      },
    },
    {
      name: "ssh_file_rename",
      description: "Rename or move a file on a remote server via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          source: { type: "string", description: "Source path" },
          dest: { type: "string", description: "Destination path" },
        },
        required: ["source", "dest"],
      },
    },
    {
      name: "ssh_file_mkdir",
      description: "Create a directory on a remote server via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path of the directory to create" },
          parents: { type: "boolean", description: "Create parent directories as needed (like mkdir -p)", default: false },
        },
        required: ["path"],
      },
    },
    {
      name: "ssh_file_chmod",
      description: "Change file/directory permissions on a remote server via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the file or directory" },
          mode: { type: "string", description: "Permission mode in octal (e.g. 755, 644)" },
          recursive: { type: "boolean", description: "Apply recursively to directories", default: false },
        },
        required: ["path", "mode"],
      },
    },
    {
      name: "ssh_file_stat",
      description: "Get detailed information about a file or directory on a remote server via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the file or directory" },
        },
        required: ["path"],
      },
    },
    {
      name: "ssh_sysinfo",
      description: "Display system information: OS, kernel, CPU, memory, disk, uptime, load average.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
        },
      },
    },
    {
      name: "ssh_processes",
      description: "List running processes on the remote server, sorted by CPU or memory usage.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          sort: { type: "string", description: "Sort by: cpu, memory, or pid", default: "cpu", enum: ["cpu", "memory", "pid"] },
          limit: { type: "number", description: "Number of processes to show", default: 20 },
        },
      },
    },
    {
      name: "ssh_disk_usage",
      description: "Show disk usage (df -h) on the remote server.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Path to check disk usage for (default: /)" },
        },
      },
    },
    {
      name: "ssh_proc_info",
      description: "Inspect detailed process runtime information on remote server by PID (reads cmdline, exe, cwd, and systemd cgroup service unit). HIGHLY RECOMMENDED before killing processes to prevent terminating critical system services or web servers.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          pid: { type: "number", description: "Target process PID to inspect" },
          timeout: { type: "number", description: "Timeout in ms (default: 15000)" },
        },
        required: ["pid"],
      },
    },
    {
      name: "ssh_shell",
      description: "Create an interactive PTY shell session on a remote server. Returns a shellId. TIP: You can omit shellId in subsequent write/read calls to automatically use the most recent active shell.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          cols: { type: "number", description: "Terminal columns (default: 120)" },
          rows: { type: "number", description: "Terminal rows (default: 30)" },
          term: { type: "string", description: "Terminal type (default: xterm)" },
          keepAlive: { type: "boolean", description: "If true, send periodic heartbeats to prevent shell timeout (TMOUT)" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ssh_shell_write",
      description: "Write input to an interactive shell.\n\n【常用速查】：\n  {input: \"ls -la\"}                 → 写入命令并自动执行\n  {input: \"npm i\", expect: \"DONE\"}  → 发送命令并等待完成，一步到位（单次往返替代 write + read）\n  {input: \"cat /log\", waitMs: 500}   → 写入后等待静默 500ms 直接返回输出\n  {inputBase64: \"...\", waitMs: 500} → 免转义脚本输入（无惧awk/引号/$）\n\n特性：\n1. 省略 shellId 时自动使用最近活跃 shell；\n2. 复合模式：传入 expect 或 waitMs 时，写完后自动等待命令结束并直接返回执行输出，无需再调用 read；\n3. inputBase64：输入 Base64 字符串，工具端精确解码，彻底避免 JSON/Bash 多层引号与反斜杠转义破坏；\n4. raw: true 禁用末尾自动追加换行（用于交互按键如 Ctrl+C、密码输入等）。",
      inputSchema: {
        type: "object",
        properties: {
          shellId: { type: "string", description: "Shell ID from ssh_shell (optional: defaults to the most recent active shell)" },
          input: { type: "string", description: "Text/command to write to shell stdin (auto appends newline if missing unless raw=true)" },
          expect: { type: "string", description: "Wait until this regex pattern appears in output after writing, then return output directly (composite write+read mode)" },
          waitMs: { type: "number", description: "Wait for N ms of silence after writing and directly return output" },
          maxWaitMs: { type: "number", description: "Maximum time in ms to wait when expect/waitMs is used (default: 30000 with expect)" },
          tailLines: { type: "number", description: "Only return the last N lines of output when waiting" },
          inputBase64: { type: "string", description: "Base64 encoded input. Recommended for complex scripts, awk, quotes, and multiline commands to bypass escape issues completely." },
          raw: { type: "boolean", description: "If true, bypass auto-newline appending (default: false)" },
          includeScreen: { type: "boolean", description: "Include full terminal screen snapshot in the returned output (default: false)" },
          includeEcho: { type: "boolean", description: "Include echoed input command lines in output (default: false)" },
        },
      },
    },
    {
      name: "ssh_shell_read",
      description: "Read output from an interactive shell as a rendered terminal.\n\n【常用速查】：\n  {shellId}                     → 读增量（默认精简）\n  {shellId, expect:\"DONE\"}      → 等命令结束，替代 sleep 轮询\n  {shellId, tailLines:20}       → 限行省 token\n  {shellId, peek:true}          → 看整屏（含 screen/cursor）\n\n特性：\n1. 省略 shellId 时自动使用最近活跃 shell；\n2. 默认返回精简结构（output/content 均为净输出，已剥离长命令自身回显），默认不返回几十行 screen 与重复的 inputEcho，体积减少 70%+ 防止中段截断；\n3. 如需查看整屏全量视图，请传 includeScreen: true 或 peek: true。",
      inputSchema: {
        type: "object",
        properties: {
          shellId: { type: "string", description: "Shell ID from ssh_shell (optional: defaults to the most recent active shell)" },
          maxLength: { type: "number", description: "Max bytes to return (default: 50000)" },
          clear: { type: "boolean", description: "Clear the buffer and reset the incremental baseline after reading (default: false)" },
          waitMs: { type: "number", description: "Wait for N ms of silence before returning (e.g. 500 = wait until output stops)" },
          maxWaitMs: { type: "number", description: "Maximum total time to wait in ms (defaults to 30000 when expect is used)" },
          peek: { type: "boolean", description: "Return full rendered buffer snapshot without advancing read cursor" },
          expect: { type: "string", description: "Wait until this regex appears in program output before returning" },
          tailLines: { type: "number", description: "Only return the last N lines of the incremental output" },
          includeScreen: { type: "boolean", description: "Include full terminal screen snapshot (default: false to save tokens)" },
          includeEcho: { type: "boolean", description: "Include echoed input command lines (default: false)" },
          stripAnsi: { type: "boolean", description: "Deprecated; control sequences are always interpreted by virtual terminal" },
        },
      },
    },
    {
      name: "ssh_shell_resize",
      description: "Resize the interactive terminal (change PTY cols/rows).",
      inputSchema: {
        type: "object",
        properties: {
          shellId: { type: "string", description: "Shell ID from ssh_shell (optional: defaults to recent active shell)" },
          cols: { type: "number", description: "Terminal columns (default: 120)" },
          rows: { type: "number", description: "Terminal rows (default: 30)" },
        },
      },
    },
    {
      name: "ssh_shell_close",
      description: "Close an interactive shell session.",
      inputSchema: {
        type: "object",
        properties: {
          shellId: { type: "string", description: "Shell ID from ssh_shell (optional: defaults to recent active shell)" },
        },
      },
    },
    {
      name: "ssh_shell_list",
      description: "List all active interactive shell sessions.",
      inputSchema: { type: "object", properties: {} },
    },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: readDesktopRuntimeState()?.mcpEnabled ? TOOL_CATALOG : [],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const res = await runtimeRequest("/api/mcp/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args })
    });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(errorBody?.error || `Desktop daemon returned HTTP ${res.status}`);
    }
    const result = await res.json();
    return result as any;
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error calling daemon: ${err.message}` }], isError: true };
  }
});

let lastRuntimeSignature = "";
let unregisterBridge: (() => void) | null = null;

function syncDesktopRuntime() {
  const runtime = readDesktopRuntimeState();
  const signature = runtime
    ? `${runtime.pid}:${runtime.port}:${runtime.token}:${runtime.mcpEnabled}`
    : "offline";

  if (lastRuntimeSignature && signature !== lastRuntimeSignature) {
    void server.sendToolListChanged().catch(() => {});
    void server.sendResourceListChanged().catch(() => {});
  }

  if (lastRuntimeSignature && signature === "offline") {
    unregisterBridge?.();
    process.exit(0);
  }

  if (signature !== lastRuntimeSignature && daemonEventsSocket) {
    daemonEventsSocket.close();
    daemonEventsSocket = null;
  }

  lastRuntimeSignature = signature;
  if (runtime?.mcpEnabled) connectDaemonEvents();
}

async function main() {
  const initialRuntime = readDesktopRuntimeState();
  if (!initialRuntime) {
    throw new Error("SSH-MCP Desktop is not running. Start the Desktop app before connecting this MCP server.");
  }
  unregisterBridge = registerDesktopBridge(initialRuntime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  syncDesktopRuntime();
  const runtimeTimer = setInterval(syncDesktopRuntime, 1000);
  runtimeTimer.unref();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
