import { useEffect, useState, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { translations } from "./i18n";
import type { Language } from "./i18n";

interface SshSession {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  createdAt?: number;
  lastUsedAt?: number;
  idleTimeoutMs?: number;
  authType?: "password" | "privateKey";
  hasPassword?: boolean;
  hasPrivateKey?: boolean;
  connected?: boolean;
}

interface ShellSession {
  id: string;
  sessionId: string;
  closed: boolean;
  age: number;
  keepAlive?: boolean;
}

interface SftpFile {
  name: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mode: string;
  mtime: number;
  linkTarget?: string;
}

const API_BASE = "";
const WS_BASE =
  typeof window === "undefined"
    ? "ws://127.0.0.1:12222"
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;



function SessionItem({ 
  sess, 
  isSelected, 
  onSelect, 
  onEdit, 
  onDelete, 
  lang,
  pingMs 
}: { 
  sess: SshSession; 
  isSelected: boolean; 
  onSelect: () => void; 
  onEdit: () => void; 
  onDelete: () => void;
  lang: Language;
  pingMs?: number | null;
}) {
  return (
    <div
      onClick={onSelect}
      className="shadcn-card"
      style={{
        padding: "12px",
        marginBottom: "8px",
        cursor: "pointer",
        backgroundColor: isSelected ? "hsl(var(--accent))" : "transparent",
        borderColor: isSelected ? "hsl(var(--ring))" : "hsl(var(--border))",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px" }}>
        <span style={{ fontWeight: 600, fontSize: "14px", color: isSelected ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))" }}>
          {sess.label}
        </span>
        <div style={{ display: "flex", gap: "4px" }}>
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="shadcn-btn shadcn-btn-ghost"
            style={{ padding: "4px", height: "auto", minHeight: 0, fontSize: "12px" }}
          >
            ✎
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="shadcn-btn shadcn-btn-ghost"
            style={{ padding: "4px", height: "auto", minHeight: 0, fontSize: "12px" }}
          >
            ✕
          </button>
        </div>
      </div>
      <div style={{ fontSize: "11px", color: "hsl(var(--muted-foreground))" }}>
        {sess.username}@{sess.host}
      </div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
        <span className="shadcn-badge">{sess.authType === "privateKey" ? translations[lang].authPrivateKeySaved : translations[lang].authPasswordSaved}</span>
      </div>
      <div style={{ 
        fontSize: "10px", 
        marginTop: "8px", 
        color: "hsl(var(--foreground))",
        display: "flex",
        alignItems: "center",
        gap: "6px"
      }} title={sess.connected ? translations[lang].heartbeatTooltip : (lang === "zh" ? "连接已断开，需要重新编辑输入密码/密钥重新连接" : "Connection disconnected, needs credentials to reconnect")}>
        <span className={sess.connected ? "pulse-glow" : ""} style={{ 
          width: "6px", 
          height: "6px", 
          borderRadius: "50%", 
          background: sess.connected ? "#22c55e" : "hsl(var(--destructive))",
          display: "inline-block"
        }} />
        <span style={{ fontWeight: 500, color: sess.connected ? "hsl(var(--foreground))" : "hsl(var(--destructive))" }}>
          {sess.connected ? translations[lang].heartbeatActive + (pingMs != null ? ` (${pingMs}ms)` : "") : (lang === "zh" ? "已断开" : "Disconnected")}
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const [sessions, setSessions] = useState<SshSession[]>([]);
  const [shells, setShells] = useState<ShellSession[]>([]);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [serverVersion, setServerVersion] = useState<string>("2.1.0");
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [activeShellId, setActiveShellId] = useState<string>("");
  
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  
  // Navigation Tabs
  const [activeTab, setActiveTab] = useState<"terminal" | "sftp" | "monitor">("terminal");
  
  // Modal & Form States
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string>("");
  const [initialAuthMethod, setInitialAuthMethod] = useState<"password" | "privateKey">("password");
  const [sessionNameInput, setSessionNameInput] = useState("");
  const [hostInput, setHostInput] = useState("");
  const [portInput, setPortInput] = useState("22");
  const [usernameInput, setUsernameInput] = useState("root");
  const [authMethodInput, setAuthMethodInput] = useState<"password" | "privateKey">("password");
  const [passwordInput, setPasswordInput] = useState("");
  const [privateKeyInput, setPrivateKeyInput] = useState("");
  const [connectLoading, setConnectLoading] = useState(false);
  const [connectError, setConnectError] = useState("");

  // Confirm delete modal
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; label: string } | null>(null);

  const [lang, setLang] = useState<Language>(() => {
    return navigator.language.startsWith("zh") ? "zh" : "en";
  });
  
  const t = (key: keyof typeof translations["en"]): string => {
    return translations[lang][key] || translations["en"][key] || "";
  };

  const resetSessionForm = () => {
    setEditingSessionId("");
    setInitialAuthMethod("password");
    setSessionNameInput("");
    setHostInput("");
    setPortInput("22");
    setUsernameInput("root");
    setAuthMethodInput("password");
    setPasswordInput("");
    setPrivateKeyInput("");
    setConnectError("");
  };

  const openCreateModal = () => {
    resetSessionForm();
    setShowCreateModal(true);
  };

  const openEditModal = (session: SshSession) => {
    setEditingSessionId(session.id);
    setInitialAuthMethod(session.authType === "privateKey" ? "privateKey" : "password");
    setSessionNameInput(session.label);
    setHostInput(session.host);
    setPortInput(String(session.port));
    setUsernameInput(session.username);
    setAuthMethodInput(session.authType === "privateKey" ? "privateKey" : "password");
    setPasswordInput("");
    setPrivateKeyInput("");
    setConnectError("");
    setShowCreateModal(true);
  };

  // Polling for sessions and shells
  useEffect(() => {
    const fetchData = async () => {
      try {
        const start = performance.now();
        const sRes = await fetch(`${API_BASE}/api/sessions`);
        const sData = await sRes.json();
        const latency = Math.round(performance.now() - start);
        setPingMs(latency);
        setSessions(sData);

        const vRes = await fetch(`${API_BASE}/api/version`).catch(() => null);
        if (vRes?.ok) {
          const vData = await vRes.json();
          if (vData.version) setServerVersion(vData.version);
        }

        const shRes = await fetch(`${API_BASE}/api/shells`);
        const shData = await shRes.json();
        setShells(shData);

        if (sData.length > 0 && !selectedSessionId) {
          setSelectedSessionId(sData[0].id);
        }
      } catch (err) {
        console.error("Error fetching sessions/shells:", err);
      }
    };

    fetchData();
    const timer = setInterval(fetchData, 3000);
    return () => clearInterval(timer);
  }, [selectedSessionId]);

  const handleOpenShell = async () => {
    if (!selectedSessionId) return;
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${selectedSessionId}/shells`, {
        method: "POST"
      });
      const data = await res.json();
      if (data.content && data.content[0]) {
        const text = data.content[0].text;
        const match = text.match(/Interactive shell created: (\S+)/);
        if (match) {
          const newShellId = match[1];
          setActiveShellId(newShellId);
          setActiveTab("terminal");
        }
      }
    } catch (err) {
      console.error("Failed to open shell:", err);
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnectLoading(true);
    setConnectError("");
    try {
      const isEditing = Boolean(editingSessionId);
      const payload: any = {
        name: sessionNameInput || `${usernameInput}@${hostInput}:${portInput}`,
        host: hostInput,
        port: parseInt(portInput, 10) || 22,
        username: usernameInput,
      };
      if (authMethodInput === "password") {
        if (!isEditing || authMethodInput !== initialAuthMethod || passwordInput) {
          payload.password = passwordInput;
        }
      } else {
        if (!isEditing || authMethodInput !== initialAuthMethod || privateKeyInput) {
          payload.privateKey = privateKeyInput;
        }
      }

      if (isEditing && authMethodInput !== initialAuthMethod) {
        const switchedWithoutSecret = authMethodInput === "password" ? !passwordInput : !privateKeyInput;
        if (switchedWithoutSecret) {
          throw new Error(t("keepCurrentSecret"));
        }
      }

      const res = await fetch(
        isEditing ? `${API_BASE}/api/sessions/${editingSessionId}` : `${API_BASE}/api/sessions`,
        {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP error ${res.status}`);
      }

      const data = await res.json();
      setShowCreateModal(false);
      resetSessionForm();
      setSelectedSessionId(data.id);
    } catch (err: any) {
      console.error(err);
      setConnectError(err.message || "Connection failed");
    } finally {
      setConnectLoading(false);
    }
  };

  // Actually execute delete after user confirmed
  const handleConfirmDelete = async () => {
    if (!confirmTarget) return;
    const { id } = confirmTarget;
    setConfirmTarget(null);
    try {
      await fetch(`${API_BASE}/api/sessions/${id}`, { method: "DELETE" });
      setSessions(prev => prev.filter(s => s.id !== id));
      setShells(prev => prev.filter(s => s.sessionId !== id));
      if (selectedSessionId === id) {
        setSelectedSessionId("");
        setActiveShellId("");
      }
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  };

  const handleCloseShell = async (shellId: string) => {
    try {
      await fetch(`${API_BASE}/api/shells/${shellId}`, { method: "DELETE" });
      setShells(prev => prev.filter(s => s.id !== shellId));
      if (activeShellId === shellId) {
        setActiveShellId("");
      }
    } catch (err) {
      console.error("Failed to close shell:", err);
    }
  };

  const filteredShells = shells.filter(s => s.sessionId === selectedSessionId);

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw", overflow: "hidden", backgroundColor: "hsl(var(--background))" }}>
      {/* Sidebar */}
      <div 
        style={{ 
          width: sidebarCollapsed ? "68px" : "300px", 
          minWidth: sidebarCollapsed ? "68px" : "300px", 
          borderRight: "1px solid hsl(var(--border))", 
          backgroundColor: "hsl(var(--card))",
          display: "flex", 
          flexDirection: "column", 
          height: "100%", 
          overflow: "hidden",
          transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
        }}
      >
        
        {/* Title Bar / Collapse Button */}
        <div style={{ 
          padding: sidebarCollapsed ? "18px 0" : "24px 20px", 
          borderBottom: "1px solid hsl(var(--border))", 
          display: "flex", 
          alignItems: "center", 
          justifyContent: "center",
          height: "80px",
          boxSizing: "border-box",
          position: "relative",
          width: "100%",
          flexShrink: 0
        }}>
          {/* Inner Title Container */}
          <div style={{
            position: "absolute",
            left: "20px",
            width: "180px",
            display: "flex",
            flexDirection: "column",
            opacity: sidebarCollapsed ? 0 : 1,
            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            pointerEvents: sidebarCollapsed ? "none" : "auto",
            overflow: "hidden",
            whiteSpace: "nowrap"
          }}>
            <h1 style={{ fontSize: "16px", margin: 0, fontWeight: 700, letterSpacing: "-0.02em", color: "hsl(var(--foreground))" }}>
              {t("title")}
            </h1>
            <p style={{ fontSize: "11px", color: "hsl(var(--muted-foreground))", marginTop: "4px" }}>
              {t("subtitle")}
            </p>
          </div>

          {/* Buttons Container */}
          <div style={{
            position: "absolute",
            right: sidebarCollapsed ? "16px" : "20px",
            display: "flex",
            gap: "6px",
            alignItems: "center",
            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
          }}>
            {!sidebarCollapsed && (
              <button
                onClick={() => setLang(lang === "zh" ? "en" : "zh")}
                className="shadcn-btn shadcn-btn-outline"
                style={{
                  padding: "4px 8px",
                  fontSize: "11px",
                }}
              >
                {t("langToggle")}
              </button>
            )}
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="shadcn-btn shadcn-btn-ghost"
              style={{
                width: "36px",
                height: "36px",
                padding: 0,
                fontSize: "12px"
              }}
              title={sidebarCollapsed ? (lang === "zh" ? "展开菜单" : "Expand Menu") : (lang === "zh" ? "收起菜单" : "Collapse Menu")}
            >
              {sidebarCollapsed ? "▶" : "◀"}
            </button>
          </div>
        </div>

        {/* Tab Selection - Upgraded */}
        {selectedSessionId && (
          <div style={{ 
            padding: "8px 0", 
            borderBottom: "1px solid hsl(var(--border))", 
            display: "flex", 
            flexDirection: "column", 
            gap: "2px",
            alignItems: "center",
            width: "100%",
            position: "relative",
            flexShrink: 0
          }}>
            {[
              { id: "terminal", icon: "💻", label: t("tabTerminal") },
              { id: "sftp",     icon: "📂", label: t("tabSftp") },
              { id: "monitor",  icon: "📊", label: t("tabMonitor") }
            ].map(tab => {
              const isActive = activeTab === tab.id;
              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  title={sidebarCollapsed ? tab.label : undefined}
                  className="shadcn-btn"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "8px 12px",
                    width: sidebarCollapsed ? "40px" : "260px",
                    height: "36px",
                    borderRadius: "0px",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: isActive ? 600 : 500,
                    position: "relative",
                    backgroundColor: "transparent",
                    color: isActive ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))",
                    border: "none",
                    borderBottom: isActive ? "2px solid hsl(var(--primary))" : "none",
                    justifyContent: "flex-start",
                    overflow: "hidden",
                    whiteSpace: "nowrap"
                  }}
                  onMouseEnter={e => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "hsl(var(--accent) / 0.5)";
                      e.currentTarget.style.color = "hsl(var(--foreground))";
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = "hsl(var(--muted-foreground))";
                    }
                  }}
                >
                  <div style={{ 
                    display: "flex", 
                    alignItems: "center", 
                    justifyContent: "center",
                    width: "16px",
                    flexShrink: 0,
                  }}>
                    <span style={{ fontSize: "14px" }}>{tab.icon}</span>
                  </div>
                  
                  {/* Text Label */}
                  <span style={{ 
                    position: "absolute",
                    left: "38px",
                    opacity: sidebarCollapsed ? 0 : 1,
                    transition: "opacity 0.2s ease",
                    pointerEvents: sidebarCollapsed ? "none" : "auto",
                    whiteSpace: "nowrap"
                  }}>
                    {tab.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Sessions Section */}
        <div style={{ 
          flex: 1, 
          overflow: "hidden", 
          opacity: sidebarCollapsed ? 0 : 1,
          width: sidebarCollapsed ? "0px" : "300px",
          transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
          pointerEvents: sidebarCollapsed ? "none" : "auto"
        }}>
          <div style={{ width: "300px", padding: "16px 12px", height: "100%", overflowY: "auto", boxSizing: "border-box" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", paddingLeft: "8px" }}>
            <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "hsl(var(--muted-foreground))", letterSpacing: "1.5px" }}>
              {t("sessionsTitle")} ({sessions.length})
            </div>
            <button
              onClick={openCreateModal}
              className="shadcn-btn shadcn-btn-outline"
              style={{
                width: "24px",
                height: "24px",
                padding: 0,
                fontSize: "12px",
              }}
              title={t("connectNewSession")}
            >
              +
            </button>
          </div>
          
          {sessions.length === 0 ? (
            <div style={{ padding: "16px 8px", fontSize: "13px", color: "var(--text-secondary)", textAlign: "center" }}>
              {t("noSessions")}
            </div>
          ) : (
            sessions.map((sess) => (
              <SessionItem
                key={sess.id}
                sess={sess}
                isSelected={selectedSessionId === sess.id}
                lang={lang}
                pingMs={pingMs}
                onSelect={() => {
                  setSelectedSessionId(sess.id);
                  if (activeShellId && shells.find(s => s.id === activeShellId)?.sessionId !== sess.id) {
                    setActiveShellId("");
                  }
                }}
                onEdit={() => {
                  setEditingSessionId(sess.id);
                  setSessionNameInput(sess.label);
                  setHostInput(sess.host);
                  setPortInput(String(sess.port));
                  setUsernameInput(sess.username);
                  setInitialAuthMethod(sess.authType || "password");
                  setAuthMethodInput(sess.authType || "password");
                  setShowCreateModal(true);
                }}
                onDelete={() => setConfirmTarget({ id: sess.id, label: sess.label })}
              />
            ))
          )}

          {/* Terminals list when Terminal Tab is active */}
          {selectedSessionId && activeTab === "terminal" && (
            <div style={{ marginTop: "24px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", paddingLeft: "8px" }}>
                <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "hsl(var(--muted-foreground))", letterSpacing: "1px" }}>
                  {t("terminalsTitle")}
                </div>
                <button
                  className="shadcn-btn shadcn-btn-outline"
                  onClick={handleOpenShell}
                  style={{
                    padding: "4px 8px",
                    fontSize: "11px",
                  }}
                >
                  {t("newBtn")}
                </button>
              </div>

              {filteredShells.length === 0 ? (
                <div style={{ padding: "12px 8px", fontSize: "12px", color: "hsl(var(--muted-foreground))", textAlign: "center" }}>
                  {t("noTerminals")}
                </div>
              ) : (
                filteredShells.map((sh) => (
                  <div
                    key={sh.id}
                    onClick={() => setActiveShellId(sh.id)}
                    className="shadcn-card"
                    style={{
                      padding: "10px 12px",
                      marginBottom: "6px",
                      cursor: "pointer",
                      backgroundColor: activeShellId === sh.id ? "hsl(var(--accent))" : "transparent",
                      borderColor: activeShellId === sh.id ? "hsl(var(--ring))" : "hsl(var(--border))",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center"
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: sh.closed ? "hsl(var(--destructive))" : "#22c55e" }} />
                      <span style={{ fontSize: "13px", color: activeShellId === sh.id ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))" }}>
                        {sh.id.substring(3, 11)}...
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      {sh.keepAlive && (
                        <span 
                          title={lang === "zh" ? "已开启心跳维持" : "Keep-alive enabled"}
                          style={{ fontSize: "10px", color: "#22c55e", opacity: 0.8 }}
                        >
                          💓
                        </span>
                      )}
                      <span style={{ fontSize: "10px", color: "hsl(var(--muted-foreground))" }}>{sh.age}s</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCloseShell(sh.id); }}
                        title="关闭此终端"
                        className="shadcn-btn shadcn-btn-ghost"
                        style={{
                          padding: "2px 4px",
                          fontSize: "12px",
                          lineHeight: 1,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Version Footer inside scrollable area */}
          <div style={{ 
            marginTop: "24px",
            paddingTop: "12px",
            borderTop: "1px solid hsl(var(--border))",
            fontSize: "11px",
            color: "hsl(var(--muted-foreground))",
            textAlign: "center",
            fontFamily: "monospace"
          }}>
            ssh-mcp v{serverVersion}
          </div>
          </div>
        </div>
      </div>

      {/* Main Panel */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {!selectedSessionId ? (
          <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
            <div className="shadcn-card" style={{ padding: "40px", maxWidth: "480px", textAlign: "center", margin: "20px" }}>
              <div style={{ fontSize: "48px", marginBottom: "16px" }}>📡</div>
              <h2 style={{ color: "hsl(var(--foreground))", fontWeight: 600, fontSize: "18px", marginBottom: "8px" }}>
                {t("emptyStateTitle")}
              </h2>
              <p style={{ color: "hsl(var(--muted-foreground))", fontSize: "13px", lineHeight: "1.5", marginBottom: "24px" }}>
                {t("emptyStateDesc")}
              </p>
              <button
                className="shadcn-btn shadcn-btn-primary"
                onClick={openCreateModal}
                style={{ padding: "10px 24px" }}
              >
                {t("connectNewSession")}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            <SelectedSessionView
              session={sessions.find((s) => s.id === selectedSessionId) ?? null}
              lang={lang}
              onEdit={openEditModal}
            />
            {activeTab === "terminal" && (
              activeShellId ? (
                <XtermView shellId={activeShellId} key={activeShellId} lang={lang} />
              ) : (
                <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
                  <div className="shadcn-card" style={{ padding: "40px", maxWidth: "480px", textAlign: "center", margin: "20px" }}>
                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>💻</div>
                    <h2 style={{ color: "hsl(var(--foreground))", fontWeight: 600, fontSize: "18px", marginBottom: "8px" }}>
                      {t("welcomeTitle")}
                    </h2>
                    <p style={{ color: "hsl(var(--muted-foreground))", fontSize: "13px", lineHeight: "1.5" }}>
                      {t("welcomeDesc")}
                    </p>
                    <button className="shadcn-btn shadcn-btn-primary" onClick={handleOpenShell} style={{ marginTop: "20px", padding: "10px 24px" }}>
                      {t("newBtn")}
                    </button>
                  </div>
                </div>
              )
            )}

            {activeTab === "sftp" && (
              <SftpView sessionId={selectedSessionId} lang={lang} />
            )}

            {activeTab === "monitor" && (
              <MonitorView sessionId={selectedSessionId} lang={lang} />
            )}
          </div>
        )}
      </div>

      {/* ===== Confirm Delete Modal ===== */}
      {confirmTarget && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          background: "rgba(0,0,0,0.75)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1100,
        }}>
          <div className="shadcn-card" style={{
            width: "420px",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}>
            {/* Icon + Title */}
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{
                width: "40px",
                height: "40px",
                borderRadius: "50%",
                background: "hsl(var(--destructive) / 0.1)",
                border: "1px solid hsl(var(--destructive) / 0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "18px",
                flexShrink: 0,
              }}>⚠️</div>
              <div>
                <div style={{ fontSize: "16px", fontWeight: 600, color: "hsl(var(--foreground))" }}>
                  {t("confirmDeleteTitle")}
                </div>
                <div style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))" }}>
                  {t("confirmDeleteHint")}
                </div>
              </div>
            </div>

            {/* Session name highlight */}
            <div className="shadcn-card" style={{
              background: "hsl(var(--destructive) / 0.05)",
              borderColor: "hsl(var(--destructive) / 0.2)",
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}>
              <span style={{ fontSize: "16px" }}>🖥️</span>
              <div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "hsl(var(--foreground))" }}>
                  {confirmTarget.label}
                </div>
                <div style={{ fontSize: "10px", color: "hsl(var(--muted-foreground))", marginTop: "2px" }}>
                  ID: {confirmTarget.id}
                </div>
              </div>
            </div>

            {/* Buttons */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                onClick={() => setConfirmTarget(null)}
                className="shadcn-btn shadcn-btn-outline"
                style={{ padding: "8px 16px" }}
              >
                {t("cancelBtn")}
              </button>
              <button
                onClick={handleConfirmDelete}
                className="shadcn-btn shadcn-btn-destructive"
                style={{ padding: "8px 18px" }}
              >
                {t("confirmDeleteBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit Connection Modal */}
      {showCreateModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          background: "rgba(0,0,0,0.75)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
        }}>
          <form onSubmit={handleConnect} className="shadcn-card" style={{
            width: "480px",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}>
            <h3 style={{ fontSize: "16px", fontWeight: 600, margin: 0, color: "hsl(var(--foreground))" }}>
              {editingSessionId ? t("editSession") : t("connectNewSession")}
            </h3>

            {connectError && (
              <div style={{
                background: "hsl(var(--destructive) / 0.1)",
                border: "1px solid hsl(var(--destructive) / 0.3)",
                color: "hsl(var(--foreground))",
                borderRadius: "6px",
                padding: "10px 12px",
                fontSize: "13px",
                lineHeight: "1.4",
              }}>
                <strong>{t("connectFailed")}:</strong> {connectError}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))" }}>{t("sessionName")}</label>
              <input
                type="text"
                placeholder="e.g. Production Web Server"
                value={sessionNameInput}
                onChange={e => setSessionNameInput(e.target.value)}
                className="shadcn-input"
              />
            </div>

            <div style={{ display: "flex", gap: "12px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1 }}>
                <label style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))" }}>{t("host")} *</label>
                <input
                  type="text"
                  required
                  placeholder="12.34.56.78"
                  value={hostInput}
                  onChange={e => setHostInput(e.target.value)}
                  className="shadcn-input"
                />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100px" }}>
                <label style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))" }}>{t("port")} *</label>
                <input
                  type="text"
                  required
                  placeholder="22"
                  value={portInput}
                  onChange={e => setPortInput(e.target.value)}
                  className="shadcn-input"
                />
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))" }}>{t("username")} *</label>
              <input
                type="text"
                required
                placeholder="root"
                value={usernameInput}
                onChange={e => setUsernameInput(e.target.value)}
                className="shadcn-input"
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))" }}>{t("authMethod")}</label>
              <div style={{ display: "flex", gap: "12px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    checked={authMethodInput === "password"}
                    onChange={() => setAuthMethodInput("password")}
                  />
                  {t("authPassword")}
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    checked={authMethodInput === "privateKey"}
                    onChange={() => setAuthMethodInput("privateKey")}
                  />
                  {t("authPrivateKey")}
                </label>
              </div>
            </div>

            {authMethodInput === "password" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))" }}>{t("password")} *</label>
                <input
                  type="password"
                  required={!editingSessionId || authMethodInput !== initialAuthMethod}
                  placeholder="••••••••"
                  value={passwordInput}
                  onChange={e => setPasswordInput(e.target.value)}
                  className="shadcn-input"
                />
                {editingSessionId && authMethodInput === initialAuthMethod && (
                  <div style={{ fontSize: "11px", color: "hsl(var(--muted-foreground))" }}>{t("keepCurrentSecret")}</div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))" }}>{t("privateKey")} *</label>
                <textarea
                  required={!editingSessionId || authMethodInput !== initialAuthMethod}
                  rows={5}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  value={privateKeyInput}
                  onChange={e => setPrivateKeyInput(e.target.value)}
                  className="shadcn-input"
                  style={{
                    fontFamily: "monospace",
                    resize: "none",
                  }}
                />
                {editingSessionId && authMethodInput === initialAuthMethod && (
                  <div style={{ fontSize: "11px", color: "hsl(var(--muted-foreground))" }}>{t("keepCurrentSecret")}</div>
                )}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
              <button
                type="button"
                onClick={() => { setShowCreateModal(false); resetSessionForm(); }}
                className="shadcn-btn shadcn-btn-outline"
                style={{ padding: "8px 16px" }}
              >
                {t("cancelBtn")}
              </button>
              <button
                type="submit"
                className="shadcn-btn shadcn-btn-primary"
                disabled={connectLoading}
                style={{ padding: "8px 24px" }}
              >
                {connectLoading ? t("connecting") : editingSessionId ? t("saveSession") : t("connectBtn")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

interface SelectedSessionViewProps {
  session: SshSession | null;
  lang: Language;
  onEdit: (session: SshSession) => void;
}

function SelectedSessionView({ session, lang, onEdit }: SelectedSessionViewProps) {
  const t = (key: keyof typeof translations["en"]): string => {
    return translations[lang][key] || translations["en"][key] || "";
  };

  if (!session) return null;

  const authLabel = session.authType === "privateKey" ? t("authPrivateKeySaved") : t("authPasswordSaved");

  return (
    <div className="shadcn-card" style={{ 
      margin: "12px 12px 0 12px", 
      padding: "10px 16px", 
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "20px",
      borderRadius: "6px",
    }}>
      {/* Session Title & Connection Info */}
      <div style={{ display: "flex", alignItems: "center", gap: "14px", flex: 1, minWidth: 0 }}>
        {/* Status Dot */}
        <div style={{ 
          width: "8px", 
          height: "8px", 
          borderRadius: "50%", 
          background: session.connected ? "#22c55e" : "hsl(var(--destructive))", 
          flexShrink: 0
        }} />
        
        {/* Session Name */}
        <span style={{ fontSize: "14px", fontWeight: 600, color: "hsl(var(--foreground))", flexShrink: 0 }}>
          {session.label}{!session.connected && (lang === "zh" ? " (未连接)" : " (Disconnected)")}
        </span>
        
        <div style={{ width: "1px", height: "16px", background: "hsl(var(--border))", flexShrink: 0 }} />

        {/* Horizontal Info Items */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px", flex: 1, minWidth: 0, overflowX: "auto" }}>
          <InlineInfoItem label={t("hostPort")} value={`${session.username}@${session.host}:${session.port}`} iconType="host" />
          <InlineInfoItem label={t("authStatus")} value={authLabel} iconType="auth" />
        </div>
      </div>

      {/* Edit button */}
      <button
        onClick={() => onEdit(session)}
        className="shadcn-btn shadcn-btn-outline"
        style={{
          padding: "6px 12px",
          fontSize: "12px",
          height: "32px",
        }}
      >
        {t("editSession")}
      </button>
    </div>
  );
}

function InlineInfoItem({ label, value, iconType }: { label: string; value: string; iconType?: 'host' | 'auth' }) {
  const getIcon = () => {
    switch (iconType) {
      case 'host':
        return <span style={{ fontSize: '12px' }}>🖥️</span>;
      case 'auth':
        return <span style={{ fontSize: '12px' }}>🛡️</span>;
      default:
        return null;
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0, fontSize: "12px" }}>
      {getIcon()}
      <span style={{ color: "hsl(var(--muted-foreground))", opacity: 0.8 }}>{label}:</span>
      <span style={{ color: "hsl(var(--foreground))", fontWeight: 500, whiteSpace: "nowrap" }} title={value}>{value}</span>
    </div>
  );
}

// ======== VIEW 1: Xterm PTY View ========

interface XtermViewProps {
  shellId: string;
  lang: Language;
}

function XtermView({ shellId, lang }: XtermViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isHeartbeating, setIsHeartbeating] = useState<boolean>(false);

  const t = (key: keyof typeof translations["en"]): string => {
    return translations[lang][key] || translations["en"][key] || "";
  };

  useEffect(() => {
    if (!containerRef.current) return;
    let hbTimeout: ReturnType<typeof setTimeout> | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      scrollback: 50000,
      theme: {
        background: "#f8fafc",
        foreground: "#0f172a",
        cursor: "#0f172a",
        black: "#0f172a",
        red: "#ef4444",
        green: "#10b981",
        yellow: "#d97706",
        blue: "#2563eb",
        magenta: "#c084fc",
        cyan: "#0891b2",
        white: "#f8fafc",
      }
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    term.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const wsUrl = `${WS_BASE}/ws/shell?shellId=${encodeURIComponent(shellId)}`;
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.onmessage = (event) => { 
      if (typeof event.data === "string" && event.data === "\x01HB") {
        setIsHeartbeating(true);
        if (hbTimeout) clearTimeout(hbTimeout);
        hbTimeout = setTimeout(() => {
          setIsHeartbeating(false);
        }, 1500);
      } else {
        term.write(event.data); 
      }
    };
    socket.onclose = () => { term.write("\r\n\r\n[WebSocket connection disconnected]\r\n"); };
    term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });

    const handleResize = () => { fitAddon.fit(); };
    window.addEventListener("resize", handleResize);

    return () => {
      if (hbTimeout) clearTimeout(hbTimeout);
      window.removeEventListener("resize", handleResize);
      socket.close();
      term.dispose();
    };
  }, [shellId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", backgroundColor: "hsl(var(--background))" }}>
      <div style={{ 
        padding: "10px 20px", 
        display: "flex", 
        justifyContent: "space-between", 
        alignItems: "center", 
        borderBottom: "1px solid hsl(var(--border))", 
        backgroundColor: "hsl(var(--card))" 
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#22c55e" }} />
          <span style={{ fontSize: "13px", fontWeight: 600 }}>{t("activeTerminal")}: {shellId}</span>
          {isHeartbeating && (
            <div style={{ 
              fontSize: "10px", 
              color: "#22c55e", 
              marginLeft: "10px",
              display: "flex",
              alignItems: "center",
              gap: "4px",
              animation: "pulse 1.5s infinite"
            }}>
              <span role="img" aria-label="heartbeat">💓</span> {lang === "zh" ? "心跳" : "Heartbeat"}
            </div>
          )}
        </div>
        <div style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))", display: "flex", alignItems: "center", gap: "15px" }}>
          <button 
            onClick={() => terminalRef.current?.clear()}
            className="shadcn-btn shadcn-btn-outline"
            style={{ 
              padding: "2px 8px",
              fontSize: "11px",
              height: "24px"
            }}
          >
            {t("clear")}
          </button>
          <div>{t("wsConnected")}</div>
        </div>
      </div>
      
      <div style={{ flex: 1, position: "relative", padding: "10px" }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%", position: "absolute", top: 0, left: 0, padding: "12px", boxSizing: "border-box" }} />
      </div>

      <style>{`
        @keyframes pulse {
          0% { opacity: 0.4; transform: scale(0.95); }
          50% { opacity: 1; transform: scale(1); }
          100% { opacity: 0.4; transform: scale(0.95); }
        }
      `}</style>
    </div>
  );
}

// ======== VIEW 2: SFTP Explorer View ========

interface SftpViewProps {
  sessionId: string;
  lang: Language;
}

function SftpView({ sessionId, lang }: SftpViewProps) {
  const [path, setPath] = useState("/");
  const [files, setFiles] = useState<SftpFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SftpFile | null>(null);
  const [status, setStatus] = useState<{ msg: string; type: "success" | "error" | "" }>({
    msg: "",
    type: ""
  });
  const [renameTarget, setRenameTarget] = useState<SftpFile | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [mkdirMode, setMkdirMode] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);

  const t = (key: keyof typeof translations["en"]): string =>
    translations[lang][key] || translations["en"][key] || "";

  const showStatus = (msg: string, type: "success" | "error") => {
    setStatus({ msg, type });
    setTimeout(() => setStatus({ msg: "", type: "" }), 3000);
  };

  const loadFiles = async (targetPath: string) => {
    setLoading(true);
    setSelectedFile(null);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/sftp/list?path=${encodeURIComponent(targetPath)}`);
      const data = await res.json();
      if (!data.isError && data.content && data.content[0]) {
        const parsedFiles = JSON.parse(data.content[0].text);
        // Sort: dirs first, then files, alphabetical
        parsedFiles.sort((a: SftpFile, b: SftpFile) => {
          const rank = (t: string) => t === "dir" ? 0 : t === "symlink" ? 1 : 2;
          if (rank(a.type) !== rank(b.type)) return rank(a.type) - rank(b.type);
          return a.name.localeCompare(b.name);
        });
        setFiles(parsedFiles);
        setPath(targetPath);
      } else {
        showStatus(data.content?.[0]?.text || "Failed to load", "error");
      }
    } catch (e) {
      showStatus("Network error", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadFiles("/"); }, [sessionId]);

  const handleRowClick = (file: SftpFile) => {
    if (file.type === "dir") {
      const slash = path.endsWith("/") ? "" : "/";
      loadFiles(`${path}${slash}${file.name}`);
    } else {
      setSelectedFile(prev => prev?.name === file.name ? null : file);
    }
  };

  const handleBack = () => {
    if (path === "/") return;
    const parentPath = path.substring(0, path.lastIndexOf("/")) || "/";
    loadFiles(parentPath);
  };

  const getFilePath = (name: string) => {
    const slash = path.endsWith("/") ? "" : "/";
    return `${path}${slash}${name}`;
  };

  // Delete file / directory
  const handleDelete = async (file: SftpFile) => {
    if (!confirm(`${t("confirmDeleteTitle")}\n${file.name}`)) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/sessions/${sessionId}/sftp/delete?path=${encodeURIComponent(getFilePath(file.name))}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (data.isError) throw new Error(data.content?.[0]?.text);
      showStatus(`✓ ${t("sftpDeletedOk")}: ${file.name}`, "success");
      loadFiles(path);
    } catch (e: any) {
      showStatus(`✗ ${e.message}`, "error");
    }
  };

  // Rename
  const handleRenameSubmit = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    try {
      const oldPath = getFilePath(renameTarget.name);
      const newPath = getFilePath(renameValue.trim());
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/sftp/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPath, newPath })
      });
      const data = await res.json();
      if (data.isError) throw new Error(data.content?.[0]?.text);
      showStatus(`✓ ${t("sftpRenamedOk")}`, "success");
      setRenameTarget(null);
      loadFiles(path);
    } catch (e: any) {
      showStatus(`✗ ${e.message}`, "error");
    }
  };

  // Mkdir
  const handleMkdir = async () => {
    if (!mkdirName.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/sftp/mkdir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: getFilePath(mkdirName.trim()) })
      });
      const data = await res.json();
      if (data.isError) throw new Error(data.content?.[0]?.text);
      showStatus(`✓ ${t("sftpMkdirOk")}: ${mkdirName}`, "success");
      setMkdirMode(false);
      setMkdirName("");
      loadFiles(path);
    } catch (e: any) {
      showStatus(`✗ ${e.message}`, "error");
    }
  };

  // Download file
  const handleDownload = async (file: SftpFile) => {
    if (file.type !== "file") return;
    try {
      const res = await fetch(
        `${API_BASE}/api/sessions/${sessionId}/sftp/download?path=${encodeURIComponent(getFilePath(file.name))}`
      );
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
      showStatus(`✓ ${t("sftpDownloadOk")}: ${file.name}`, "success");
    } catch (e: any) {
      showStatus(`✗ ${e.message}`, "error");
    }
  };

  // Upload file
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("path", getFilePath(file.name));
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/sftp/upload`, {
        method: "POST",
        body: formData
      });
      const data = await res.json();
      if (data.isError) throw new Error(data.content?.[0]?.text);
      showStatus(`✓ ${t("sftpUploadOk")}: ${file.name}`, "success");
      loadFiles(path);
    } catch (e: any) {
      showStatus(`✗ ${e.message}`, "error");
    } finally {
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };



  return (
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box", overflow: "hidden", gap: "16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: "16px", fontWeight: 600, margin: 0, color: "hsl(var(--foreground))" }}>
          📂 {t("sftpTitle")}
        </h2>
        {/* Status Toast */}
        {status.msg && (
          <div style={{
            fontSize: "12px",
            padding: "6px 14px",
            borderRadius: "6px",
            background: status.type === "success" ? "hsl(var(--primary) / 0.1)" : "hsl(var(--destructive) / 0.1)",
            border: `1px solid ${status.type === "success" ? "hsl(var(--primary) / 0.3)" : "hsl(var(--destructive) / 0.3)"}`,
            color: status.type === "success" ? "hsl(var(--foreground))" : "hsl(var(--destructive-foreground))",
            animation: "fadeIn 0.3s ease",
          }}>
            {status.msg}
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="shadcn-card" style={{ padding: "8px 12px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", borderRadius: "6px" }}>
        <button onClick={handleBack} disabled={path === "/"} className="shadcn-btn shadcn-btn-outline" style={{ padding: "6px 12px", height: "32px", fontSize: "12px" }}>
          ← {t("backBtn")}
        </button>

        <div style={{ flex: 1, fontFamily: "monospace", fontSize: "13px", color: "hsl(var(--muted-foreground))", padding: "0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ color: "hsl(var(--foreground))" }}>/</span>
          {path.replace(/^\//, "").split("/").map((seg, i, arr) => (
            <span key={i}>
              <span
                style={{ color: i === arr.length - 1 ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))", cursor: "pointer" }}
                onClick={() => {
                  const newPath = "/" + arr.slice(0, i + 1).join("/");
                  loadFiles(newPath);
                }}
              >{seg}</span>
              {i < arr.length - 1 && <span style={{ color: "hsl(var(--border))" }}>/</span>}
            </span>
          ))}
        </div>

        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          {/* Mkdir */}
          <button onClick={() => { setMkdirMode(true); setMkdirName(""); }} className="shadcn-btn shadcn-btn-outline" style={{ padding: "6px 12px", height: "32px", fontSize: "12px" }}>
            📁 {t("sftpMkdir")}
          </button>
          {/* Upload */}
          <button onClick={() => uploadRef.current?.click()} className="shadcn-btn shadcn-btn-outline" style={{ padding: "6px 12px", height: "32px", fontSize: "12px" }}>
            ⬆ {t("sftpUpload")}
          </button>
          <input ref={uploadRef} type="file" style={{ display: "none" }} onChange={handleUpload} />
          {/* Refresh */}
          <button onClick={() => loadFiles(path)} className="shadcn-btn shadcn-btn-outline" style={{ padding: "6px 12px", height: "32px", fontSize: "12px" }}>
            🔄 {t("sftpRefresh")}
          </button>
        </div>
      </div>

      {/* Mkdir input row */}
      {mkdirMode && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input
            autoFocus
            value={mkdirName}
            onChange={e => setMkdirName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleMkdir(); if (e.key === "Escape") setMkdirMode(false); }}
            placeholder={t("sftpMkdirPlaceholder")}
            className="shadcn-input"
            style={{ flex: 1 }}
          />
          <button onClick={handleMkdir} className="shadcn-btn shadcn-btn-primary" style={{ padding: "8px 16px", height: "36px" }}>✓ 创建</button>
          <button onClick={() => setMkdirMode(false)} className="shadcn-btn shadcn-btn-outline" style={{ padding: "8px 12px", height: "36px" }}>✕</button>
        </div>
      )}

      {/* Rename inline input */}
      {renameTarget && (
        <div className="shadcn-card" style={{ display: "flex", gap: "8px", alignItems: "center", padding: "10px 14px", borderRadius: "6px" }}>
          <span style={{ fontSize: "13px", color: "hsl(var(--muted-foreground))" }}>重命名 <span style={{ color: "hsl(var(--foreground))", fontWeight: 600 }}>{renameTarget.name}</span> →</span>
          <input
            autoFocus
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleRenameSubmit(); if (e.key === "Escape") setRenameTarget(null); }}
            placeholder="新名称"
            className="shadcn-input"
            style={{ flex: 1 }}
          />
          <button onClick={handleRenameSubmit} className="shadcn-btn shadcn-btn-primary" style={{ padding: "8px 16px", height: "36px" }}>✓ 确认</button>
          <button onClick={() => setRenameTarget(null)} className="shadcn-btn shadcn-btn-outline" style={{ padding: "8px 12px", height: "36px" }}>✕</button>
        </div>
      )}

      {/* Files Table */}
      <div className="shadcn-card" style={{ flex: 1, overflowY: "auto", padding: "4px" }}>
        {loading ? (
          <div style={{ padding: "60px", textAlign: "center", color: "hsl(var(--muted-foreground))" }}>
            <div style={{ fontSize: "24px", marginBottom: "8px" }}>⏳</div>
            加载中...
          </div>
        ) : files.length === 0 ? (
          <div style={{ padding: "60px", textAlign: "center", color: "hsl(var(--muted-foreground))" }}>
            <div style={{ fontSize: "32px", marginBottom: "8px" }}>📭</div>
            {t("sftpEmpty")}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <th style={{ padding: "10px 12px" }}>{t("fileName")}</th>
                <th style={{ padding: "10px 12px", width: "90px" }}>{t("fileSize")}</th>
                <th style={{ padding: "10px 12px", width: "160px" }}>{t("fileTime")}</th>
                <th style={{ padding: "10px 12px", width: "200px", textAlign: "right" }}>{t("sftpActions")}</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file, idx) => {
                const isSelected = selectedFile?.name === file.name;
                return (
                  <tr
                    key={idx}
                    onClick={() => handleRowClick(file)}
                    style={{
                      borderBottom: "1px solid hsl(var(--border))",
                      cursor: "pointer",
                      backgroundColor: isSelected ? "hsl(var(--accent))" : "transparent",
                      transition: "background-color 0.15s"
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.backgroundColor = "hsl(var(--accent) / 0.3)"; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.backgroundColor = "transparent"; }}
                  >
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "16px" }}>
                          {file.type === "dir" ? "📁" : file.type === "symlink" ? "🔗" : getFileIcon(file.name)}
                        </span>
                        <span style={{
                          fontWeight: file.type === "dir" ? 500 : 400,
                          color: file.type === "dir" ? "#f59e0b" : "hsl(var(--foreground))"
                        }}>
                          {file.name}
                        </span>
                        {file.type === "symlink" && file.linkTarget && (
                          <span style={{ fontSize: "11px", color: "hsl(var(--muted-foreground))", fontFamily: "monospace" }}>
                            → {file.linkTarget}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: "10px 12px", color: "hsl(var(--muted-foreground))", fontFamily: "monospace", fontSize: "12px" }}>
                      {file.type === "dir" ? "—" : formatBytes(file.size)}
                    </td>
                    <td style={{ padding: "10px 12px", color: "hsl(var(--muted-foreground))", fontSize: "12px" }}>
                      {new Date(file.mtime * 1000).toLocaleString()}
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", alignItems: "center" }} onClick={e => e.stopPropagation()}>
                        {/* Download (files and symlinks) */}
                        {(file.type === "file" || file.type === "symlink") && (
                          <button
                            title={t("sftpDownload")}
                            onClick={() => handleDownload(file)}
                            className="shadcn-btn shadcn-btn-underline"
                          >
                            ↓ {t("sftpDownload")}
                          </button>
                        )}
                        {/* Rename */}
                        <button
                          title={t("sftpRename")}
                          onClick={() => { setRenameTarget(file); setRenameValue(file.name); }}
                          className="shadcn-btn shadcn-btn-underline"
                        >
                          — {t("sftpRename")}
                        </button>
                        {/* Delete */}
                        <button
                          title={t("sftpDelete")}
                          onClick={() => handleDelete(file)}
                          className="shadcn-btn shadcn-btn-underline-destructive"
                        >
                          {t("sftpDelete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Helper: file type icon
function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "🟨", ts: "🔷", tsx: "🔷", jsx: "🟨",
    json: "📋", md: "📝", txt: "📄", sh: "⚙️",
    py: "🐍", java: "☕", go: "🐹", rs: "🦀",
    html: "🌐", css: "🎨", png: "🖼", jpg: "🖼",
    jpeg: "🖼", gif: "🖼", svg: "🎨", zip: "📦",
    tar: "📦", gz: "📦", log: "📋", yaml: "⚙️", yml: "⚙️",
    toml: "⚙️", xml: "📋", sql: "🗃", conf: "⚙️", env: "⚙️",
  };
  return map[ext] ?? "📄";
}

// Helper: format bytes
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ======== VIEW 4: System Monitor View ========

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

function MonitorView({ sessionId, lang }: MonitorViewProps) {
  const [sysinfo, setSysinfo] = useState("");
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);

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

  useEffect(() => {
    loadMonitorData();
    const timer = setInterval(loadMonitorData, 6000);
    return () => clearInterval(timer);
  }, [sessionId]);

  return (
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box", overflow: "hidden", gap: "16px" }}>
      <h2 style={{ fontSize: "16px", fontWeight: 600, margin: 0, color: "hsl(var(--foreground))" }}>{t("tabMonitor")}</h2>

      <div style={{ display: "flex", gap: "24px", flex: 1, overflow: "hidden" }}>
        
        {/* Left: Sysinfo Text Panel */}
        <div className="shadcn-card" style={{ flex: 1, padding: "16px", display: "flex", flexDirection: "column" }}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px", color: "hsl(var(--foreground))" }}>
            {t("sysLoad")}
          </h3>
          <div style={{ flex: 1, background: "rgba(0,0,0,0.2)", borderRadius: "6px", padding: "16px", fontFamily: "monospace", fontSize: "13px", whiteSpace: "pre-wrap", overflowY: "auto", border: "1px solid hsl(var(--border))" }}>
            {loading && !sysinfo ? "Loading diagnostics..." : sysinfo}
          </div>
        </div>

        {/* Right: Active processes table */}
        <div className="shadcn-card" style={{ flex: 1, padding: "16px", display: "flex", flexDirection: "column" }}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px", color: "hsl(var(--foreground))" }}>
            {t("processes")}
          </h3>
          <div style={{ flex: 1, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
                  <th style={{ padding: "8px" }}>PID</th>
                  <th style={{ padding: "8px" }}>CPU%</th>
                  <th style={{ padding: "8px" }}>MEM%</th>
                  <th style={{ padding: "8px" }}>Command</th>
                </tr>
              </thead>
              <tbody>
                {processes.map((proc, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid hsl(var(--border))" }}>
                    <td style={{ padding: "8px", fontFamily: "monospace" }}>{proc.pid}</td>
                    <td style={{ padding: "8px", color: "hsl(var(--foreground))", fontWeight: 600 }}>{proc.cpu}%</td>
                    <td style={{ padding: "8px", color: "hsl(var(--muted-foreground))" }}>{proc.mem}%</td>
                    <td style={{ padding: "8px", fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "180px" }} title={proc.command}>
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
