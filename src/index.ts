#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import net from "net";
import { WebSocket, createWebSocketStream } from "ws";
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

import {
  createSession,
  createK8sSession,
  disconnectSession,
  listSessions,
  loadAndReconnectSessions,
} from "./session.js";
import {
  handleReadFile,
  handleWriteFile,
  handleListDir,
  handleDelete,
  handleRename,
  handleMkdir,
  handleChmod,
  handleStat,
} from "./handlers/sftp.js";
import {
  handleSysinfo,
  handleProcesses,
  handleDiskUsage,
} from "./handlers/system.js";
import {
  handleK8sListPods,
  handleK8sPodLogs,
  handleK8sPodExec,
  handleK8sPodCp,
  handleK8sArthasAttach,
} from "./handlers/k8s.js";
import {
  handleShellCreate,
  handleShellWrite,
  handleShellRead,
  handleShellResize,
  handleShellClose,
  handleShellList,
  cleanShellsBySession,
  shellEvents,
} from "./handlers/shell.js";
import { startHttpServer } from "./server.js";
import {
  validateSshConnectArgs,
  validateSshDisconnectArgs,
  validateSshFileReadArgs,
  validateSshFileWriteArgs,
  validateSshFileListArgs,
  validateSshFileDeleteArgs,
  validateSshFileRenameArgs,
  validateSshFileMkdirArgs,
  validateSshFileChmodArgs,
  validateSshFileStatArgs,
  validateSshSysinfoArgs,
  validateSshProcessesArgs,
  validateSshDiskUsageArgs,
  validateSshShellArgs,
  validateSshShellWriteArgs,
  validateSshShellReadArgs,
  validateSshShellResizeArgs,
  validateSshShellCloseArgs,
  validateK8sConnectArgs,
  validateSshK8sListPodsArgs,
  validateSshK8sPodLogsArgs,
  validateSshK8sPodExecArgs,
  validateSshK8sPodCpArgs,
  validateSshK8sArthasAttachArgs,
  extractCredentials,
  extractSessionId,
} from "./types.js";

// --- Auth fields shared across tools ---

const authFields = {
  host: { type: "string" as const, description: "Remote server hostname or IP address" },
  port: { type: "number" as const, description: "SSH port (default: 22)", default: 22 },
  username: { type: "string" as const, description: "SSH username (default: root)", default: "root" },
  password: { type: "string" as const, description: "SSH password (use either password or privateKey)" },
  privateKey: { type: "string" as const, description: "SSH private key content as string" },
  passphrase: { type: "string" as const, description: "Passphrase for the private key" },
  timeout: { type: "number" as const, description: "Operation timeout in milliseconds (default: 30000)", default: 30000 },
};

const k8sConfigFields = {
  kubectlPath: { type: "string" as const, description: "Optional custom kubectl path on the remote host" },
  kubeconfig: { type: "string" as const, description: "Optional custom kubeconfig path on the remote host" },
};

// --- Server ---

const server = new Server(
  { name: "ssh-mcp", version: "2.0.0" },
  { capabilities: { tools: {}, resources: { subscribe: true } } }
);

// --- Resource definitions ---

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
  const { listActiveShells } = await import("./handlers/shell.js");
  const shells = listActiveShells();
  
  const resources = [
    {
      uri: "mcp://ssh/sessions",
      name: "Active SSH Sessions",
      description: "List of all persistent SSH sessions managed by this server",
      mimeType: "application/json",
    },
    {
      uri: "mcp://ssh/shells",
      name: "Active Interactive Shells",
      description: "List of all active PTY shell sessions and their status",
      mimeType: "application/json",
    }
  ];

  shells.forEach(s => {
    resources.push({
      uri: `mcp://ssh/shell/${s.id}/output`,
      name: `Shell Output (${s.id})`,
      description: `Output stream for shell ${s.id} (Session: ${s.sessionId})`,
      mimeType: "application/json",
    });
  });
  
  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === "mcp://ssh/sessions") {
    const sessions = listSessions();
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(sessions, null, 2),
      }],
    };
  }

  if (uri === "mcp://ssh/shells") {
    const { listActiveShells } = await import("./handlers/shell.js");
    const shells = listActiveShells();
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(shells, null, 2),
      }],
    };
  }

  const match = uri.match(/^mcp:\/\/ssh\/shell\/([^/]+)\/output$/);
  if (!match) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
  }
  
  const shellId = match[1];
  const result = await handleShellRead({ shellId, peek: true } as any);
  
  // result.content[0].text contains a JSON string of the shell status and output
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: (result as any).content[0].text,
      }
    ],
  };
});

