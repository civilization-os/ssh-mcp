import { ClientChannel, PseudoTtyOptions } from "ssh2";
import { getSession } from "../session.js";
import {
  SshShellArgs, SshShellWriteArgs, SshShellReadArgs,
  SshShellResizeArgs, SshShellCloseArgs, ToolResult,
} from "../types.js";
import { EventEmitter } from "events";

export const shellEvents = new EventEmitter();

// --- Shell session tracking ---

interface ShellSession {
  id: string;
  sessionId: string;
  channel: ClientChannel;
  buffer: string;
  closed: boolean;
  createdAt: number;
  wsClients?: Set<any>;
  readCursor: number;
  keepAlive?: boolean;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

const shells = new Map<string, ShellSession>();
let shellIdCounter = 0;
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB per shell

function generateShellId(): string {
  return `sh_${Date.now()}_${++shellIdCounter}`;
}

function appendBuffer(shell: ShellSession, data: string) {
  shell.buffer += data;
  if (shell.buffer.length > MAX_BUFFER_SIZE) {
    const overflow = shell.buffer.length - MAX_BUFFER_SIZE;
    shell.buffer = shell.buffer.slice(-MAX_BUFFER_SIZE);
    // Adjust cursor after truncation
    shell.readCursor = Math.max(0, (shell.readCursor || 0) - overflow);
  }
}

function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

function waitForQuiet(shell: ShellSession, quietMs: number, maxWaitMs?: number, expectPattern?: string): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;
    let expectRegex: RegExp | null = null;

    if (expectPattern) {
      try {
        expectRegex = new RegExp(expectPattern);
      } catch (e) {
        // Fallback to simple include if regex is invalid
        console.warn(`Invalid regex pattern in expect: ${expectPattern}`);
      }
    }

    const finish = () => {
      if (timer) clearTimeout(timer);
      if (maxTimer) clearTimeout(maxTimer);
      shell.channel.removeListener("data", onData);
      shell.channel.stderr.removeListener("data", onData);
      shell.channel.removeListener("close", onClose);
      resolve();
    };

    const onData = () => {
      if (expectRegex) {
        // Only check data after the cursor for new matches
        const searchable = shell.buffer.slice(shell.readCursor);
        const tail = searchable.slice(-4096);
        if (expectRegex.test(tail) || expectRegex.test(stripAnsi(tail))) {
          finish();
          return;
        }
      } else if (expectPattern && shell.buffer.slice(shell.readCursor).includes(expectPattern)) {
        finish();
        return;
      }

      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, quietMs);
    };

    const onClose = () => {
      finish();
    };

    // Initial check (only in the new content since readCursor)
    if (expectRegex) {
      const searchable = shell.buffer.slice(shell.readCursor);
      const tail = searchable.slice(-4096);
      if (expectRegex.test(tail) || expectRegex.test(stripAnsi(tail))) {
        finish();
        return;
      }
    } else if (expectPattern && shell.buffer.slice(shell.readCursor).includes(expectPattern)) {
      finish();
      return;
    }

    timer = setTimeout(finish, quietMs);
    if (maxWaitMs && maxWaitMs > 0) {
      maxTimer = setTimeout(finish, maxWaitMs);
    }

    shell.channel.on("data", onData);
    shell.channel.stderr.on("data", onData);
    shell.channel.on("close", onClose);
  });
}

// Clean up all shells belonging to a session (called on SSH disconnect)
export function cleanShellsBySession(sessionId: string) {
  for (const [id, shell] of shells) {
    if (shell.sessionId === sessionId) {
      if (shell.heartbeatTimer) {
        clearInterval(shell.heartbeatTimer);
      }
      if (!shell.closed) {
        try { shell.channel.close(); } catch { /* ignore */ }
      }
      shells.delete(id);
      shellEvents.emit("close", id);
    }
  }
}

// --- WebSocket Support Helpers ---

export function attachWsToShell(shellId: string, ws: any) {
  const shell = shells.get(shellId);
  if (!shell) return false;
  if (!shell.wsClients) {
    shell.wsClients = new Set();
  }
  shell.wsClients.add(ws);
  if (shell.buffer) {
    ws.send(shell.buffer);
  }
  return true;
}

export function detachWsFromShell(shellId: string, ws: any) {
  const shell = shells.get(shellId);
  if (shell && shell.wsClients) {
    shell.wsClients.delete(ws);
  }
}

export function writeInputToShell(shellId: string, data: string) {
  const shell = shells.get(shellId);
  if (shell && !shell.closed) {
    import("../session.js").then(({ touchSession }) => {
      try { touchSession(shell.sessionId); } catch {}
    }).catch(() => {});
    shell.channel.stdin.write(data, "utf-8");
    return true;
  }
  return false;
}

export function listActiveShells() {
  const result: { id: string; sessionId: string; closed: boolean; age: number; keepAlive: boolean }[] = [];
  for (const shell of shells.values()) {
    result.push({
      id: shell.id,
      sessionId: shell.sessionId,
      closed: shell.closed,
      age: Math.floor((Date.now() - shell.createdAt) / 1000),
      keepAlive: !!shell.keepAlive
    });
  }
  return result;
}

