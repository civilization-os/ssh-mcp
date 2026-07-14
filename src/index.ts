#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
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
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const DAEMON_PORT = 12222;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

const server = new Server(
  { name: "ssh-mcp", version: "2.2.0" },
  { capabilities: { tools: {}, resources: { subscribe: true } } }
);

async function ensureDaemonRunning() {
  try {
    const res = await fetch(`${DAEMON_URL}/api/version`);
    if (res.ok) return true;
  } catch {}

  console.error(`[MCP Proxy] Daemon not running on port ${DAEMON_PORT}. Attempting to start...`);
  
  const selfPath = process.argv[1]
    ? path.resolve(process.argv[1])
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  const daemonPath = path.join(path.dirname(selfPath), "daemon.js");
  
  if (!fs.existsSync(daemonPath)) {
    console.error(`[MCP Proxy] Daemon script not found at ${daemonPath}`);
    return false;
  }

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  
  child.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      if ((await fetch(`${DAEMON_URL}/api/version`)).ok) {
        console.error(`[MCP Proxy] Daemon successfully started.`);
        return true;
      }
    } catch {}
  }
  
  console.error(`[MCP Proxy] Failed to start daemon.`);
  return false;
}

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: [
      {
        uriTemplate: "mcp://ssh/shell/{shellId}/output",
        name: "Interactive Shell Output Stream",
        description: "Real-time incremental output and status from a PTY shell session",
        mimeType: "application/json",
      }
    ],
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const res = await fetch(`${DAEMON_URL}/api/mcp/resources`);
    if (!res.ok) throw new Error("Daemon error");
    return await res.json() as any;
  } catch (err: any) {
    throw new McpError(ErrorCode.InternalError, `Failed to list resources: ${err.message}`);
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const res = await fetch(`${DAEMON_URL}/api/mcp/resource?uri=${encodeURIComponent(request.params.uri)}`);
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

function connectDaemonEvents() {
  const ws = new WebSocket(`ws://127.0.0.1:${DAEMON_PORT}/ws/mcp-events`);
  
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
    setTimeout(connectDaemonEvents, 2000);
  });
  
  ws.on("error", () => {
    // ignore
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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
      description: "Read the contents of a file on a remote server via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the remote file" },
        },
        required: ["path"],
      },
    },
    {
      name: "ssh_file_write",
      description: "Write content to a file on a remote server via SFTP.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the remote file" },
          content: { type: "string", description: "Content to write" },
          mkdir: { type: "boolean", description: "Create parent directories if they don't exist", default: false },
        },
        required: ["path", "content"],
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
      name: "ssh_shell",
      description: "Create an interactive PTY shell session on a remote server. Returns a shellId. RECOMMENDATION: For real-time monitoring and high-frequency output, SUBSCRIBE to the resource 'mcp://ssh/shell/{shellId}/output' instead of polling ssh_shell_read.",
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
      description: "Write input to an interactive shell. Supports text, commands, and control sequences. By default, literal '\\n' is converted to a real newline and a newline is automatically appended if missing. Use 'raw: true' to send input exactly as provided.",
      inputSchema: {
        type: "object",
        properties: {
          shellId: { type: "string", description: "Shell ID from ssh_shell" },
          input: { type: "string", description: "Text to write to the shell stdin." },
          raw: { type: "boolean", description: "If true, bypass auto-newline and unescaping logic (default: false)" },
        },
        required: ["shellId", "input"],
      },
    },
    {
      name: "ssh_shell_read",
      description: "Read buffered output from an interactive shell. By default this returns the output accumulated since the last write; repeated reads return the same incremental window until the next write or clear. Use peek=true to get the current full buffer snapshot. Returns a JSON object. NOTE: This is a polling-based read. For real-time streaming, please use the resource 'mcp://ssh/shell/{shellId}/output'.",
      inputSchema: {
        type: "object",
        properties: {
          shellId: { type: "string", description: "Shell ID from ssh_shell" },
          maxLength: { type: "number", description: "Max bytes to return (default: 50000, reads from end of the current incremental window or snapshot)" },
          clear: { type: "boolean", description: "Clear the full buffer and reset the incremental window after reading (default: false)" },
          waitMs: { type: "number", description: "Wait for N ms of silence before returning (e.g. 500 = wait until output stops)" },
          maxWaitMs: { type: "number", description: "Maximum total time to wait in ms, even if output is still flowing" },
          peek: { type: "boolean", description: "Return the current full buffer snapshot immediately without advancing the read cursor" },
          stripAnsi: { type: "boolean", description: "Remove ANSI escape codes from the output (default: false)" },
          expect: { type: "string", description: "Wait until this regex pattern appears in the output (replaces waitMs if it matches early)" },
          tailLines: { type: "number", description: "Only return the last N lines of the current incremental window or snapshot" },
        },
        required: ["shellId"],
      },
    },
    {
      name: "ssh_shell_resize",
      description: "Resize the interactive terminal (change PTY cols/rows).",
      inputSchema: {
        type: "object",
        properties: {
          shellId: { type: "string", description: "Shell ID from ssh_shell" },
          cols: { type: "number", description: "Terminal columns (default: 120)" },
          rows: { type: "number", description: "Terminal rows (default: 30)" },
        },
        required: ["shellId"],
      },
    },
    {
      name: "ssh_shell_close",
      description: "Close an interactive shell session.",
      inputSchema: {
        type: "object",
        properties: {
          shellId: { type: "string", description: "Shell ID from ssh_shell" },
        },
        required: ["shellId"],
      },
    },
    {
      name: "ssh_shell_list",
      description: "List all active interactive shell sessions.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const res = await fetch(`${DAEMON_URL}/api/mcp/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args })
    });
    
    const result = await res.json();
    return result as any;
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error calling daemon: ${err.message}` }], isError: true };
  }
});

async function main() {
  await ensureDaemonRunning();
  connectDaemonEvents();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