// --- Subscription management ---

const activeSubscriptions = new Set<string>();

server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  activeSubscriptions.add(request.params.uri);
  return {};
});

server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  activeSubscriptions.delete(request.params.uri);
  return {};
});

// Listen for shell data events and notify subscribers
shellEvents.on("data", (shellId: string) => {
  const uri = `mcp://ssh/shell/${shellId}/output`;
  if (activeSubscriptions.has(uri)) {
    server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  }
});

// Clean up subscriptions when shell is closed/destroyed
shellEvents.on("close", (shellId: string) => {
  const uri = `mcp://ssh/shell/${shellId}/output`;
  activeSubscriptions.delete(uri);
});

// --- Tool definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ======== Session Management ========
    {
      name: "ssh_connect",
      description: "Create a persistent SSH session. Returns a sessionId that can be reused by other tools.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Optional label for the session" },
          ...authFields,
          ...k8sConfigFields,
        },
        required: ["host"],
      },
    },
    {
      name: "k8s_connect",
      description: "Register a local Kubernetes session on the MCP server host. Supports either kubeconfig input or direct API server credentials that will be converted into a temporary kubeconfig.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Optional label for the session" },
          kubeconfig: { type: "string", description: "Kubeconfig YAML content or local file path" },
          server: { type: "string", description: "Kubernetes API server URL, for example https://10.0.0.1:6443" },
          namespace: { type: "string", description: "Default namespace for the generated kubeconfig context" },
          insecureSkipTlsVerify: { type: "boolean", description: "Skip API server TLS verification when generating kubeconfig" },
          serverName: { type: "string", description: "Optional TLS server name override for API server certificate verification" },
          certificateAuthority: { type: "string", description: "CA certificate local file path or PEM content" },
          certificateAuthorityData: { type: "string", description: "CA certificate PEM content or base64-encoded PEM" },
          clientCertificate: { type: "string", description: "Client certificate local file path or PEM content" },
          clientCertificateData: { type: "string", description: "Client certificate PEM content or base64-encoded PEM" },
          clientKey: { type: "string", description: "Client private key local file path or PEM content" },
          clientKeyData: { type: "string", description: "Client private key PEM content or base64-encoded PEM" },
          token: { type: "string", description: "Bearer token for API server authentication" },
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



    // ======== SFTP File Operations ========
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

    // ======== System Monitoring ========
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

    // ======== Interactive Shell (PTY) ========
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

    // ======== Kubernetes ========
    {
      name: "ssh_k8s_list_pods",
      description: "List Kubernetes pods in all namespaces or a specific namespace.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          ...authFields,
          ...k8sConfigFields,
          namespace: { type: "string", description: "Optional specific namespace (lists all namespaces if omitted)" }
        }
      }
    },
    {
      name: "ssh_k8s_pod_logs",
      description: "Fetch logs from a Kubernetes pod container.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          ...authFields,
          ...k8sConfigFields,
          namespace: { type: "string", description: "Kubernetes namespace" },
          pod: { type: "string", description: "Pod name" },
          container: { type: "string", description: "Optional container name (defaults to first container)" },
          tail: { type: "number", description: "Lines of tail log to fetch (default: 100)", default: 100 }
        },
        required: ["namespace", "pod"]
      }
    },
    {
      name: "ssh_k8s_pod_exec",
      description: "Execute a command inside a Kubernetes pod container.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          ...authFields,
          ...k8sConfigFields,
          namespace: { type: "string", description: "Kubernetes namespace" },
          pod: { type: "string", description: "Pod name" },
          container: { type: "string", description: "Optional container name" },
          command: { type: "string", description: "Command to execute inside the container" }
        },
        required: ["namespace", "pod", "command"]
      }
    },
    {
      name: "ssh_k8s_pod_cp",
      description: "Copy files/directories between host and Kubernetes pod container.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          ...authFields,
          ...k8sConfigFields,
          namespace: { type: "string", description: "Kubernetes namespace" },
          pod: { type: "string", description: "Pod name" },
          container: { type: "string", description: "Optional container name" },
          direction: { type: "string", description: "Direction: 'to_pod' or 'from_pod'", enum: ["to_pod", "from_pod"] },
          hostPath: { type: "string", description: "Path on the jump host" },
          podPath: { type: "string", description: "Path on the pod container" }
        },
        required: ["namespace", "pod", "direction", "hostPath", "podPath"]
      }
    },
    {
      name: "ssh_k8s_arthas_attach",
      description: "Attach Arthas to a Java process on the host or inside a pod, and execute a command. Supports offline mode using local assets if available.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          ...authFields,
          ...k8sConfigFields,
          namespace: { type: "string", description: "Kubernetes namespace (omit if running on host)" },
          pod: { type: "string", description: "Pod name (omit if running on host)" },
          container: { type: "string", description: "Optional container name" },
          pid: { type: "number", description: "Optional target Java PID (auto-detected if omitted)" },
          command: { type: "string", description: "Arthas command to run (e.g. 'thread -n 3', 'dashboard -n 1')" },
          arthasVersion: { type: "string", description: "Specific Arthas version to use (must exist in local assets)" },
          jdkVersion: { type: "string", description: "Specific JDK version to use for attach (e.g. '8', '11'; must exist in local assets)" },
          timeout: { type: "number", description: "Command timeout in ms (default: 300000)" },
        },
        required: ["command"]
      }
    },
  ],
}));