export function hasActiveShells(sessionId: string): boolean {
  for (const shell of shells.values()) {
    if (shell.sessionId === sessionId && !shell.closed) {
      return true;
    }
  }
  return false;
}

// --- Handlers ---

export async function handleShellCreate(args: SshShellArgs) {
  const session = getSession(args.sessionId);
  if (!session || session.type !== "ssh" || !session.client) {
    return { content: [{ type: "text" as const, text: `Error: Session '${args.sessionId}' not found or is not an SSH session` }], isError: true };
  }
  const client = session.client;

  const shellId = generateShellId();
  const cols = args.cols ?? 120;
  const rows = args.rows ?? 30;
  const term = args.term ?? "xterm";

  return new Promise<ToolResult>((resolve) => {
    const ptyOpts: PseudoTtyOptions = { term, cols, rows };

    client.shell(ptyOpts, (err: Error | undefined, channel: ClientChannel) => {
      if (err) {
        resolve({ content: [{ type: "text" as const, text: `Error creating shell: ${err.message}` }], isError: true });
        return;
      }

      const shell: ShellSession = {
        id: shellId,
        sessionId: args.sessionId,
        channel,
        buffer: "",
        closed: false,
        createdAt: Date.now(),
        readCursor: 0,
        keepAlive: !!args.keepAlive,
      };

      // Heartbeat to prevent TMOUT (inactivity timeout)
      if (args.keepAlive) {
        shell.heartbeatTimer = setInterval(() => {
          if (!shell.closed) {
            // Send a null byte - most shells see this as activity but ignore the character
            channel.stdin.write("\x00");
            // Notify WebSocket clients that a heartbeat was sent
            shell.wsClients?.forEach(ws => {
              if (ws.readyState === 1) ws.send("\x01HB");
            });
          } else if (shell.heartbeatTimer) {
            clearInterval(shell.heartbeatTimer);
          }
        }, 30000); // Every 30 seconds
      }

      channel.on("data", (data: Buffer) => {
        import("../session.js").then(({ touchSession }) => {
          try { touchSession(args.sessionId); } catch {}
        }).catch(() => {});
        const str = data.toString("utf-8");
        appendBuffer(shell, str);
        shell.wsClients?.forEach(ws => {
          if (ws.readyState === 1) ws.send(str);
        });
        shellEvents.emit("data", shellId);
      });

      channel.stderr.on("data", (data: Buffer) => {
        import("../session.js").then(({ touchSession }) => {
          try { touchSession(args.sessionId); } catch {}
        }).catch(() => {});
        const str = data.toString("utf-8");
        appendBuffer(shell, str);
        shell.wsClients?.forEach(ws => {
          if (ws.readyState === 1) ws.send(str);
        });
        shellEvents.emit("data", shellId);
      });

      channel.on("close", () => {
        shell.closed = true;
        if (shell.heartbeatTimer) {
          clearInterval(shell.heartbeatTimer);
          shell.heartbeatTimer = undefined;
        }
        shell.wsClients?.forEach(ws => {
          if (ws.readyState === 1) ws.send("\r\n[Shell session closed]\r\n");
        });
        // Emit one last data event so subscribers read the CLOSED state, then emit close
        shellEvents.emit("data", shellId);
        shellEvents.emit("close", shellId);
      });

      channel.on("error", (err: Error) => {
        appendBuffer(shell, `\n[Shell Error: ${err.message}]\n`);
      });

      shells.set(shellId, shell);

      // Small delay to capture the shell prompt
      setTimeout(() => {
        resolve({
          content: [{
            type: "text" as const,
            text: [
              `Interactive shell created: ${shellId}`,
              `  Session: ${args.sessionId}`,
              `  Terminal: ${term} ${cols}x${rows}`,
              shell.buffer ? `\n${shell.buffer}` : "",
            ].filter(Boolean).join("\n"),
          }],
        });
      }, 300);
    });
  });
}

export async function handleShellWrite(args: SshShellWriteArgs) {
  const shell = shells.get(args.shellId);
  if (!shell) {
    return { content: [{ type: "text" as const, text: `Error: Shell '${args.shellId}' not found` }], isError: true };
  }

  try {
    const { touchSession } = await import("../session.js");
    touchSession(shell.sessionId);
  } catch {}

  if (shell.closed) {
    return { content: [{ type: "text" as const, text: `Error: Shell '${args.shellId}' is closed` }], isError: true };
  }

  let input = args.input || "";
  
  if (!args.raw) {
    // Adapt for agents that send literal \n or forget it
    // 1. Unescape literal \n, \r, \t
    input = input
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
    
    // 2. Auto-append newline if missing and not a control sequence
    if (input.length > 0 && 
        !input.endsWith('\n') && 
        !input.endsWith('\r') &&
        !input.endsWith('\x03') && // Ctrl+C
        !input.endsWith('\x04')    // Ctrl+D
       ) {
      input += '\n';
    }
  }

  return new Promise<ToolResult>((resolve) => {
    // Before writing, update the cursor to ignore any previous output for future expects
    shell.readCursor = shell.buffer.length;
    
    shell.channel.stdin.write(input, "utf-8", (err: Error | null | undefined) => {
      if (err) {
        resolve({ content: [{ type: "text" as const, text: `Error writing to shell: ${err.message}` }], isError: true });
        return;
      }
      resolve({
        content: [{
          type: "text" as const,
          text: `Written ${input.length} bytes to shell ${args.shellId}`,
        }],
      });
    });
  });
}

