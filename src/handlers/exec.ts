import { Client, ClientChannel, PseudoTtyOptions } from "ssh2";
import { resolveClient, getSession } from "../session.js";
import { SshExecArgs, SshScriptArgs, SshBgRun, SshExecBgArgs, SshExecStopArgs, SshExecBgResultArgs } from "../types.js";

// --- Background process tracker ---

const bgRuns = new Map<string, SshBgRun>();
let runIdCounter = 0;

function generateRunId(): string {
  return `bg_${Date.now()}_${++runIdCounter}`;
}

// --- Core exec ---

let execCounter = 0;

function execOnClient(
  client: Client,
  command: string,
  timeoutMs: number,
  cwd?: string,
  env?: Record<string, string>,
  sudo?: boolean
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  partial?: boolean;
  runId?: string;
  pid?: number;
}> {
  return new Promise((resolve) => {
    let cmd = command;
    if (cwd) cmd = `cd ${escapePath(cwd)} && ${cmd}`;
    if (sudo) cmd = `sudo -S ${cmd}`;
    if (env && Object.keys(env).length > 0) {
      const exports = Object.entries(env)
        .map(([k, v]) => `export ${k}=${escapeArg(v)}`)
        .join("; ");
      cmd = `${exports}; ${cmd}`;
    }

    // Wrap command to capture PID and survive timeout:
    // - Run in background with nohup so it survives channel close
    // - Capture PID of the background process
    // - Stream output so we get partial output before timeout
    const tag = `mcp_ex_${++execCounter}_${Date.now()}`;
    const outFile = `/tmp/.mcp_${tag}.out`;
    // Wrapper: runs command with nohup so it survives channel close (timeout).
    // Streams output via tail --pid so quick commands show all output normally.
    // Clean up outFile on normal completion; on timeout (channel close),
    // `rm` never runs and the file stays for bg result checking.
    const wrapped = `sh -c 'echo "MCP_BEGIN:${tag}:$$"; >${outFile}; nohup sh -c "(${cmd})" >>${outFile} 2>&1 & bgpid=$!; echo "MCP_BGPID:$bgpid"; tail --pid=$bgpid -f ${outFile} 2>/dev/null; rm -f ${outFile}'`;

    const ptyOpts: PseudoTtyOptions = sudo
      ? { term: "xterm", cols: 120, rows: 30 }
      : undefined as unknown as PseudoTtyOptions;

    client.exec(wrapped, { pty: ptyOpts }, (err: Error | undefined, channel: ClientChannel) => {
      if (err) {
        resolve({ stdout: "", stderr: `exec error: ${err.message}`, exitCode: -1 });
        return;
      }

      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let pid: number | null = null;
      let timedOut = false;
      let parsingHeader = true;

      const timer = setTimeout(() => {
        timedOut = true;
        channel.close();
      }, timeoutMs);

      channel.on("data", (data: Buffer) => {
        let text = data.toString("utf-8");

        if (parsingHeader) {
          // Parse MCP_BEGIN:tag:shellPID and MCP_BGPID:bgPID
          const beginMatch = text.match(/MCP_BEGIN:[^:]+:(\d+)/);
          const bgpMatch = text.match(/MCP_BGPID:(\d+)/);
          // Use BGPID if available (background PID), fall back to shell PID
          if (bgpMatch) pid = parseInt(bgpMatch[1], 10);
          else if (beginMatch) pid = parseInt(beginMatch[1], 10);

          // Strip all header lines (MCP_BEGIN, MCP_BGPID, and the nohup/tail lines)
          const nl = text.lastIndexOf("MCP_BGPID:");
          if (nl >= 0) {
            const afterNl = text.indexOf("\n", nl);
            text = afterNl >= 0 ? text.slice(afterNl + 1) : "";
            parsingHeader = false;
          } else if (beginMatch && !bgpMatch) {
            const afterNl = text.indexOf("\n");
            text = afterNl >= 0 ? text.slice(afterNl + 1) : "";
          }
        }
        stdout += text;
      });
      channel.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });
      channel.on("exit", (code: number | null) => {
        exitCode = code;
      });
      channel.on("close", () => {
        clearTimeout(timer);
        if (timedOut && pid) {
          // Register as background process
          const runId = generateRunId();
          const session = (client as unknown as { __sessionId?: string }).__sessionId;
          bgRuns.set(runId, {
            id: runId,
            sessionId: session ?? "unknown",
            pid,
            command,
            startedAt: Date.now(),
            outFile,
          });
          resolve({ stdout, stderr, exitCode, timedOut: true, partial: true, runId, pid });
        } else {
          resolve({ stdout, stderr, exitCode });
        }
      });
      channel.on("error", () => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: -1 });
      });

      if (sudo) channel.stdin.end("\n");
    });
  });
}

