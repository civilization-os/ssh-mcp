import { exec } from "child_process";
import {
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createSession,
  disconnectSession,
  listSessions,
  reconnectSessionById,
} from "../session.js";
import {
  handleReadFile,
  handleWriteFile,
  handleListDir,
  handleDelete,
  handleRename,
  handleMkdir,
  handleChmod,
  handleStat,
} from "./sftp.js";
import {
  handleSysinfo,
  handleProcesses,
  handleDiskUsage,
} from "./system.js";
import {
  handleShellCreate,
  handleShellWrite,
  handleShellRead,
  handleShellResize,
  handleShellClose,
  handleShellList,
  cleanShellsBySession,
  listActiveShells,
} from "./shell.js";
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
} from "../types.js";

// === Resources Handling ===

export async function handleMcpListResources() {
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
}

export async function handleMcpReadResource(uri: string) {
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
  
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: (result as any).content[0].text,
      }
    ],
  };
}


// === Tools Handling ===

export async function handleMcpToolCall(name: string, args: any, globalHttpPort: number) {
  try {
    switch (name) {
      // Session Management
      case "ssh_connect": {
        if (!validateSshConnectArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, "Either host or sessionId is required");
        }
        
        let session;
        if (args.sessionId) {
          session = await reconnectSessionById(args.sessionId);
        } else {
          session = await createSession(args, args.name);
        }
        
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
          return `  ${s.id}  ${s.label}  ${s.username}@${s.host}:${s.port}  (${alive}s)`;
        });
        return { content: [{ type: "text", text: `Active sessions (${sessions.length}):\n${lines.join("\n")}` }] };
      }

      case "ssh_web_start": {
        const url = `http://localhost:${globalHttpPort}`;
        const platform = process.platform;
        let command = "";
        if (platform === "win32") {
          command = `start "" "${url}"`;
        } else if (platform === "darwin") {
          command = `open "${url}"`;
        } else {
          command = `xdg-open "${url}"`;
        }
        
        const result = await new Promise((resolve) => {
          exec(command, (error) => {
            if (error) {
              resolve({
                content: [{ type: "text", text: `Failed to open browser: ${error.message}` }],
                isError: true,
              });
            } else {
              resolve({
                content: [{ type: "text", text: `Successfully opened Web Dashboard at ${url}` }],
              });
            }
          });
        });
        return result as any;
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
}