// --- Request handler ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // Session Management
      case "ssh_connect": {
        if (!validateSshConnectArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "host is required");
        }
        const session = await createSession(args, args.name);
        return {
          content: [{
            type: "text",
            text: [
              `Session created: ${session.id}`,
              `  Label: ${session.label}`,
              `  Host:  ${session.host}:${session.port}`,
              `  User:  ${session.username}`,
            ].join("\n"),
          }],
        };
      }

      case "k8s_connect": {
        if (!validateK8sConnectArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "Provide either kubeconfig, or server plus token, or server plus clientCertificate/clientKey");
        }
        const session = await createK8sSession(args);
        return {
          content: [{
            type: "text",
            text: [
              `K8s Session created: ${session.id}`,
              `  Label: ${session.label}`,
            ].join("\n"),
          }],
        };
      }

      case "ssh_disconnect": {
        if (!validateSshDisconnectArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "sessionId is required");
        }
        cleanShellsBySession(args.sessionId);
        const ok = disconnectSession(args.sessionId);
        return {
          content: [{
            type: "text",
            text: ok ? `Session ${args.sessionId} disconnected` : `Session ${args.sessionId} not found`,
          }],
        };
      }

      case "ssh_sessions": {
        const sessions = listSessions();
        if (sessions.length === 0) {
          return { content: [{ type: "text", text: "No active sessions" }] };
        }
        const lines = sessions.map(s => {
          const alive = Math.floor((Date.now() - s.createdAt) / 1000);
          return `  ${s.id}  ${s.label}  ${s.username}@${s.host}:${s.port}  (${alive}s)`;
        });
        return { content: [{ type: "text", text: `Active sessions (${sessions.length}):\n${lines.join("\n")}` }] };
      }



      // SFTP
      case "ssh_file_read": {
        if (!validateSshFileReadArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        return await handleReadFile(args);
      }

      case "ssh_file_write": {
        if (!validateSshFileWriteArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "path and content are required");
        }
        return await handleWriteFile(args);
      }

      case "ssh_file_list": {
        if (!validateSshFileListArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        return await handleListDir(args);
      }

      case "ssh_file_delete": {
        if (!validateSshFileDeleteArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        return await handleDelete(args);
      }

      case "ssh_file_rename": {
        if (!validateSshFileRenameArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "source and dest are required");
        }
        return await handleRename(args);
      }

      case "ssh_file_mkdir": {
        if (!validateSshFileMkdirArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        return await handleMkdir(args);
      }

      case "ssh_file_chmod": {
        if (!validateSshFileChmodArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "path and mode are required");
        }
        return await handleChmod(args);
      }

      case "ssh_file_stat": {
        if (!validateSshFileStatArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        return await handleStat(args);
      }

      // System
      case "ssh_sysinfo": {
        if (!validateSshSysinfoArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "invalid arguments");
        }
        return await handleSysinfo(args);
      }

      case "ssh_processes": {
        if (!validateSshProcessesArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "invalid arguments");
        }
        return await handleProcesses(args);
      }

      case "ssh_disk_usage": {
        if (!validateSshDiskUsageArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "invalid arguments");
        }
        return await handleDiskUsage(args);
      }

      case "ssh_k8s_list_pods": {
        if (!validateSshK8sListPodsArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "Invalid parameters");
        }
        return await handleK8sListPods(args);
      }

      case "ssh_k8s_pod_logs": {
        if (!validateSshK8sPodLogsArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "namespace and pod are required");
        }
        return await handleK8sPodLogs(args);
      }

      case "ssh_k8s_pod_exec": {
        if (!validateSshK8sPodExecArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "namespace, pod and command are required");
        }
        return await handleK8sPodExec(args);
      }

      case "ssh_k8s_pod_cp": {
        if (!validateSshK8sPodCpArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "namespace, pod, direction, hostPath, podPath are required");
        }
        return await handleK8sPodCp(args);
      }

      case "ssh_k8s_arthas_attach": {
        if (!validateSshK8sArthasAttachArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "command is required");
        }
        return await handleK8sArthasAttach(args);
      }

      // Interactive Shell
      case "ssh_shell": {
        if (!validateSshShellArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "sessionId is required");
        }
        return await handleShellCreate(args);
      }

      case "ssh_shell_write": {
        if (!validateSshShellWriteArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "shellId and input are required");
        }
        return await handleShellWrite(args);
      }

      case "ssh_shell_read": {
        if (!validateSshShellReadArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "shellId is required");
        }
        return await handleShellRead(args);
      }

      case "ssh_shell_resize": {
        if (!validateSshShellResizeArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "shellId is required");
        }
        return await handleShellResize(args);
      }

      case "ssh_shell_close": {
        if (!validateSshShellCloseArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "shellId is required");
        }
        return await handleShellClose(args);
      }

      case "ssh_shell_list": {
        return await handleShellList();
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

async function main() {
  const port = 12222;

  // Start or reuse the browser console service for this machine.
  const httpServer = await startHttpServer(port);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Resolve absolute path to this build file for MCP client config
  const selfPath = process.argv[1]
    ? path.resolve(process.argv[1])
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

  const mcpConfig = {
    mcpServers: {
      "ssh-mcp": {
        command: "node",
        args: [selfPath]
      }
    }
  };

  console.error("╔══════════════════════════════════════════════════════════╗");
  console.error("║              SSH-MCP Server — READY                     ║");
  console.error("╠══════════════════════════════════════════════════════════╣");
  console.error("║  Protocol : stdio (MCP JSON-RPC)                        ║");
  console.error(`║  REST/WS  : http://localhost:${httpServer.port}                      ║`);
  console.error(`║  Web UI   : http://localhost:${httpServer.port}                      ║`);
  console.error(`║  UI Mode  : ${httpServer.reused ? "reuse existing" : "started local"}                         ║`);
  console.error("╠══════════════════════════════════════════════════════════╣");
  console.error("║  Add to your MCP client (e.g. Claude Desktop):          ║");
  console.error("╚══════════════════════════════════════════════════════════╝");
  console.error(JSON.stringify(mcpConfig, null, 2));
  console.error("────────────────────────────────────────────────────────────");

  // Remove any legacy on-disk session store from older versions.
  await loadAndReconnectSessions();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
