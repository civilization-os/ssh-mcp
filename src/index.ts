#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

import {
  createSession,
  disconnectSession,
  listSessions,
} from "./session.js";
import {
  handleExec,
  handleScript,
  handleExecBg,
  handleExecStop,
  handleExecBgResult,
} from "./handlers/exec.js";
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
  handleLogTail,
  handleLogSearch,
} from "./handlers/system.js";
import {
  handleShellCreate,
  handleShellWrite,
  handleShellRead,
  handleShellResize,
  handleShellClose,
  handleShellList,
  cleanShellsBySession,
} from "./handlers/shell.js";
import {
  validateSshConnectArgs,
  validateSshDisconnectArgs,
  validateSshExecArgs,
  validateSshScriptArgs,
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
  validateSshLogTailArgs,
  validateSshLogSearchArgs,
  validateSshExecBgArgs,
  validateSshExecStopArgs,
  validateSshExecBgResultArgs,
  validateSshShellArgs,
  validateSshShellWriteArgs,
  validateSshShellReadArgs,
  validateSshShellResizeArgs,
  validateSshShellCloseArgs,
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

const sessionAuthFields = {
  sessionId: { type: "string" as const, description: "Session ID from ssh_connect (alternative to host/password)" },
  ...authFields,
};

// --- Server ---

const server = new Server(
  { name: "ssh-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

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
        },
        required: ["host"],
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

    // ======== Command Execution ========
    {
      name: "ssh_exec",
      description: "Execute a shell command on a remote server. Supports session mode (sessionId) or direct mode (host/password).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          command: { type: "string", description: "Shell command to execute" },
          cwd: { type: "string", description: "Working directory for the command" },
          sudo: { type: "boolean", description: "Execute with sudo", default: false },
          env: { type: "object", description: "Environment variables to set", additionalProperties: { type: "string" } },
        },
        required: ["command"],
      },
    },
    {
      name: "ssh_script",
      description: "Execute a multi-line script on a remote server. Uploads to /tmp, runs, and cleans up.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          script: { type: "string", description: "Script content (multi-line)" },
          interpreter: { type: "string", description: "Interpreter (sh, bash, python, etc.)", default: "sh" },
          cwd: { type: "string", description: "Working directory for the script" },
          sudo: { type: "boolean", description: "Execute with sudo", default: false },
        },
        required: ["script"],
      },
    },
    {
      name: "ssh_exec_bg",
      description: "Run a command in background on the remote server (non-blocking). Returns a runId to check/stop later.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect (required for bg)" },
          ...authFields,
          command: { type: "string", description: "Shell command to execute in background" },
          cwd: { type: "string", description: "Working directory" },
          sudo: { type: "boolean", description: "Execute with sudo", default: false },
        },
        required: ["sessionId", "command"],
      },
    },
    {
      name: "ssh_exec_stop",
      description: "Stop a background process by runId or PID on the remote server.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          runId: { type: "string", description: "Run ID from ssh_exec_bg (alternative to pid)" },
          pid: { type: "number", description: "Process PID to kill (alternative to runId)" },
          force: { type: "boolean", description: "Use kill -9 instead of kill -TERM", default: false },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ssh_exec_bg_result",
      description: "Check output/status of a background process started with ssh_exec_bg.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          runId: { type: "string", description: "Run ID from ssh_exec_bg" },
        },
        required: ["sessionId", "runId"],
      },
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
      description: "Delete a file or directory on a remote server via SFTP.",
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
      description: "Create an interactive PTY shell session on a remote server. Returns a shellId for read/write/resize/close operations. Like Xshell — you write commands, read output.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          cols: { type: "number", description: "Terminal columns (default: 120)" },
          rows: { type: "number", description: "Terminal rows (default: 30)" },
          term: { type: "string", description: "Terminal type (default: xterm)" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "ssh_shell_write",
      description: "Write input to an interactive shell. Supports text, commands, and control sequences. Use \\n for newline/enter.",
      inputSchema: {
        type: "object",
        properties: {
          shellId: { type: "string", description: "Shell ID from ssh_shell" },
          input: { type: "string", description: "Text to write to the shell stdin (use \\n for Enter)" },
        },
        required: ["shellId", "input"],
      },
    },
    {
      name: "ssh_shell_read",
      description: "Read buffered output from an interactive shell. Optionally waits for output to settle (waitMs) before returning, like waiting for a command to finish.",
      inputSchema: {
        type: "object",
        properties: {
          shellId: { type: "string", description: "Shell ID from ssh_shell" },
          maxLength: { type: "number", description: "Max bytes to return (default: 50000, reads from end)" },
          clear: { type: "boolean", description: "Clear buffer after reading (default: true)" },
          waitMs: { type: "number", description: "Wait for N ms of silence before returning (e.g. 500 = wait until output stops)" },
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
      description: "Close an interactive shell session. Flushes remaining buffer then terminates.",
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

    // ======== Log Viewing ========
    {
      name: "ssh_log_tail",
      description: "View the tail end of a log file on the remote server.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the log file" },
          lines: { type: "number", description: "Number of lines to show (default: 50, 0 = full file)", default: 50 },
        },
        required: ["path"],
      },
    },
    {
      name: "ssh_log_search",
      description: "Search for a pattern in a log file on the remote server using grep.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from ssh_connect" },
          ...authFields,
          path: { type: "string", description: "Absolute path to the log file" },
          pattern: { type: "string", description: "Search pattern (grep syntax)" },
          context: { type: "number", description: "Lines of context before/after match (default: 2)", default: 2 },
        },
        required: ["path", "pattern"],
      },
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
          return `  ${s.id}  ${s.username}@${s.host}:${s.port}  (${alive}s)`;
        });
        return { content: [{ type: "text", text: `Active sessions (${sessions.length}):\n${lines.join("\n")}` }] };
      }

      // Command Execution
      case "ssh_exec": {
        if (!validateSshExecArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "command is required");
        }
        return await handleExec(args);
      }

      case "ssh_script": {
        if (!validateSshScriptArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "script is required");
        }
        return await handleScript(args);
      }

      case "ssh_exec_bg": {
        if (!validateSshExecBgArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "sessionId and command are required");
        }
        return await handleExecBg(args);
      }

      case "ssh_exec_stop": {
        if (!validateSshExecStopArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "sessionId and runId/pid are required");
        }
        return await handleExecStop(args);
      }

      case "ssh_exec_bg_result": {
        if (!validateSshExecBgResultArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "sessionId and runId are required");
        }
        return await handleExecBgResult(args);
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

      // Logs
      case "ssh_log_tail": {
        if (!validateSshLogTailArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        return await handleLogTail(args);
      }

      case "ssh_log_search": {
        if (!validateSshLogSearchArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "path and pattern are required");
        }
        return await handleLogSearch(args);
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

// --- Startup ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SSH MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
