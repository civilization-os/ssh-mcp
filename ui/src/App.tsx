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
  kubectlPath?: string;
  kubeconfig?: string;
  authType?: "password" | "privateKey";
  hasPassword?: boolean;
  hasPrivateKey?: boolean;
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
  type: "file" | "dir";
  size: number;
  mode: string;
  mtime: number;
}

const API_BASE = "http://127.0.0.1:12222";
const WS_BASE = "ws://127.0.0.1:12222";

const sessionBadgeStyle: React.CSSProperties = {
  fontSize: "10px",
  padding: "1px 6px",
  borderRadius: "4px",
  background: "rgba(255, 255, 255, 0.05)",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  color: "var(--text-secondary)"
};

function SessionItem({ 
  sess, 
  isSelected, 
  onSelect, 
  onEdit, 
  onDelete, 
  lang 
}: { 
  sess: SshSession; 
  isSelected: boolean; 
  onSelect: () => void; 
  onEdit: () => void; 
  onDelete: () => void;
  lang: Language;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        padding: "12px",
        borderRadius: "8px",
        marginBottom: "8px",
        cursor: "pointer",
        background: isSelected ? "rgba(255, 255, 255, 0.08)" : "rgba(255, 255, 255, 0.02)",
        border: `1px solid ${isSelected ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.05)"}`,
        transition: "all 0.2s ease"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px" }}>
        <span style={{ fontWeight: 600, fontSize: "14px", color: isSelected ? "var(--text-primary)" : "var(--text-secondary)" }}>
          {sess.label}
        </span>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "12px" }}
          >
            ✎
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "12px" }}
          >
            ✕
          </button>
        </div>
      </div>
      <div style={{ fontSize: "11px", color: "var(--text-secondary)", opacity: 0.7 }}>
        {sess.username}@{sess.host}
      </div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
        <span style={sessionBadgeStyle}>{sess.authType === "privateKey" ? translations[lang].authPrivateKeySaved : translations[lang].authPasswordSaved}</span>
        {sess.kubectlPath && <span style={sessionBadgeStyle}>kubectl</span>}
        {sess.kubeconfig && <span style={sessionBadgeStyle}>kubeconfig</span>}
      </div>
      <div style={{ 
        fontSize: "10px", 
        marginTop: "8px", 
        color: "var(--accent-neon)",
        opacity: 0.8,
        display: "flex",
        alignItems: "center",
        gap: "6px"
      }} title={translations[lang].heartbeatTooltip}>
        <span className="pulse-glow" style={{ 
          width: "6px", 
          height: "6px", 
          borderRadius: "50%", 
          background: "var(--accent-neon)",
          display: "inline-block"
        }} />
        <span style={{ fontWeight: 500 }}>{translations[lang].heartbeatActive}</span>
      </div>
    </div>
  );
}

