import { ClientChannel, PseudoTtyOptions } from "ssh2";
import { getSession } from "../session.js";
import {
  SshShellArgs, SshShellWriteArgs, SshShellReadArgs,
  SshShellResizeArgs, SshShellCloseArgs, ToolResult,
} from "../types.js";

// --- Shell session tracking ---

interface ShellSession {
  id: string;
  sessionId: string;
  channel: ClientChannel;
  buffer: string;
  closed: boolean;
  createdAt: number;
  wsClients?: Set<any>;
}

const shells = new Map<string, ShellSession>();
let shellIdCounter = 0;
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB per shell

function generateShellId(): string {
  return `sh_${Date.now()}_${++shellIdCounter}`;
}

function appendBuffer(shell: ShellSession, data: string) {
  shell.buffer += data;
  if (shell.buffer.length > MAX_BUFFER_SIZE) {
    shell.buffer = shell.buffer.slice(-MAX_BUFFER_SIZE);
  }
}

function waitForQuiet(shell: ShellSession, quietMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onData = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, quietMs);
    };

    const finish = () => {
      shell.channel.removeListener("data", onData);
      shell.channel.stderr.removeListener("data", onData);
      shell.channel.removeListener("close", onClose);
      resolve();
    };

    const onClose = () => {
      if (timer) clearTimeout(timer);
      shell.channel.removeListener("data", onData);
      shell.channel.stderr.removeListener("data", onData);
      resolve();
    };

    timer = setTimeout(finish, quietMs);
    shell.channel.on("data", onData);
    shell.channel.stderr.on("data", onData);
    shell.channel.on("close", onClose);
  });
}

// Clean up all shells belonging to a session (called on SSH disconnect)
export function cleanShellsBySession(sessionId: string) {
  for (const [id, shell] of shells) {
    if (shell.sessionId === sessionId) {
      if (!shell.closed) {
        try { shell.channel.close(); } catch { /* ignore */ }
      }
      shells.delete(id);
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
    shell.channel.stdin.write(data, "utf-8");
    return true;
  }
  return false;
}

export function listActiveShells() {
  const result: { id: string; sessionId: string; closed: boolean; age: number }[] = [];
  for (const shell of shells.values()) {
    result.push({
      id: shell.id,
      sessionId: shell.sessionId,
      closed: shell.closed,
      age: Math.floor((Date.now() - shell.createdAt) / 1000)
    });
  }
  return result;
}

// --- Handlers ---

export async function handleShellCreate(args: SshShellArgs) {
  const session = getSession(args.sessionId);
  if (!session) {
    return { content: [{ type: "text" as const, text: `Error: Session '${args.sessionId}' not found` }], isError: true };
  }

  const shellId = generateShellId();
  const cols = args.cols ?? 120;
  const rows = args.rows ?? 30;
  const term = args.term ?? "xterm";

  return new Promise<ToolResult>((resolve) => {
    const ptyOpts: PseudoTtyOptions = { term, cols, rows };

    session.client.shell(ptyOpts, (err: Error | undefined, channel: ClientChannel) => {
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
      };

      channel.on("data", (data: Buffer) => {
        const str = data.toString("utf-8");
        appendBuffer(shell, str);
        shell.wsClients?.forEach(ws => {
          if (ws.readyState === 1) ws.send(str);
        });
      });

      channel.stderr.on("data", (data: Buffer) => {
        const str = data.toString("utf-8");
        appendBuffer(shell, str);
        shell.wsClients?.forEach(ws => {
          if (ws.readyState === 1) ws.send(str);
        });
      });

      channel.on("close", () => {
        shell.closed = true;
        shell.wsClients?.forEach(ws => {
          if (ws.readyState === 1) ws.send("\r\n[Shell session closed]\r\n");
        });
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
  if (shell.closed) {
    return { content: [{ type: "text" as const, text: `Error: Shell '${args.shellId}' is closed` }], isError: true };
  }

  return new Promise<ToolResult>((resolve) => {
    shell.channel.stdin.write(args.input, "utf-8", (err: Error | null | undefined) => {
      if (err) {
        resolve({ content: [{ type: "text" as const, text: `Error writing to shell: ${err.message}` }], isError: true });
        return;
      }
      resolve({
        content: [{
          type: "text" as const,
          text: `Written ${args.input.length} bytes to shell ${args.shellId}`,
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

  // Optional: wait for output to settle
  const waitMs = args.waitMs ?? 0;
  if (waitMs > 0 && !shell.closed) {
    await waitForQuiet(shell, waitMs);
  }

  const output = shell.buffer;
  const maxLen = args.maxLength ?? 50000;
  const truncated = output.length > maxLen;
  const text = truncated ? output.slice(-maxLen) : output;

  if (args.clear ?? true) {
    shell.buffer = "";
  }

  const lines = [
    `Shell: ${args.shellId}`,
    `Status: ${shell.closed ? "CLOSED" : "OPEN"}`,
    `Buffer: ${output.length} bytes${truncated ? ` (showing last ${maxLen})` : ""}`,
    ``,
    text || "(no output)",
  ];

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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
  shells.delete(args.shellId);

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