export async function handleShellRead(args: SshShellReadArgs) {
  const shell = shells.get(args.shellId);
  if (!shell) {
    return { content: [{ type: "text" as const, text: `Error: Shell '${args.shellId}' not found` }], isError: true };
  }

  try {
    const { touchSession } = await import("../session.js");
    touchSession(shell.sessionId);
  } catch {}

  // Optional: wait for output to settle or for a specific pattern
  const waitMs = args.waitMs ?? 0;
  if ((waitMs > 0 || args.expect) && !shell.closed && !args.peek) {
    await waitForQuiet(shell, waitMs, args.maxWaitMs, args.expect);
  }

  let output = shell.buffer;
  const maxLen = args.maxLength ?? 50000;
  
  if (args.stripAnsi) {
    output = stripAnsi(output);
  }

  // Handle tailLines snapshot with performance optimization
  if (args.tailLines && args.tailLines > 0) {
    // If output is large, take only the last ~128KB to avoid splitting a huge string
    const CHUNK_SIZE = 128 * 1024;
    const tailChunk = output.length > CHUNK_SIZE ? output.slice(-CHUNK_SIZE) : output;
    const lines = tailChunk.split(/\r?\n/);
    if (lines.length > args.tailLines) {
      output = lines.slice(-args.tailLines).join("\n");
    } else {
      // If the last 128KB has fewer lines than requested, we might need the whole thing, 
      // but usually 128KB is plenty for any reasonable tailLines value.
      output = lines.slice(-args.tailLines).join("\n");
    }
  }

  const truncated = output.length > maxLen;
  const text = truncated ? output.slice(-maxLen) : output;

  if ((args.clear ?? false) && !args.peek) {
    shell.buffer = "";
    shell.readCursor = 0;
  } else if (!args.peek) {
    // Advance cursor to mark all current content as read/acknowledged
    shell.readCursor = shell.buffer.length;
  }

  // Heuristic for prompt detection (strip ANSI before checking)
  const cleanTail = stripAnsi(text.slice(-100));
  const promptShown = /[:\w\s~.-]+[@\w\s~.-]+[#$>]\s*$/.test(cleanTail);

  const result = {
    shellId: args.shellId,
    status: shell.closed ? "CLOSED" : "OPEN",
    promptShown,
    bufferSize: output.length,
    truncated,
    content: text || "(no output)"
  };

  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

export async function handleShellResize(args: SshShellResizeArgs) {
  const shell = shells.get(args.shellId);
  if (!shell) {
    return { content: [{ type: "text" as const, text: `Error: Shell '${args.shellId}' not found` }], isError: true };
  }
  if (shell.closed) {
    return { content: [{ type: "text" as const, text: `Error: Shell '${args.shellId}' is closed` }], isError: true };
  }

  const cols = args.cols ?? 120;
  const rows = args.rows ?? 30;

  shell.channel.setWindow(rows, cols, 0, 0);
  return {
    content: [{
      type: "text" as const,
      text: `Shell ${args.shellId} resized to ${cols}x${rows}`,
    }],
  };
}

export async function handleShellClose(args: SshShellCloseArgs) {
  const shell = shells.get(args.shellId);
  if (!shell) {
    return { content: [{ type: "text" as const, text: `Error: Shell '${args.shellId}' not found` }], isError: true };
  }

  if (!shell.closed) {
    shell.channel.close();
  }
  if (shell.heartbeatTimer) {
    clearInterval(shell.heartbeatTimer);
  }
  shells.delete(args.shellId);
  shellEvents.emit("close", args.shellId);

  return {
    content: [{
      type: "text" as const,
      text: `Shell ${args.shellId} closed.`,
    }],
  };
}

export async function handleShellList() {
  if (shells.size === 0) {
    return { content: [{ type: "text" as const, text: "No active interactive shells" }] };
  }
  const lines = Array.from(shells.values()).map((s) => {
    const age = Math.floor((Date.now() - s.createdAt) / 1000);
    return `  ${s.id}  session: ${s.sessionId}  ${s.closed ? "CLOSED" : "OPEN"}  (${age}s ago)`;
  });
  return { content: [{ type: "text" as const, text: `Interactive shells:\n${lines.join("\n")}` }] };
}