function escapePath(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function escapeArg(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

export async function handleExec(args: SshExecArgs) {
  const timeoutMs = args.timeout ?? 600000;
  const result = await resolveClient(args, (client) => {
    // Tag the client so execOnClient can find sessionId for bg registration
    if (args.sessionId) {
      (client as unknown as { __sessionId?: string }).__sessionId = args.sessionId;
    }
    return execOnClient(client, args.command, timeoutMs, args.cwd, args.env, args.sudo);
  }) as {
    stdout: string; stderr: string; exitCode: number | null;
    timedOut?: boolean; partial?: boolean; runId?: string; pid?: number;
  };

  const contents: { type: string; text: string }[] = [];

  if (result.timedOut) {
    const timedOutLines = [
      `Command is still running (timeout after ${timeoutMs}ms). Partial output:`,
      ``,
      result.stdout || "(no output yet)",
      ...(result.stderr ? [`\nSTDERR:\n${result.stderr}`] : []),
      ``,
    ];
    if (args.sessionId && result.runId) {
      timedOutLines.push(`Use ssh_exec_bg_result sessionId="${args.sessionId}" runId="${result.runId}" to check output`);
    }
    if (args.sessionId && result.pid) {
      timedOutLines.push(`Use ssh_exec_stop sessionId="${args.sessionId}" pid=${result.pid} to stop`);
    }
    if (!args.sessionId) {
      timedOutLines.push("Background follow-up is only available in session mode. Re-run with ssh_connect + sessionId if you need resumable long-running commands.");
    }
    contents.push({ type: "text", text: timedOutLines.join("\n") });
  } else {
    contents.push({ type: "text", text: result.stdout || "(no output)" });
    if (result.stderr) {
      contents.push({ type: "text", text: `STDERR:\n${result.stderr}` });
    }
    contents.push({ type: "text", text: `\nExit code: ${result.exitCode ?? "null"}` });
  }

  return { content: contents };
}

export async function handleScript(args: SshScriptArgs) {
  const interpreter = args.interpreter ?? "sh";
  const ext = interpreter === "bash" ? "bash" : interpreter === "python" ? "py" : "sh";
  const scriptPath = `/tmp/.mcp_script_${Date.now()}.${ext}`;

  // Upload script via exec + heredoc
  const escaped = args.script.replace(/'/g, "'\\''");

  const result = await resolveClient(args, (client) =>
    execOnClient(
      client,
      `cat > ${scriptPath} << 'MCP_SCRIPT_EOF'\n${args.script}\nMCP_SCRIPT_EOF\n` +
      (args.sudo ? `sudo ` : "") + `${interpreter} ${scriptPath}` +
      `; rm -f ${scriptPath}`,
      args.timeout ?? 60000,
      args.cwd,
      args.env,
      false // sudo handled in the command itself
    )
  ) as { stdout: string; stderr: string; exitCode: number | null };

  const contents = [{ type: "text" as const, text: result.stdout || "(no output)" }];
  if (result.stderr) {
    contents.push({ type: "text" as const, text: `STDERR:\n${result.stderr}` });
  }
  contents.push({ type: "text" as const, text: `\nExit code: ${result.exitCode ?? "null"}` });

  return { content: contents };
}

export async function handleExecBg(args: SshExecBgArgs): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  if (!args.sessionId) {
    return { content: [{ type: "text" as const, text: "Error: sessionId is required for background execution" }], isError: true };
  }

  const session = getSession(args.sessionId);
  if (!session || session.type !== "ssh" || !session.client) {
    return { content: [{ type: "text" as const, text: `Error: Session '${args.sessionId}' not found or is not an SSH session` }], isError: true };
  }

  const client = session.client;
  const runId = generateRunId();
  const outFile = `/tmp/.mcp_bg_${runId}.out`;
  const pidFile = `/tmp/.mcp_bg_${runId}.pid`;
  const timeout = args.timeout ?? 30000;

  return new Promise((resolve) => {
    let cmd = args.command;
    if (args.cwd) {
      cmd = `cd '${args.cwd.replace(/'/g, "'\\''")}' && ${cmd}`;
    }
    if (args.sudo) {
      cmd = `sudo -S ${cmd}`;
    }

    const wrapped = `nohup sh -c '${cmd.replace(/'/g, "'\\''")}' > ${outFile} 2>&1 & echo $! > ${pidFile}`;

    const timer = setTimeout(() => {
      resolve({
        content: [{ type: "text" as const, text: `Error: Failed to start background process (timeout)` }],
        isError: true,
      });
    }, timeout);

    client.exec(wrapped, (err: Error | undefined, channel: ClientChannel) => {
      clearTimeout(timer);
      if (err) {
        resolve({ content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true });
        return;
      }

      let pidOutput = "";
      channel.on("data", (data: Buffer) => { pidOutput += data.toString(); });
      channel.on("close", () => {
        // Read back the PID
        client.exec(`cat ${pidFile} 2>/dev/null`, (_e2, ch2) => {
          let pidStr = "";
          ch2.on("data", (d: Buffer) => { pidStr += d.toString(); });
          ch2.on("close", () => {
            const pid = parseInt(pidStr.trim(), 10);
            if (!isNaN(pid)) {
              bgRuns.set(runId, {
                id: runId,
                sessionId: args.sessionId!,
                pid,
                command: args.command,
                startedAt: Date.now(),
              });
              resolve({
                content: [{
                  type: "text" as const,
                  text: [
                    `Background process started:`,
                    `  Run ID: ${runId}`,
                    `  PID:    ${pid}`,
                    `  Cmd:    ${args.command}`,
                    `  Output: ${outFile}`,
                    `\nUse ssh_exec_stop sessionId="${args.sessionId}" runId="${runId}" to stop`,
                    `Use ssh_exec_bg_result sessionId="${args.sessionId}" runId="${runId}" to check output`,
                  ].join("\n"),
                }],
              });
            } else {
              resolve({
                content: [{ type: "text" as const, text: `Process started but PID not captured. Check: ${outFile}` }],
              });
            }
          });
          ch2.stderr.on("data", () => {});
        });
      });
      channel.stderr.on("data", () => {});
    });
  });
}

export async function handleExecStop(args: SshExecStopArgs): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const session = getSession(args.sessionId);
  if (!session || session.type !== "ssh" || !session.client) {
    return { content: [{ type: "text" as const, text: `Error: Session '${args.sessionId}' not found or is not an SSH session` }], isError: true };
  }
  const client = session.client;

  let pid: number | null = null;
  let runInfo = "";

  if (args.runId) {
    const run = bgRuns.get(args.runId);
    if (!run || run.sessionId !== args.sessionId) {
      return { content: [{ type: "text" as const, text: `Error: Run '${args.runId}' not found in this session` }], isError: true };
    }
    pid = run.pid;
    runInfo = ` (run: ${args.runId}, cmd: ${run.command})`;
  } else if (args.pid) {
    pid = args.pid;
    runInfo = ` (pid: ${pid})`;
  }

  if (!pid) {
    return { content: [{ type: "text" as const, text: "Error: provide runId or pid" }], isError: true };
  }

  const sig = args.force ? "-9" : "-TERM";

  return new Promise((resolve) => {
    client.exec(`kill ${sig} ${pid} 2>&1; echo "exit:$?"`, (err: Error | undefined, channel: ClientChannel) => {
      if (err) {
        resolve({ content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true });
        return;
      }
      let out = "";
      channel.on("data", (d: Buffer) => { out += d.toString(); });
      channel.on("close", () => {
        if (args.runId) bgRuns.delete(args.runId);
        resolve({ content: [{ type: "text" as const, text: `Stopped process${runInfo}\n${out.trim()}` }] });
      });
      channel.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    });
  });
}

export async function handleExecBgResult(args: SshExecBgResultArgs): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const session = getSession(args.sessionId);
  if (!session || session.type !== "ssh" || !session.client) {
    return { content: [{ type: "text" as const, text: `Error: Session '${args.sessionId}' not found or is not an SSH session` }], isError: true };
  }
  const client = session.client;

  const run = bgRuns.get(args.runId);
  // Use stored outFile if available (from smart timeout), else use standard bg path
  const outFile = run?.outFile ?? `/tmp/.mcp_bg_${args.runId}.out`;

  return new Promise((resolve) => {
    client.exec(`cat ${outFile} 2>/dev/null; echo "---EXIT:---"; kill -0 ${run?.pid ?? 0} 2>/dev/null && echo "running" || echo "done"`, (err, channel) => {
      if (err) {
        resolve({ content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true });
        return;
      }
      let out = "";
      channel.on("data", (d: Buffer) => { out += d.toString(); });
      channel.on("close", () => {
        const parts = out.split("---EXIT:---\n");
        const output = parts[0]?.trim() || "(no output yet)";
        const status = parts[1]?.trim() || "unknown";
        const lines = [
          `Run:    ${args.runId}`,
          `Status: ${status === "running" ? "RUNNING" : status === "done" ? "COMPLETED/STOPPED" : "unknown"}`,
          ``,
          output,
        ];
        if (status !== "running" && run) bgRuns.delete(args.runId);
        resolve({ content: [{ type: "text" as const, text: lines.join("\n") }] });
      });
      channel.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    });
  });
}