export default function App() {
  const [sessions, setSessions] = useState<SshSession[]>([]);
  const [shells, setShells] = useState<ShellSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [activeShellId, setActiveShellId] = useState<string>("");
  
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  
  // Navigation Tabs
  const [activeTab, setActiveTab] = useState<"terminal" | "sftp" | "k8s" | "monitor">("terminal");
  
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
  const [kubectlPathInput, setKubectlPathInput] = useState("");
  const [kubeconfigInput, setKubeconfigInput] = useState("");
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
    setKubectlPathInput("");
    setKubeconfigInput("");
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
    setKubectlPathInput(session.kubectlPath ?? "");
    setKubeconfigInput(session.kubeconfig ?? "");
    setConnectError("");
    setShowCreateModal(true);
  };

  // Polling for sessions and shells
  useEffect(() => {
    const fetchData = async () => {
      try {
        const sRes = await fetch(`${API_BASE}/api/sessions`);
        const sData = await sRes.json();
        setSessions(sData);

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
        kubectlPath: kubectlPathInput,
        kubeconfig: kubeconfigInput,
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
    <div style={{ display: "flex", height: "100vh", width: "100vw", overflow: "hidden", background: "var(--bg-gradient)" }}>
      {/* Sidebar */}
      <div 
        className="glass-panel" 
        style={{ 
          width: sidebarCollapsed ? "68px" : "300px", 
          minWidth: sidebarCollapsed ? "68px" : "300px", 
          borderRight: "1px solid var(--panel-border)", 
          display: "flex", 
          flexDirection: "column", 
          height: "100%", 
          borderRadius: "0",
          overflow: "hidden",
          transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
        }}
      >
        
        {/* Title Bar / Collapse Button */}
        <div style={{ 
          padding: sidebarCollapsed ? "18px 0" : "24px 20px", 
          borderBottom: "1px solid var(--panel-border)", 
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
            <h1 className="gradient-text" style={{ fontSize: "20px", margin: 0, fontWeight: 700, letterSpacing: "-0.5px" }}>
              {t("title")}
            </h1>
            <p style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>
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
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid var(--panel-border)",
                  color: "var(--text-primary)",
                  borderRadius: "6px",
                  padding: "4px 8px",
                  fontSize: "11px",
                  cursor: "pointer"
                }}
              >
                {t("langToggle")}
              </button>
            )}
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid var(--panel-border)",
                color: "var(--text-primary)",
                borderRadius: "6px",
                width: "36px",
                height: "36px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontSize: "14px"
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
            padding: "10px 0", 
            borderBottom: "1px solid var(--panel-border)", 
            display: "flex", 
            flexDirection: "column", 
            gap: "4px",
            alignItems: "center",
            width: "100%",
            position: "relative",
            flexShrink: 0
          }}>
            {[
              { id: "terminal", icon: "💻", label: t("tabTerminal"), color: "#00f2fe", glow: "rgba(0,242,254,0.2)" },
              { id: "sftp",     icon: "📂", label: t("tabSftp"),     color: "#f7971e", glow: "rgba(247,151,30,0.2)"  },
              { id: "k8s",     icon: "☸️", label: t("tabK8s"),     color: "#a855f7", glow: "rgba(168,85,247,0.2)" },
              { id: "monitor", icon: "📊", label: t("tabMonitor"), color: "#10b981", glow: "rgba(16,185,129,0.2)" }
            ].map(tab => {
              const isActive = activeTab === tab.id;
              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  title={sidebarCollapsed ? tab.label : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "10px 12px",
                    width: sidebarCollapsed ? "40px" : "260px",
                    height: "40px",
                    borderRadius: "8px",
                    cursor: "pointer",
                    fontSize: "14px",
                    fontWeight: isActive ? 700 : 500,
                    position: "relative",
                    background: isActive
                      ? `linear-gradient(135deg, ${tab.glow}, rgba(255,255,255,0.03))`
                      : "transparent",
                    color: isActive ? tab.color : "var(--text-secondary)",
                    border: isActive ? `1px solid ${tab.color}33` : "1px solid transparent",
                    transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                    boxShadow: isActive ? `0 2px 12px ${tab.glow}` : "none",
                    overflow: "hidden",
                    whiteSpace: "nowrap"
                  }}
                  onMouseEnter={e => {
                    if (!isActive) {
                      (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.04)";
                      (e.currentTarget as HTMLDivElement).style.color = "var(--text-primary)";
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isActive) {
                      (e.currentTarget as HTMLDivElement).style.background = "transparent";
                      (e.currentTarget as HTMLDivElement).style.color = "var(--text-secondary)";
                    }
                  }}
                >
                  {/* Active indicator bar */}
                  {isActive && (
                    <div style={{
                      position: "absolute",
                      left: 0,
                      top: "20%",
                      height: "60%",
                      width: "3px",
                      borderRadius: "0 3px 3px 0",
                      background: tab.color,
                      boxShadow: `0 0 8px ${tab.color}`,
                    }} />
                  )}
                  <div style={{ 
                    display: "flex", 
                    alignItems: "center", 
                    justifyContent: "center",
                    width: "16px",
                    flexShrink: 0,
                    marginLeft: (!sidebarCollapsed && isActive) ? "4px" : "0",
                    transition: "margin 0.3s"
                  }}>
                    <span style={{ fontSize: "16px" }}>{tab.icon}</span>
                  </div>
                  
                  {/* Text Label */}
                  <span style={{ 
                    position: "absolute",
                    left: "44px",
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
            <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "var(--text-secondary)", letterSpacing: "1px" }}>
              {t("sessionsTitle")} ({sessions.length})
            </div>
            <button
              onClick={openCreateModal}
              style={{
                background: "rgba(0, 242, 254, 0.1)",
                border: "1px solid rgba(0, 242, 254, 0.3)",
                color: "var(--accent-blue)",
                borderRadius: "4px",
                padding: "2px 6px",
                fontSize: "11px",
                cursor: "pointer",
                fontWeight: 600,
                transition: "all 0.2s ease"
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
                  setKubectlPathInput(sess.kubectlPath || "");
                  setKubeconfigInput(sess.kubeconfig || "");
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
                <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "var(--text-secondary)", letterSpacing: "1px" }}>
                  {t("terminalsTitle")}
                </div>
                <button
                  className="glow-btn"
                  onClick={handleOpenShell}
                  style={{
                    padding: "4px 8px",
                    borderRadius: "4px",
                    fontSize: "11px",
                    color: "#000"
                  }}
                >
                  {t("newBtn")}
                </button>
              </div>

              {filteredShells.length === 0 ? (
                <div style={{ padding: "12px 8px", fontSize: "12px", color: "var(--text-secondary)", textAlign: "center" }}>
                  {t("noTerminals")}
                </div>
              ) : (
                filteredShells.map((sh) => (
                  <div
                    key={sh.id}
                    onClick={() => setActiveShellId(sh.id)}
                    style={{
                      padding: "10px 12px",
                      borderRadius: "8px",
                      marginBottom: "6px",
                      cursor: "pointer",
                      background: activeShellId === sh.id ? "rgba(255, 255, 255, 0.08)" : "rgba(255, 255, 255, 0.02)",
                      border: `1px solid ${activeShellId === sh.id ? "rgba(255, 255, 255, 0.2)" : "rgba(255, 255, 255, 0.02)"}`,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      transition: "all 0.2s ease"
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: sh.closed ? "var(--accent-pink)" : "var(--accent-neon)" }} />
                      <span style={{ fontSize: "13px", color: activeShellId === sh.id ? "var(--text-primary)" : "var(--text-secondary)" }}>
                        {sh.id.substring(3, 11)}...
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      {sh.keepAlive && (
                        <span 
                          title={lang === "zh" ? "已开启心跳维持" : "Keep-alive enabled"}
                          style={{ fontSize: "10px", color: "var(--accent-neon)", opacity: 0.8 }}
                        >
                          💓
                        </span>
                      )}
                      <span style={{ fontSize: "10px", color: "var(--text-secondary)" }}>{sh.age}s</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCloseShell(sh.id); }}
                        title="关闭此终端"
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--text-secondary)",
                          cursor: "pointer",
                          fontSize: "12px",
                          lineHeight: 1,
                          padding: "2px 4px",
                          borderRadius: "4px",
                          transition: "color 0.2s ease"
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent-pink)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
          </div>
        </div>
      </div>

      {/* Main Panel */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {!selectedSessionId ? (
          <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
            <div className="glass-panel" style={{ padding: "40px", maxWidth: "480px", textAlign: "center", margin: "20px" }}>
              <div style={{ fontSize: "48px", marginBottom: "16px" }}>📡</div>
              <h2 style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: "20px", marginBottom: "8px" }}>
                {t("emptyStateTitle")}
              </h2>
              <p style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.5", marginBottom: "24px" }}>
                {t("emptyStateDesc")}
              </p>
              <button
                className="glow-btn"
                onClick={openCreateModal}
                style={{ padding: "10px 24px", borderRadius: "6px", color: "#000" }}
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
                  <div className="glass-panel" style={{ padding: "40px", maxWidth: "480px", textAlign: "center", margin: "20px" }}>
                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>💻</div>
                    <h2 style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: "20px", marginBottom: "8px" }}>
                      {t("welcomeTitle")}
                    </h2>
                    <p style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.5" }}>
                      {t("welcomeDesc")}
                    </p>
                    <button className="glow-btn" onClick={handleOpenShell} style={{ marginTop: "20px", padding: "10px 24px", borderRadius: "6px" }}>
                      {t("newBtn")}
                    </button>
                  </div>
                </div>
              )
            )}

            {activeTab === "sftp" && (
              <SftpView sessionId={selectedSessionId} lang={lang} />
            )}

            {activeTab === "k8s" && (
              <K8sView sessionId={selectedSessionId} lang={lang} />
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
          background: "rgba(0,0,0,0.65)",
          backdropFilter: "blur(10px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1100,
        }}>
          <div className="glass-panel" style={{
            width: "420px",
            padding: "32px 28px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            border: "1px solid rgba(245, 87, 108, 0.3)",
            boxShadow: "0 20px 60px rgba(0,0,0,0.6), 0 0 40px rgba(245,87,108,0.08)",
          }}>
            {/* Icon + Title */}
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div style={{
                width: "44px",
                height: "44px",
                borderRadius: "50%",
                background: "rgba(245, 87, 108, 0.12)",
                border: "1px solid rgba(245, 87, 108, 0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "20px",
                flexShrink: 0,
              }}>⚠️</div>
              <div>
                <div style={{ fontSize: "17px", fontWeight: 700, color: "var(--text-primary)", marginBottom: "2px" }}>
                  {t("confirmDeleteTitle")}
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  {t("confirmDeleteHint")}
                </div>
              </div>
            </div>

            {/* Session name highlight */}
            <div style={{
              background: "rgba(245, 87, 108, 0.08)",
              border: "1px solid rgba(245, 87, 108, 0.2)",
              borderRadius: "8px",
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}>
              <span style={{ fontSize: "16px" }}>🖥️</span>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--accent-pink)" }}>
                  {confirmTarget.label}
                </div>
                <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>
                  ID: {confirmTarget.id}
                </div>
              </div>
            </div>

            {/* Buttons */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
              <button
                onClick={() => setConfirmTarget(null)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--panel-border)",
                  color: "var(--text-secondary)",
                  borderRadius: "6px",
                  padding: "9px 20px",
                  fontSize: "14px",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.3)"; (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--panel-border)"; (e.currentTarget as HTMLButtonElement).style.color = "var(--text-secondary)"; }}
              >
                {t("cancelBtn")}
              </button>
              <button
                onClick={handleConfirmDelete}
                style={{
                  background: "linear-gradient(135deg, #f5576c, #c0392b)",
                  border: "none",
                  color: "#fff",
                  borderRadius: "6px",
                  padding: "9px 22px",
                  fontSize: "14px",
                  fontWeight: 700,
                  cursor: "pointer",
                  transition: "all 0.2s",
                  boxShadow: "0 4px 15px rgba(245,87,108,0.4)",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 6px 20px rgba(245,87,108,0.6)"; (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-1px)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 4px 15px rgba(245,87,108,0.4)"; (e.currentTarget as HTMLButtonElement).style.transform = "none"; }}
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
          background: "rgba(0,0,0,0.6)",
          backdropFilter: "blur(8px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
        }}>
          <form onSubmit={handleConnect} className="glass-panel" style={{
            width: "480px",
            padding: "28px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
          }}>
            <h3 style={{ fontSize: "18px", fontWeight: 700, margin: 0, color: "var(--accent-blue)" }}>
              {editingSessionId ? t("editSession") : t("connectNewSession")}
            </h3>

            {connectError && (
              <div style={{
                background: "rgba(245, 87, 108, 0.1)",
                border: "1px solid rgba(245, 87, 108, 0.3)",
                color: "var(--accent-pink)",
                borderRadius: "6px",
                padding: "10px 12px",
                fontSize: "13px",
                lineHeight: "1.4",
              }}>
                <strong>{t("connectFailed")}:</strong> {connectError}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("sessionName")}</label>
                <input
                  type="text"
                  placeholder="e.g. Production Web Server"
                value={sessionNameInput}
                onChange={e => setSessionNameInput(e.target.value)}
                style={{
                  background: "rgba(0,0,0,0.3)",
                  border: "1px solid var(--panel-border)",
                  borderRadius: "6px",
                  padding: "8px 12px",
                  color: "var(--text-primary)",
                  fontSize: "14px",
                }}
              />
            </div>

            <div style={{ display: "flex", gap: "12px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1 }}>
                <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("host")} *</label>
                <input
                  type="text"
                  required
                  placeholder="12.34.56.78"
                  value={hostInput}
                  onChange={e => setHostInput(e.target.value)}
                  style={{
                    background: "rgba(0,0,0,0.3)",
                    border: "1px solid var(--panel-border)",
                    borderRadius: "6px",
                    padding: "8px 12px",
                    color: "var(--text-primary)",
                    fontSize: "14px",
                  }}
                />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100px" }}>
                <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("port")} *</label>
                <input
                  type="text"
                  required
                  placeholder="22"
                  value={portInput}
                  onChange={e => setPortInput(e.target.value)}
                  style={{
                    background: "rgba(0,0,0,0.3)",
                    border: "1px solid var(--panel-border)",
                    borderRadius: "6px",
                    padding: "8px 12px",
                    color: "var(--text-primary)",
                    fontSize: "14px",
                  }}
                />
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("username")} *</label>
              <input
                type="text"
                required
                placeholder="root"
                value={usernameInput}
                onChange={e => setUsernameInput(e.target.value)}
                style={{
                  background: "rgba(0,0,0,0.3)",
                  border: "1px solid var(--panel-border)",
                  borderRadius: "6px",
                  padding: "8px 12px",
                  color: "var(--text-primary)",
                  fontSize: "14px",
                }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("authMethod")}</label>
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
                <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("password")} *</label>
                <input
                  type="password"
                  required={!editingSessionId || authMethodInput !== initialAuthMethod}
                  placeholder="••••••••"
                  value={passwordInput}
                  onChange={e => setPasswordInput(e.target.value)}
                  style={{
                    background: "rgba(0,0,0,0.3)",
                    border: "1px solid var(--panel-border)",
                    borderRadius: "6px",
                    padding: "8px 12px",
                    color: "var(--text-primary)",
                    fontSize: "14px",
                  }}
                />
                {editingSessionId && authMethodInput === initialAuthMethod && (
                  <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{t("keepCurrentSecret")}</div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("privateKey")} *</label>
                <textarea
                  required={!editingSessionId || authMethodInput !== initialAuthMethod}
                  rows={5}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  value={privateKeyInput}
                  onChange={e => setPrivateKeyInput(e.target.value)}
                  style={{
                    background: "rgba(0,0,0,0.3)",
                    border: "1px solid var(--panel-border)",
                    borderRadius: "6px",
                    padding: "8px 12px",
                    color: "var(--text-primary)",
                    fontSize: "12px",
                    fontFamily: "monospace",
                    resize: "none",
                  }}
                />
                {editingSessionId && authMethodInput === initialAuthMethod && (
                  <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{t("keepCurrentSecret")}</div>
                )}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("kubectlPath")} <span style={{ color: "var(--accent-blue)" }}>(Optional)</span></label>
              <input
                type="text"
                placeholder={t("kubectlPathPlaceholder")}
                value={kubectlPathInput}
                onChange={e => setKubectlPathInput(e.target.value)}
                style={{
                  background: "rgba(0,0,0,0.3)",
                  border: "1px solid var(--panel-border)",
                  borderRadius: "6px",
                  padding: "8px 12px",
                  color: "var(--text-primary)",
                  fontSize: "14px",
                }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{t("kubeconfigPath")} <span style={{ color: "var(--accent-blue)" }}>(Optional)</span></label>
              <input
                type="text"
                placeholder={t("kubeconfigPathPlaceholder")}
                value={kubeconfigInput}
                onChange={e => setKubeconfigInput(e.target.value)}
                style={{
                  background: "rgba(0,0,0,0.3)",
                  border: "1px solid var(--panel-border)",
                  borderRadius: "6px",
                  padding: "8px 12px",
                  color: "var(--text-primary)",
                  fontSize: "14px",
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "12px" }}>
              <button
                type="button"
                onClick={() => { setShowCreateModal(false); resetSessionForm(); }}
                style={{
                  background: "transparent",
                  border: "1px solid var(--panel-border)",
                  color: "var(--text-secondary)",
                  borderRadius: "6px",
                  padding: "8px 16px",
                  fontSize: "14px",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                {t("cancelBtn")}
              </button>
              <button
                type="submit"
                className="glow-btn"
                disabled={connectLoading}
                style={{
                  borderRadius: "6px",
                  padding: "8px 24px",
                  fontSize: "14px",
                  fontWeight: 600,
                  color: "#000",
                }}
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
    <div className="glass-panel" style={{ 
      margin: "12px 12px 0 12px", 
      padding: "10px 16px", 
      borderRadius: "10px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "20px",
      background: "rgba(255, 255, 255, 0.02)",
      border: "1px solid var(--panel-border)",
      transition: "all 0.2s ease"
    }}>
      {/* Session Title & Connection Info */}
      <div style={{ display: "flex", alignItems: "center", gap: "14px", flex: 1, minWidth: 0 }}>
        {/* Status Dot */}
        <div style={{ 
          width: "8px", 
          height: "8px", 
          borderRadius: "50%", 
          background: "var(--accent-neon)", 
          boxShadow: "0 0 6px var(--accent-neon)",
          flexShrink: 0
        }} />
        
        {/* Session Name */}
        <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)", flexShrink: 0 }}>
          {session.label}
        </span>
        
        <div style={{ width: "1px", height: "16px", background: "rgba(255,255,255,0.1)", flexShrink: 0 }} />

        {/* Horizontal Info Items */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px", flex: 1, minWidth: 0, overflowX: "auto" }}>
          <InlineInfoItem label={t("hostPort")} value={`${session.username}@${session.host}:${session.port}`} iconType="host" />
          <InlineInfoItem label={t("authStatus")} value={authLabel} iconType="auth" />
          <InlineInfoItem label="kubectl" value={session.kubectlPath || t("autoDetect")} iconType="kubectl" />
          <InlineInfoItem label="kubeconfig" value={session.kubeconfig || t("autoDetect")} iconType="kubeconfig" />
        </div>
      </div>

      {/* Edit button */}
      <button
        onClick={() => onEdit(session)}
        style={{
          background: "rgba(0, 242, 254, 0.05)",
          border: "1px solid rgba(0, 242, 254, 0.2)",
          color: "var(--accent-blue)",
          borderRadius: "6px",
          padding: "6px 12px",
          fontSize: "12px",
          cursor: "pointer",
          flexShrink: 0,
          transition: "all 0.2s"
        }}
        onMouseEnter={e => { e.currentTarget.style.background = "rgba(0, 242, 254, 0.12)"; e.currentTarget.style.borderColor = "rgba(0, 242, 254, 0.35)"; }}
        onMouseLeave={e => { e.currentTarget.style.background = "rgba(0, 242, 254, 0.05)"; e.currentTarget.style.borderColor = "rgba(0, 242, 254, 0.2)"; }}
      >
        {t("editSession")}
      </button>
    </div>
  );
}

function InlineInfoItem({ label, value, iconType }: { label: string; value: string; iconType?: 'host' | 'auth' | 'kubectl' | 'kubeconfig' }) {
  const getIcon = () => {
    switch (iconType) {
      case 'host':
        return <span style={{ color: 'var(--accent-blue)', fontSize: '12px' }}>🖥️</span>;
      case 'auth':
        return <span style={{ color: 'var(--accent-neon)', fontSize: '12px' }}>🛡️</span>;
      case 'kubectl':
        return <span style={{ color: '#a855f7', fontSize: '12px' }}>🧪</span>;
      case 'kubeconfig':
        return <span style={{ color: '#f7971e', fontSize: '12px' }}>📄</span>;
      default:
        return null;
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0, fontSize: "12px" }}>
      {getIcon()}
      <span style={{ color: "var(--text-secondary)", opacity: 0.8 }}>{label}:</span>
      <span style={{ color: "var(--text-primary)", fontWeight: 500, whiteSpace: "nowrap" }} title={value}>{value}</span>
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
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      scrollback: 50000,
      theme: {
        background: "#000000",
        foreground: "#f3f4f6",
        cursor: "#00f2fe",
        black: "#000000",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#f3f4f6",
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", background: "#000" }}>
      <div className="glass-panel" style={{ padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--panel-border)", borderRadius: "0", background: "rgba(255,255,255,0.01)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent-neon)", boxShadow: "0 0 8px var(--accent-neon)" }} />
          <span style={{ fontSize: "14px", fontWeight: 600 }}>{t("activeTerminal")}: {shellId}</span>
          {isHeartbeating && (
            <div style={{ 
              fontSize: "10px", 
              color: "var(--accent-neon)", 
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
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "15px" }}>
          <button 
            onClick={() => terminalRef.current?.clear()}
            style={{ 
              background: "transparent", 
              border: "1px solid var(--panel-border)", 
              color: "var(--text-secondary)",
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "11px",
              cursor: "pointer"
            }}
          >
            {t("clear")}
          </button>
          <div>{t("wsConnected")}</div>
        </div>
      </div>
      
      <div style={{ flex: 1, position: "relative", padding: "10px" }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%", position: "absolute", top: 0, left: 0, padding: "10px", boxSizing: "border-box" }} />
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
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
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

  const btnStyle = (color = "rgba(255,255,255,0.08)"): React.CSSProperties => ({
    background: color,
    border: "1px solid rgba(255,255,255,0.1)",
    color: "var(--text-primary)",
    borderRadius: "6px",
    padding: "6px 14px",
    fontSize: "12px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "5px",
    transition: "all 0.2s ease",
    whiteSpace: "nowrap" as const,
  });

  return (
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box", overflow: "hidden", gap: "12px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: "18px", fontWeight: 700, margin: 0, color: "var(--text-primary)" }}>
          📂 {t("sftpTitle")}
        </h2>
        {/* Status Toast */}
        {status.msg && (
          <div style={{
            fontSize: "12px",
            padding: "6px 14px",
            borderRadius: "6px",
            background: status.type === "success" ? "rgba(16,185,129,0.15)" : "rgba(245,87,108,0.15)",
            border: `1px solid ${status.type === "success" ? "rgba(16,185,129,0.4)" : "rgba(245,87,108,0.4)"}`,
            color: status.type === "success" ? "#10b981" : "var(--accent-pink)",
            animation: "fadeIn 0.3s ease",
          }}>
            {status.msg}
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="glass-panel" style={{ padding: "10px 14px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={handleBack} disabled={path === "/"} style={btnStyle()}
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
          onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}>
          ← {t("backBtn")}
        </button>

        <div style={{ flex: 1, fontFamily: "monospace", fontSize: "13px", color: "var(--text-secondary)", padding: "0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ color: "var(--accent-blue)" }}>/</span>
          {path.replace(/^\//, "").split("/").map((seg, i, arr) => (
            <span key={i}>
              <span
                style={{ color: i === arr.length - 1 ? "var(--text-primary)" : "var(--text-secondary)", cursor: "pointer" }}
                onClick={() => {
                  const newPath = "/" + arr.slice(0, i + 1).join("/");
                  loadFiles(newPath);
                }}
              >{seg}</span>
              {i < arr.length - 1 && <span style={{ color: "var(--text-secondary)" }}>/</span>}
            </span>
          ))}
        </div>

        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          {/* Mkdir */}
          <button onClick={() => { setMkdirMode(true); setMkdirName(""); }} style={btnStyle("rgba(247,151,30,0.12)")}>
            📁 {t("sftpMkdir")}
          </button>
          {/* Upload */}
          <button onClick={() => uploadRef.current?.click()} style={btnStyle("rgba(0,242,254,0.1)")}>
            ⬆ {t("sftpUpload")}
          </button>
          <input ref={uploadRef} type="file" style={{ display: "none" }} onChange={handleUpload} />
          {/* Refresh */}
          <button onClick={() => loadFiles(path)} style={btnStyle()}>
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
            style={{
              flex: 1, background: "rgba(0,0,0,0.3)", border: "1px solid var(--panel-border)",
              borderRadius: "6px", padding: "7px 12px", color: "var(--text-primary)", fontSize: "13px"
            }}
          />
          <button onClick={handleMkdir} style={{ ...btnStyle("rgba(247,151,30,0.2)"), fontWeight: 700 }}>✓ 创建</button>
          <button onClick={() => setMkdirMode(false)} style={btnStyle()}>✕</button>
        </div>
      )}

      {/* Rename inline input */}
      {renameTarget && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", background: "rgba(0,242,254,0.06)", border: "1px solid rgba(0,242,254,0.2)", borderRadius: "8px", padding: "10px 14px" }}>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>重命名 <span style={{ color: "var(--accent-blue)" }}>{renameTarget.name}</span> →</span>
          <input
            autoFocus
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleRenameSubmit(); if (e.key === "Escape") setRenameTarget(null); }}
            placeholder="新名称"
            style={{
              flex: 1, background: "rgba(0,0,0,0.3)", border: "1px solid var(--panel-border)",
              borderRadius: "6px", padding: "6px 12px", color: "var(--text-primary)", fontSize: "13px"
            }}
          />
          <button onClick={handleRenameSubmit} style={{ ...btnStyle("rgba(0,242,254,0.15)"), fontWeight: 700 }}>✓ 确认</button>
          <button onClick={() => setRenameTarget(null)} style={btnStyle()}>✕</button>
        </div>
      )}

      {/* Files Table */}
      <div className="glass-panel" style={{ flex: 1, overflowY: "auto", padding: "4px" }}>
        {loading ? (
          <div style={{ padding: "60px", textAlign: "center", color: "var(--text-secondary)" }}>
            <div style={{ fontSize: "24px", marginBottom: "8px" }}>⏳</div>
            加载中...
          </div>
        ) : files.length === 0 ? (
          <div style={{ padding: "60px", textAlign: "center", color: "var(--text-secondary)" }}>
            <div style={{ fontSize: "32px", marginBottom: "8px" }}>📭</div>
            {t("sftpEmpty")}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--panel-border)", color: "var(--text-secondary)", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                <th style={{ padding: "10px 12px" }}>{t("fileName")}</th>
                <th style={{ padding: "10px 12px", width: "90px" }}>{t("fileSize")}</th>
                <th style={{ padding: "10px 12px", width: "160px" }}>{t("fileTime")}</th>
                <th style={{ padding: "10px 12px", width: "160px", textAlign: "right" }}>{t("sftpActions")}</th>
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
                      borderBottom: "1px solid rgba(255,255,255,0.02)",
                      cursor: "pointer",
                      background: isSelected ? "rgba(0,242,254,0.06)" : "transparent",
                      transition: "background 0.15s"
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                  >
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "16px" }}>
                          {file.type === "dir" ? "📁" : getFileIcon(file.name)}
                        </span>
                        <span style={{
                          fontWeight: file.type === "dir" ? 600 : 400,
                          color: file.type === "dir" ? "#f7971e" : "var(--text-primary)"
                        }}>
                          {file.name}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--text-secondary)", fontFamily: "monospace", fontSize: "12px" }}>
                      {file.type === "dir" ? "—" : formatBytes(file.size)}
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--text-secondary)", fontSize: "12px" }}>
                      {new Date(file.mtime * 1000).toLocaleString()}
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "4px", justifyContent: "flex-end" }} onClick={e => e.stopPropagation()}>
                        {/* Download (files only) */}
                        {file.type === "file" && (
                          <button
                            title={t("sftpDownload")}
                            onClick={() => handleDownload(file)}
                            style={{
                              background: "rgba(0,242,254,0.08)", border: "1px solid rgba(0,242,254,0.2)",
                              color: "#00f2fe", borderRadius: "5px", padding: "4px 8px",
                              fontSize: "11px", cursor: "pointer", transition: "all 0.2s"
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = "rgba(0,242,254,0.18)")}
                            onMouseLeave={e => (e.currentTarget.style.background = "rgba(0,242,254,0.08)")}
                          >
                            ⬇ {t("sftpDownload")}
                          </button>
                        )}
                        {/* Rename */}
                        <button
                          title={t("sftpRename")}
                          onClick={() => { setRenameTarget(file); setRenameValue(file.name); }}
                          style={{
                            background: "rgba(247,151,30,0.08)", border: "1px solid rgba(247,151,30,0.2)",
                            color: "#f7971e", borderRadius: "5px", padding: "4px 8px",
                            fontSize: "11px", cursor: "pointer", transition: "all 0.2s"
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = "rgba(247,151,30,0.18)")}
                          onMouseLeave={e => (e.currentTarget.style.background = "rgba(247,151,30,0.08)")}
                        >
                          ✏ {t("sftpRename")}
                        </button>
                        {/* Delete */}
                        <button
                          title={t("sftpDelete")}
                          onClick={() => handleDelete(file)}
                          style={{
                            background: "rgba(245,87,108,0.08)", border: "1px solid rgba(245,87,108,0.2)",
                            color: "var(--accent-pink)", borderRadius: "5px", padding: "4px 8px",
                            fontSize: "11px", cursor: "pointer", transition: "all 0.2s"
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = "rgba(245,87,108,0.18)")}
                          onMouseLeave={e => (e.currentTarget.style.background = "rgba(245,87,108,0.08)")}
                        >
                          🗑 {t("sftpDelete")}
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

