import { Client, ClientChannel } from "ssh2";
import { resolveClient } from "../session.js";
import {
  SshSysinfoArgs,
  SshProcessesArgs,
  SshDiskUsageArgs,
  SshLogTailArgs,
  SshLogSearchArgs,
} from "../types.js";

function execSimple(client: Client, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Command timeout after ${timeoutMs}ms`)), timeoutMs);
    client.exec(command, (err: Error | undefined, channel: ClientChannel) => {
      if (err) { clearTimeout(timer); reject(err); return; }
      let out = "";
      channel.on("data", (data: Buffer) => { out += data.toString("utf-8"); });
      channel.on("close", () => { clearTimeout(timer); resolve(out); });
      channel.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    });
  });
}

// --- System Info ---

export async function handleSysinfo(args: SshSysinfoArgs) {
  const timeout = args.timeout ?? 15000;

  const result = await resolveClient(args, (client) =>
    Promise.all([
      execSimple(client, "uname -a", timeout),
      execSimple(client, "cat /proc/cpuinfo | grep 'model name' | head -1 | cut -d: -f2", timeout),
      execSimple(client, "nproc", timeout),
      execSimple(client, "free -h | grep 'Mem:'", timeout),
      execSimple(client, "free -h | grep 'Swap:'", timeout),
      execSimple(client, "df -h / | tail -1", timeout),
      execSimple(client, "uptime -p 2>/dev/null || uptime", timeout),
      execSimple(client, "cat /proc/loadavg", timeout),
      execSimple(client, "uname -r", timeout),
      execSimple(client, "uname -m", timeout),
    ])
  ) as string[];

  const [uname, cpuModel, cpuCores, memory, swap, disk, uptime, loadavg, kernel, arch] = result;
  const memMatch = memory.match(/Mem:\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);
  const swapMatch = swap.match(/Swap:\s+(\S+)\s+(\S+)\s+(\S+)/);
  const diskMatch = disk.match(/(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)%\s+(\S+)/);

  const info = [
    `OS:       ${uname.split(" ")[0] ?? "?"}`,
    `Kernel:   ${kernel.trim()}`,
    `Arch:     ${arch.trim()}`,
    `CPU:      ${(cpuModel ?? "?").trim()} (${(cpuCores ?? "?").trim()} cores)`,
    `Memory:   ${memMatch ? `total=${memMatch[1]} used=${memMatch[2]} free=${memMatch[3]} (${memMatch[4]})` : memory.trim() || "N/A"}`,
    `Swap:     ${swapMatch ? `total=${swapMatch[1]} used=${swapMatch[2]} free=${swapMatch[3]}` : swap.trim() || "N/A"}`,
    `Disk (/): ${diskMatch ? `total=${diskMatch[1]} used=${diskMatch[2]} free=${diskMatch[3]} (${diskMatch[5]}%)` : disk.trim() || "N/A"}`,
    `Uptime:   ${uptime.trim()}`,
    `Load:     ${loadavg.trim()}`,
  ].join("\n");

  return { content: [{ type: "text" as const, text: info }] };
}

// --- Processes ---

export async function handleProcesses(args: SshProcessesArgs) {
  const sortCol = args.sort === "memory" ? "%mem" : args.sort === "cpu" ? "%cpu" : "pid";
  const limit = args.limit ?? 20;
  const psCmd = `ps aux --sort=-${sortCol} | head -${limit + 1}`;
  const timeout = args.timeout ?? 15000;

  const result = await resolveClient(args, (client) =>
    execSimple(client, psCmd, timeout)
  ) as string;

  return { content: [{ type: "text" as const, text: result.trim() || "(no output)" }] };
}

// --- Disk Usage ---

export async function handleDiskUsage(args: SshDiskUsageArgs) {
  const target = args.path ?? "/";
  const timeout = args.timeout ?? 15000;

  const result = await resolveClient(args, (client) =>
    execSimple(client, `df -h ${target} 2>/dev/null || df -h`, timeout)
  ) as string;

  return { content: [{ type: "text" as const, text: result.trim() || "(no output)" }] };
}

// --- Log Tail ---

export async function handleLogTail(args: SshLogTailArgs) {
  const lines = args.lines ?? 50;
  const timeout = args.timeout ?? 15000;

  const result = await resolveClient(args, (client) => {
    if (lines > 0) {
      return execSimple(client, `tail -${lines} ${args.path} 2>&1`, timeout);
    }
    return execSimple(client, `cat ${args.path} 2>&1`, timeout);
  }) as string;

  return { content: [{ type: "text" as const, text: result.trim() || "(empty file)" }] };
}

// --- Log Search ---

export async function handleLogSearch(args: SshLogSearchArgs) {
  const ctx = args.context ?? 2;
  const timeout = args.timeout ?? 30000;
  const pattern = args.pattern.replace(/'/g, "'\\''");

  const result = await resolveClient(args, (client) =>
    execSimple(client, `grep -n -C ${ctx} '${pattern}' ${args.path} 2>&1 || echo "(no matches)"`, timeout)
  ) as string;

  return { content: [{ type: "text" as const, text: result.trim() }] };
}
