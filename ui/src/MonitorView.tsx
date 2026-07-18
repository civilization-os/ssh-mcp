import { useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { translations } from "./i18n";
import type { Language } from "./i18n";

interface MonitorViewProps {
  sessionId: string;
  lang: Language;
}

interface ProcessInfo {
  pid: number;
  cpu: string;
  mem: string;
  command: string;
}

interface StatPoint {
  time: string;
  cpu: number;
  mem: number;
}

const API_BASE = "";

export function MonitorView({ sessionId, lang }: MonitorViewProps) {
  const [sysinfo, setSysinfo] = useState("");
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [statsHistory, setStatsHistory] = useState<StatPoint[]>([]);

  const t = (key: keyof typeof translations["en"]): string => {
    return translations[lang][key] || translations["en"][key] || "";
  };

  const loadMonitorData = async () => {
    setLoading(true);
    try {
      // Load sysinfo
      const sysRes = await fetch(`${API_BASE}/api/sessions/${sessionId}/sysinfo`);
      const sysData = await sysRes.json();
      if (sysData.content && sysData.content[0]) {
        setSysinfo(sysData.content[0].text);
      }

      // Load processes
      const procRes = await fetch(`${API_BASE}/api/sessions/${sessionId}/processes?limit=15`);
      const procData = await procRes.json();
      if (procData.content && procData.content[0]) {
        const lines = procData.content[0].text.trim().split("\n");
        const list: ProcessInfo[] = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].trim().split(/\s+/);
          if (cols.length >= 11) {
            list.push({
              pid: parseInt(cols[1], 10) || 0,
              cpu: cols[2],
              mem: cols[3],
              command: cols.slice(10).join(" ")
            });
          } else if (cols.length >= 4) {
            list.push({
              pid: parseInt(cols[0], 10) || 0,
              cpu: cols[1],
              mem: cols[2],
              command: cols.slice(3).join(" ")
            });
          }
        }
        setProcesses(list);
      }
    } catch (e) {
      console.error("Failed to load monitor data:", e);
    } finally {
      setLoading(false);
    }
  };

  const loadLiveStats = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/stats`);
      const data = await res.json();
      if (!data.error) {
        const date = new Date(data.time);
        const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
        
        setStatsHistory(prev => {
          const next = [...prev, { time: timeStr, cpu: data.cpu, mem: data.mem }];
          if (next.length > 20) return next.slice(next.length - 20); // keep last 20 points
          return next;
        });
      }
    } catch (e) {
      console.error("Failed to load live stats", e);
    }
  };

  useEffect(() => {
    loadMonitorData();
    const timer = setInterval(loadMonitorData, 10000); // 10s for heavy commands
    
    // Fill initial 20 points with 0 to prevent jumping layout
    const initialHistory = [];
    const now = new Date();
    for (let i = 19; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 2000);
      initialHistory.push({
        time: `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`,
        cpu: 0,
        mem: 0
      });
    }
    setStatsHistory(initialHistory);

    // fast polling for chart
    loadLiveStats();
    const statsTimer = setInterval(loadLiveStats, 2000);

    return () => {
      clearInterval(timer);
      clearInterval(statsTimer);
    };
  }, [sessionId]);

  return (
    <div style={{ padding: "16px", display: "flex", flexDirection: "column", height: "100%", width: "100%", boxSizing: "border-box", overflow: "hidden", gap: "16px", backgroundColor: "hsl(var(--card))" }}>
      <div style={{ display: "flex", gap: "16px", height: "35%", minHeight: "200px" }}>
        {/* Chart */}
        <div style={{ flex: 1, border: "1px solid hsl(var(--border))", borderRadius: "6px", padding: "12px", display: "flex", flexDirection: "column", backgroundColor: "rgba(0,0,0,0.2)" }}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px", color: "hsl(var(--foreground))" }}>
            实时资源监控 (CPU/内存)
          </h3>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={statsHistory} margin={{ top: 5, right: 20, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="time" stroke="hsl(var(--muted-foreground))" fontSize={11} tickMargin={5} />
                <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: "6px" }} />
                <Line type="monotone" dataKey="cpu" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} name="CPU %" />
                <Line type="monotone" dataKey="mem" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} name="Mem %" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "16px", flex: 1, overflow: "hidden" }}>
        {/* Left: Sysinfo Text Panel */}
        <div style={{ flex: 1, padding: "12px", display: "flex", flexDirection: "column", border: "1px solid hsl(var(--border))", borderRadius: "6px" }}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px", color: "hsl(var(--foreground))" }}>
            {t("sysLoad")}
          </h3>
          <div style={{ flex: 1, background: "rgba(0,0,0,0.2)", borderRadius: "6px", padding: "12px", fontFamily: "monospace", fontSize: "12px", whiteSpace: "pre-wrap", overflowY: "auto" }}>
            {loading && !sysinfo ? "Loading diagnostics..." : sysinfo}
          </div>
        </div>

        {/* Right: Active processes table */}
        <div style={{ flex: 1, padding: "12px", display: "flex", flexDirection: "column", border: "1px solid hsl(var(--border))", borderRadius: "6px" }}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px", color: "hsl(var(--foreground))" }}>
            {t("processes")}
          </h3>
          <div style={{ flex: 1, overflowY: "auto", background: "rgba(0,0,0,0.2)", borderRadius: "6px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
              <thead style={{ position: "sticky", top: 0, backgroundColor: "hsl(var(--card))", zIndex: 10 }}>
                <tr style={{ borderBottom: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
                  <th style={{ padding: "6px" }}>PID</th>
                  <th style={{ padding: "6px" }}>CPU%</th>
                  <th style={{ padding: "6px" }}>MEM%</th>
                  <th style={{ padding: "6px" }}>Command</th>
                </tr>
              </thead>
              <tbody>
                {processes.map((proc, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid hsl(var(--border))" }}>
                    <td style={{ padding: "6px", fontFamily: "monospace" }}>{proc.pid}</td>
                    <td style={{ padding: "6px", color: "hsl(var(--foreground))", fontWeight: 600 }}>{proc.cpu}%</td>
                    <td style={{ padding: "6px", color: "hsl(var(--muted-foreground))" }}>{proc.mem}%</td>
                    <td style={{ padding: "6px", fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "160px" }} title={proc.command}>
                      {proc.command}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
