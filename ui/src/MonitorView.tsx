import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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

  const latestStats = statsHistory[statsHistory.length - 1] ?? { cpu: 0, mem: 0, time: "--:--:--" };
  const topProcess = processes[0];
  const sysRows = sysinfo
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const idx = line.indexOf(":");
      if (idx === -1) return { label: t("monitorInfo"), value: line };
      return { label: line.slice(0, idx), value: line.slice(idx + 1).trim() };
    });

  const loadMonitorData = async () => {
    setLoading(true);
    try {
      const sysRes = await fetch(`${API_BASE}/api/sessions/${sessionId}/sysinfo`);
      const sysData = await sysRes.json();
      if (sysData.content && sysData.content[0]) {
        setSysinfo(sysData.content[0].text);
      }

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
        const timeStr = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;

        setStatsHistory(prev => {
          const next = [...prev, { time: timeStr, cpu: data.cpu, mem: data.mem }];
          if (next.length > 20) return next.slice(next.length - 20);
          return next;
        });
      }
    } catch (e) {
      console.error("Failed to load live stats", e);
    }
  };

  useEffect(() => {
    loadMonitorData();
    const timer = setInterval(loadMonitorData, 10000);

    const initialHistory: StatPoint[] = [];
    const now = new Date();
    for (let i = 19; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 2000);
      initialHistory.push({
        time: `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`,
        cpu: 0,
        mem: 0
      });
    }
    setStatsHistory(initialHistory);

    loadLiveStats();
    const statsTimer = setInterval(loadLiveStats, 1000);

    return () => {
      clearInterval(timer);
      clearInterval(statsTimer);
    };
  }, [sessionId]);

  return (
    <div className="monitor-page">
      <div className="monitor-hero">
        <div>
          <div className="monitor-kicker">{t("monitorKicker")}</div>
          <h2>{t("monitorTitle")}</h2>
          <p>{t("monitorDesc")}</p>
        </div>
        <div className="monitor-stat-strip">
          <div className="monitor-stat-card">
            <span>{t("monitorCpu")}</span>
            <strong>{latestStats.cpu.toFixed(1)}%</strong>
            <i className="monitor-dot monitor-dot-cpu" />
          </div>
          <div className="monitor-stat-card">
            <span>{t("monitorMemory")}</span>
            <strong>{latestStats.mem.toFixed(1)}%</strong>
            <i className="monitor-dot monitor-dot-mem" />
          </div>
          <div className="monitor-stat-card monitor-stat-card-wide">
            <span>{t("monitorTopProcess")}</span>
            <strong title={topProcess?.command}>{topProcess ? topProcess.command : t("monitorWaitingData")}</strong>
          </div>
        </div>
      </div>

      <section className="monitor-chart-card">
        <div className="monitor-card-header">
          <div>
            <h3>{t("monitorRealtimeResources")}</h3>
            <p>{t("monitorLastSample")} {latestStats.time}</p>
          </div>
          <div className="monitor-legend">
            <span><i className="monitor-dot monitor-dot-cpu" /> {t("monitorCpu")}</span>
            <span><i className="monitor-dot monitor-dot-mem" /> {t("monitorMemory")}</span>
          </div>
        </div>
        <div className="monitor-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={statsHistory} margin={{ top: 12, right: 24, left: -12, bottom: 4 }}>
              <CartesianGrid strokeDasharray="4 8" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="time" stroke="hsl(var(--muted-foreground))" fontSize={11} tickMargin={10} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={11} axisLine={false} tickLine={false} width={34} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  boxShadow: "0 18px 40px rgba(15, 23, 42, 0.12)"
                }}
              />
              <Line type="monotone" dataKey="cpu" stroke="#ef4444" strokeWidth={2.5} dot={false} isAnimationActive animationDuration={850} animationEasing="ease-out" name={`${t("monitorCpu")} %`} />
              <Line type="monotone" dataKey="mem" stroke="#2563eb" strokeWidth={2.5} dot={false} isAnimationActive animationDuration={850} animationEasing="ease-out" name={`${t("monitorMemory")} %`} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="monitor-grid">
        <section className="monitor-panel">
          <div className="monitor-card-header">
            <div>
              <h3>{t("sysLoad")}</h3>
              <p>{t("monitorSysSnapshot")}</p>
            </div>
          </div>
          <div className="monitor-sysinfo">
            {loading && !sysinfo ? (
              <div className="monitor-empty">{t("monitorLoadingDiagnostics")}</div>
            ) : (
              sysRows.map((row, idx) => (
                <div className="monitor-sysrow" key={`${row.label}-${idx}`}>
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="monitor-panel">
          <div className="monitor-card-header">
            <div>
              <h3>{t("processes")}</h3>
              <p>{t("monitorProcessesHint")}</p>
            </div>
          </div>
          <div className="monitor-table-wrap">
            <table className="monitor-table">
              <thead>
                <tr>
                  <th>PID</th>
                  <th>CPU</th>
                  <th>MEM</th>
                  <th>{t("monitorCommand")}</th>
                </tr>
              </thead>
              <tbody>
                {processes.map((proc, idx) => (
                  <tr key={idx}>
                    <td>{proc.pid}</td>
                    <td><span className="monitor-cpu">{proc.cpu}%</span></td>
                    <td><span className="monitor-mem">{proc.mem}%</span></td>
                    <td title={proc.command}>{proc.command}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
