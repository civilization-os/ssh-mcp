import { Client, ClientChannel } from "ssh2";
import { resolveClient } from "../session.js";
import {
  SshSysinfoArgs,
  SshProcessesArgs,
  SshDiskUsageArgs,
} from "../types.js";

// --- Stats (CPU/Mem %) ---
export async function handleStats(args: { sessionId: string; timeout?: number }) {
  const timeout = args.timeout ?? 5000;
  // Use /proc/stat and /proc/meminfo for robust cross-distro metrics without depending on top/free formatting
  const cmd = `
    MemTotal=$(awk '/MemTotal:/ {print $2}' /proc/meminfo)
    MemAvail=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
    if [ -z "$MemAvail" ]; then MemAvail=$(awk '/MemFree:/ {print $2}' /proc/meminfo); fi
    if [ -n "$MemTotal" ] && [ "$MemTotal" -gt 0 ] && [ -n "$MemAvail" ]; then
      MEM=$(awk "BEGIN {printf \\"%.1f\\", (($MemTotal - $MemAvail) / $MemTotal) * 100}")
    else
      MEM="0"
    fi

    CPU_LINE=$(head -n 1 /proc/stat)
    IDLE1=$(echo $CPU_LINE | awk '{print $5}')
    TOTAL1=$(echo $CPU_LINE | awk '{for(i=2;i<=NF;i++) sum+=$i; print sum}')
    
    sleep 0.2
    
    CPU_LINE2=$(head -n 1 /proc/stat)
    IDLE2=$(echo $CPU_LINE2 | awk '{print $5}')
    TOTAL2=$(echo $CPU_LINE2 | awk '{for(i=2;i<=NF;i++) sum+=$i; print sum}')
    
    if [ -n "$TOTAL1" ] && [ -n "$TOTAL2" ] && [ "$TOTAL2" -gt "$TOTAL1" ]; then
      CPU=$(awk "BEGIN {printf \\"%.1f\\", 100 * (1 - ($IDLE2 - $IDLE1) / ($TOTAL2 - $TOTAL1))}")
    else
      CPU="0"
    fi

    echo "$CPU|$MEM"
  `;
  try {
    const rawOutput = await resolveClient(args, (client) =>
      execSimple(client, cmd, timeout)
    ) as string;
    const parts = rawOutput.trim().split("|");
    return {
      cpu: parseFloat(parts[0]) || 0,
      mem: parseFloat(parts[1]) || 0,
      time: Date.now()
    };
  } catch (err) {
    return { cpu: 0, mem: 0, time: Date.now(), error: true };
  }
}

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
  const delimiter = "---SYSINFODELIM---";
  
  const cmd = [
    "uname -a",
    "cat /proc/cpuinfo | grep 'model name' | head -1 | cut -d: -f2",
    "nproc",
    "free -h | grep -i -E 'mem|内存' || free -h",
    "free -h | grep -i -E 'swap|交换' || true",
    "df -h / | tail -1",
    "uptime -p 2>/dev/null || uptime",
    "cat /proc/loadavg 2>/dev/null || echo ''",
    "uname -r",
    "uname -m"
  ].join(`; echo "${delimiter}"; `);

  try {
    const rawOutput = await resolveClient(args, (client) =>
      execSimple(client, cmd, timeout)
    ) as string;

    const parts = rawOutput.split(new RegExp(`\\r?\\n?${delimiter}\\r?\\n?`));
    const result = Array.from({ length: 10 }, (_, i) => parts[i] || "");

    const [uname, cpuModel, cpuCores, memory, swap, disk, uptime, loadavg, kernel, arch] = result;
    const memMatch = memory.match(/(?:Mem|内存):\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i);
    const swapMatch = swap.match(/(?:Swap|交换):\s+(\S+)\s+(\S+)\s+(\S+)/i);
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
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `Failed to load system info: ${err.message}` }], isError: true };
  }
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