// ======== VIEW 3: Kubernetes View ========

interface K8sViewProps {
  sessionId: string;
  lang: Language;
}

interface PodInfo {
  namespace: string;
  name: string;
  status: string;
  container?: string;
}

function K8sView({ sessionId, lang }: K8sViewProps) {
  const [ns, setNs] = useState("default");
  const [pods, setPods] = useState<PodInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPodForLogs, setSelectedPodForLogs] = useState<PodInfo | null>(null);
  const [logsText, setLogsText] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);

  // Arthas state
  const [selectedPodForArthas, setSelectedPodForArthas] = useState<PodInfo | null>(null);
  const [arthasCmd, setArthasCmd] = useState("thread -n 3");
  const [arthasOutput, setArthasOutput] = useState("");
  const [arthasLoading, setArthasLoading] = useState(false);
  const [arthasVersion, setArthasVersion] = useState("");
  const [jdkVersion, setJdkVersion] = useState("");

  const t = (key: keyof typeof translations["en"]): string => {
    return translations[lang][key] || translations["en"][key] || "";
  };

  const loadPods = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/k8s/pods?namespace=${encodeURIComponent(ns)}`);
      const data = await res.json();
      if (!data.isError && data.content && data.content[0]) {
        // Parse Kubectl output table
        const text = data.content[0].text;
        const lines = text.trim().split("\n");
        const list: PodInfo[] = [];
        
        // Simple line parser for kubectl get pods output
        const hasNamespace = lines[0]?.startsWith("NAMESPACE");
        
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(/\s+/).filter(Boolean);
          if (cols.length >= 3) {
            list.push({
              namespace: hasNamespace ? cols[0] : ns,
              name: hasNamespace ? cols[1] : cols[0],
              status: hasNamespace ? cols[3] : cols[2]
            });
          }
        }
        setPods(list);
      }
    } catch (e) {
      console.error("Failed to load Pods:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPods();
  }, [sessionId, ns]);

  const loadLogs = async (pod: PodInfo) => {
    setSelectedPodForLogs(pod);
    setLogsLoading(true);
    setLogsText("");
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/k8s/logs?namespace=${encodeURIComponent(pod.namespace)}&pod=${encodeURIComponent(pod.name)}&tail=50`);
      const data = await res.json();
      if (data.content && data.content[0]) {
        setLogsText(data.content[0].text);
      }
    } catch (e) {
      setLogsText(`Failed to load logs: ${e}`);
    } finally {
      setLogsLoading(false);
    }
  };

  const handleRunArthas = async () => {
    if (!selectedPodForArthas) return;
    setArthasLoading(true);
    setArthasOutput("Attaching and executing Arthas command, please wait...");
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/k8s/arthas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          namespace: selectedPodForArthas.namespace,
          pod: selectedPodForArthas.name,
          command: arthasCmd,
          arthasVersion,
          jdkVersion
        })
      });
      const data = await res.json();
      if (data.content && data.content[0]) {
        setArthasOutput(data.content[0].text);
      }
    } catch (e) {
      setArthasOutput(`Arthas Error: ${e}`);
    } finally {
      setArthasLoading(false);
    }
  };

  return (
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h2 style={{ fontSize: "20px", fontWeight: 600, margin: 0 }}>{t("tabK8s")}</h2>
        
        {/* Namespace Select */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span style={{ fontSize: "14px", color: "var(--text-secondary)" }}>{t("namespace")}:</span>
          <select
            value={ns}
            onChange={(e) => setNs(e.target.value)}
            style={{
              background: "rgba(0,0,0,0.3)",
              border: "1px solid var(--panel-border)",
              color: "var(--text-primary)",
              borderRadius: "6px",
              padding: "4px 10px",
              fontSize: "13px"
            }}
          >
            <option value="default">default</option>
            <option value="kube-system">kube-system</option>
            <option value="all">All Namespaces</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", gap: "24px", flex: 1, overflow: "hidden" }}>
        
        {/* Left: Pod List Table */}
        <div className="glass-panel" style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
          {loading ? (
            <div style={{ padding: "40px", textAlign: "center", color: "var(--text-secondary)" }}>Loading Pods...</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--panel-border)", color: "var(--text-secondary)" }}>
                  <th style={{ padding: "12px" }}>Name</th>
                  <th style={{ padding: "12px" }}>Namespace</th>
                  <th style={{ padding: "12px" }}>Status</th>
                  <th style={{ padding: "12px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pods.map((pod, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid rgba(255,255,255,0.02)" }}>
                    <td style={{ padding: "12px", fontWeight: 500, fontFamily: "monospace" }}>{pod.name}</td>
                    <td style={{ padding: "12px", color: "var(--text-secondary)" }}>{pod.namespace}</td>
                    <td style={{ padding: "12px" }}>
                      <span style={{
                        padding: "2px 8px",
                        borderRadius: "4px",
                        fontSize: "11px",
                        background: pod.status === "Running" ? "rgba(0, 255, 136, 0.1)" : "rgba(245, 87, 108, 0.1)",
                        color: pod.status === "Running" ? "var(--accent-neon)" : "var(--accent-pink)"
                      }}>
                        {pod.status}
                      </span>
                    </td>
                    <td style={{ padding: "12px", display: "flex", gap: "8px" }}>
                      <button
                        onClick={() => loadLogs(pod)}
                        style={{
                          background: "rgba(0, 242, 254, 0.1)",
                          border: "1px solid rgba(0, 242, 254, 0.3)",
                          color: "var(--accent-blue)",
                          borderRadius: "4px",
                          padding: "3px 8px",
                          fontSize: "12px",
                          cursor: "pointer"
                        }}
                      >
                        {t("viewLogs")}
                      </button>
                      <button
                        onClick={() => {
                          setSelectedPodForArthas(pod);
                          setArthasOutput("");
                        }}
                        style={{
                          background: "rgba(168, 85, 247, 0.1)",
                          border: "1px solid rgba(168, 85, 247, 0.3)",
                          color: "var(--accent-pink)",
                          borderRadius: "4px",
                          padding: "3px 8px",
                          fontSize: "12px",
                          cursor: "pointer"
                        }}
                      >
                        {t("attachArthas")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Right Panel: Logs or Arthas Console */}
        <div style={{ width: "450px", display: "flex", flexDirection: "column", gap: "16px" }}>
          
          {/* Logs Terminal view */}
          {selectedPodForLogs && (
            <div className="glass-panel" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--panel-border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "14px", fontWeight: 600 }}>{t("k8sLogsTitle")} ({selectedPodForLogs.name.substring(0, 12)}...)</span>
                <button
                  onClick={() => setSelectedPodForLogs(null)}
                  style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
                >
                  ✕
                </button>
              </div>
              <div style={{ flex: 1, background: "#000", padding: "12px", overflowY: "auto", fontFamily: "monospace", fontSize: "12px", whiteSpace: "pre-wrap" }}>
                {logsLoading ? "Streaming Logs..." : logsText}
              </div>
            </div>
          )}

          {/* Arthas Diagnostic Modal/Panel */}
          {selectedPodForArthas && (
            <div className="glass-panel" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--panel-border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "14px", fontWeight: 600 }}>{t("arthasDiagTitle")}</span>
                <button
                  onClick={() => setSelectedPodForArthas(null)}
                  style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
                >
                  ✕
                </button>
              </div>
              <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px", flex: 1, overflow: "hidden" }}>
                <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                  Target: <code style={{ color: "var(--accent-blue)" }}>{selectedPodForArthas.name}</code>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="text"
                    value={arthasCmd}
                    onChange={(e) => setArthasCmd(e.target.value)}
                    placeholder={t("arthasCmdPlaceholder")}
                    style={{
                      flex: 1,
                      background: "rgba(0,0,0,0.5)",
                      border: "1px solid var(--panel-border)",
                      color: "var(--text-primary)",
                      borderRadius: "6px",
                      padding: "8px 12px",
                      fontSize: "13px"
                    }}
                  />
                  <button
                    className="glow-btn"
                    onClick={handleRunArthas}
                    disabled={arthasLoading}
                    style={{
                      padding: "8px 16px",
                      borderRadius: "6px",
                      fontSize: "13px"
                    }}
                  >
                    {t("arthasRunBtn")}
                  </button>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="text"
                    value={arthasVersion}
                    onChange={(e) => setArthasVersion(e.target.value)}
                    placeholder={t("arthasVersionPlaceholder")}
                    style={{
                      flex: 1,
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid var(--panel-border)",
                      color: "var(--text-primary)",
                      borderRadius: "6px",
                      padding: "6px 10px",
                      fontSize: "12px"
                    }}
                  />
                  <input
                    type="text"
                    value={jdkVersion}
                    onChange={(e) => setJdkVersion(e.target.value)}
                    placeholder={t("jdkVersionPlaceholder")}
                    style={{
                      flex: 1,
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid var(--panel-border)",
                      color: "var(--text-primary)",
                      borderRadius: "6px",
                      padding: "6px 10px",
                      fontSize: "12px"
                    }}
                  />
                </div>
                {/* Console Output box */}
                <div style={{ flex: 1, background: "#000", borderRadius: "6px", padding: "12px", fontFamily: "monospace", fontSize: "12px", overflowY: "auto", whiteSpace: "pre-wrap", color: "var(--accent-neon)" }}>
                  {arthasOutput}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
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
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box", overflow: "hidden" }}>
      <h2 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "16px" }}>{t("tabMonitor")}</h2>

      <div style={{ display: "flex", gap: "24px", flex: 1, overflow: "hidden" }}>
        
        {/* Left: Sysinfo Text Panel */}
        <div className="glass-panel" style={{ flex: 1, padding: "20px", display: "flex", flexDirection: "column" }}>
          <h3 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "12px", color: "var(--accent-blue)" }}>
            {t("sysLoad")}
          </h3>
          <div style={{ flex: 1, background: "rgba(0,0,0,0.2)", borderRadius: "8px", padding: "16px", fontFamily: "monospace", fontSize: "13px", whiteSpace: "pre-wrap", overflowY: "auto", border: "1px solid rgba(255,255,255,0.02)" }}>
            {loading && !sysinfo ? "Loading diagnostics..." : sysinfo}
          </div>
        </div>

        {/* Right: Active processes table */}
        <div className="glass-panel" style={{ flex: 1, padding: "20px", display: "flex", flexDirection: "column" }}>
          <h3 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "12px", color: "var(--accent-blue)" }}>
            {t("processes")}
          </h3>
          <div style={{ flex: 1, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--panel-border)", color: "var(--text-secondary)" }}>
                  <th style={{ padding: "8px" }}>PID</th>
                  <th style={{ padding: "8px" }}>CPU%</th>
                  <th style={{ padding: "8px" }}>MEM%</th>
                  <th style={{ padding: "8px" }}>Command</th>
                </tr>
              </thead>
              <tbody>
                {processes.map((proc, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid rgba(255,255,255,0.01)" }}>
                    <td style={{ padding: "8px", fontFamily: "monospace" }}>{proc.pid}</td>
                    <td style={{ padding: "8px", color: "var(--accent-neon)", fontWeight: 600 }}>{proc.cpu}%</td>
                    <td style={{ padding: "8px", color: "var(--accent-blue)" }}>{proc.mem}%</td>
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
