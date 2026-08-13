import { useEffect, useState, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { EditorView } from "./EditorView";
import { SftpView } from "./SftpView";
// Custom Resizer implemented, removed Allotment
import "allotment/dist/style.css";
import { MonitorView } from "./MonitorView";
import { translations } from "./i18n";
import type { Language } from "./i18n";
import { DesktopSettingsControl } from "./DesktopSettings";
import { McpSetupControl } from "./McpSetup";
import { Activity, ChevronLeft, ChevronRight, FileText, Pencil, Plus, Server, ShieldCheck, TerminalSquare, Trash2 } from "lucide-react";

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

interface SessionPayload {
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}


const API_BASE = "";
const WS_BASE =
  typeof window === "undefined"
    ? "ws://127.0.0.1:12222"
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;

function DesktopTitleBar({ lang, session }: { lang: Language; session: SshSession | null }) {
  const [desktopState, setDesktopState] = useState<SshMcpDesktopState | null>(null);
  const desktopApi = window.sshMcpDesktop;

  useEffect(() => {
    if (!desktopApi) return;
    let disposed = false;
    void desktopApi.getState()
      .then(state => { if (!disposed) setDesktopState(state); })
      .catch(() => {});
    const unsubscribe = desktopApi.onStateChanged(state => {
      if (!disposed) setDesktopState(state);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [desktopApi]);

  if (!desktopApi) return null;

  const mcpLabel = desktopState?.mcpEnabled
    ? (lang === "zh" ? "MCP 已授权" : "MCP allowed")
    : (lang === "zh" ? "MCP 已关闭" : "MCP blocked");
  const contextLabel = session?.label || (lang === "zh" ? "本地控制面" : "Local control plane");
  const contextMeta = session
    ? `${session.username}@${session.host}:${session.port}`
    : (lang === "zh" ? "APP 托管运行时" : "App-managed runtime");

  return (
    <header className="desktop-titlebar">
      <div className="desktop-titlebar-safe-area">
        <div className="desktop-titlebar-brand" translate="no">
          <img src="/icon.svg" alt="" width="18" height="18" />
          <span className="desktop-titlebar-wordmark"><strong>SSH</strong><i>/</i><strong>MCP</strong><em>DESKTOP</em></span>
        </div>
        <span className="desktop-titlebar-divider" aria-hidden="true" />
        <div className={`desktop-titlebar-context ${session?.connected ? "is-online" : ""}`}>
          <span className="desktop-titlebar-context-icon">
            {session ? <Server size={12} aria-hidden="true" /> : <TerminalSquare size={12} aria-hidden="true" />}
          </span>
          <span className="desktop-titlebar-context-copy">
            <strong>{contextLabel}</strong>
            <small>{contextMeta}</small>
          </span>
        </div>
        <div className="desktop-titlebar-runtime">
          {desktopState?.version && <span className="desktop-titlebar-version">v{desktopState.version}</span>}
        <div className={`desktop-titlebar-status ${desktopState?.mcpEnabled ? "is-enabled" : ""}`}>
          <i aria-hidden="true" />
          <span>{mcpLabel}</span>
        </div>
        </div>
      </div>
    </header>
  );
}

function DesktopMcpControl({ collapsed, lang }: { collapsed: boolean; lang: Language }) {
  const [desktopState, setDesktopState] = useState<SshMcpDesktopState | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const desktopApi = window.sshMcpDesktop;
    if (!desktopApi) return;

    let disposed = false;
    void desktopApi.getState()
      .then(state => { if (!disposed) setDesktopState(state); })
      .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    const unsubscribe = desktopApi.onStateChanged(state => {
      if (!disposed) setDesktopState(state);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  if (!window.sshMcpDesktop || !desktopState) return null;

  const toggleMcp = async () => {
    if (updating || desktopState.shuttingDown) return;
    setUpdating(true);
    setError("");
    try {
      setDesktopState(await window.sshMcpDesktop!.setMcpEnabled(!desktopState.mcpEnabled));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUpdating(false);
    }
  };

  const enabledLabel = lang === "zh" ? "MCP 已授权" : "MCP allowed";
  const disabledLabel = lang === "zh" ? "MCP 已阻止" : "MCP blocked";
  const description = lang === "zh"
    ? "控制 Codex、Claude 等 Agent 是否可以使用 SSH 能力"
    : "Controls whether agents can use SSH capabilities";

  return (
    <div className={`desktop-mcp-gate ${collapsed ? "is-collapsed" : ""}`}>
      <button
        type="button"
        role="switch"
        aria-checked={desktopState.mcpEnabled}
        aria-label={desktopState.mcpEnabled ? enabledLabel : disabledLabel}
        className={`desktop-mcp-toggle ${desktopState.mcpEnabled ? "is-enabled" : ""}`}
        disabled={updating || desktopState.shuttingDown}
        onClick={toggleMcp}
        title={collapsed ? `${desktopState.mcpEnabled ? enabledLabel : disabledLabel} — ${description}` : description}
      >
        <span className="desktop-mcp-signal" aria-hidden="true" />
        {!collapsed && (
          <span className="desktop-mcp-copy">
            <strong>{desktopState.mcpEnabled ? enabledLabel : disabledLabel}</strong>
            <small>{updating ? (lang === "zh" ? "正在切换权限…" : "Updating access…") : description}</small>
          </span>
        )}
        {!collapsed && <span className="desktop-mcp-switch" aria-hidden="true"><i /></span>}
      </button>
      {!collapsed && error && <div className="desktop-mcp-error" role="alert">{error}</div>}
    </div>
  );
}



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
      className={`session-card ${isSelected ? "is-selected" : ""}`}
    >
      <div className="session-card-head">
        <span className="session-card-icon"><Server size={15} /></span>
        <div className="session-card-title">
          <strong>{sess.label}</strong>
          <small>{sess.username}@{sess.host}:{sess.port}</small>
        </div>
        <div className="session-card-actions">
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            aria-label={lang === "zh" ? "编辑服务器" : "Edit server"}
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            aria-label={lang === "zh" ? "删除服务器" : "Delete server"}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="session-card-foot" title={sess.connected ? translations[lang].heartbeatTooltip : (lang === "zh" ? "连接已断开，需要重新编辑输入密码/密钥重新连接" : "Connection disconnected, needs credentials to reconnect")}>
        <span className={`session-health ${sess.connected ? "is-online" : ""}`}><i /></span>
        <span>
          {sess.connected ? translations[lang].heartbeatActive + (pingMs != null ? ` (${pingMs}ms)` : "") : (lang === "zh" ? "已断开" : "Disconnected")}
        </span>
        <em>{sess.authType === "privateKey" ? (lang === "zh" ? "KEY" : "KEY") : (lang === "zh" ? "PWD" : "PWD")}</em>
      </div>
    </div>
  );
}

export default function App() {
  const [sessions, setSessions] = useState<SshSession[]>([]);
  const [shells, setShells] = useState<ShellSession[]>([]);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [serverVersion, setServerVersion] = useState<string>("—");
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [activeShellId, setActiveShellId] = useState<string>("");
  
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  
  // Navigation Tabs
  const [activeTab, setActiveTab] = useState<"terminal" | "sftp" | "monitor">("terminal");
  type SecondaryPaneContent = null | { type: "editor"; filePath: string } | { type: "monitor" };
  const [secondaryPane, setSecondaryPane] = useState<SecondaryPaneContent>(null);
  const [splitWidth, setSplitWidth] = useState(50);
  const isDragging = useRef(false);
  
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
      const payload: SessionPayload = {
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
    } catch (err: unknown) {
      console.error(err);
      setConnectError(err instanceof Error ? err.message : "Connection failed");
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
    <>
      <DesktopTitleBar lang={lang} session={sessions.find(session => session.id === selectedSessionId) ?? null} />
      <div className={`app-shell ${window.sshMcpDesktop ? "has-desktop-titlebar" : ""}`}>
      {/* Sidebar */}
      <div 
        className={`command-rail ${sidebarCollapsed ? "is-collapsed" : ""}`}
        style={{ 
          width: sidebarCollapsed ? "68px" : "300px", 
          minWidth: sidebarCollapsed ? "68px" : "300px", 
          display: "flex", 
          flexDirection: "column", 
          height: "100%", 
          overflow: "hidden",
          transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
        }}
      >
        
        {/* Title Bar / Collapse Button */}
        <div className="command-rail-brand" style={{
          padding: sidebarCollapsed ? "12px 0" : "12px 16px",
          display: "flex", 
          alignItems: "center", 
          justifyContent: "center",
          height: "62px",
          boxSizing: "border-box",
          position: "relative",
          width: "100%",
          flexShrink: 0
        }}>
          {/* Inner Title Container */}
          <div className="command-rail-identity" style={{
            position: "absolute",
            left: "16px",
            width: "176px",
            display: "flex",
            alignItems: "center",
            gap: "9px",
            opacity: sidebarCollapsed ? 0 : 1,
            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            pointerEvents: sidebarCollapsed ? "none" : "auto",
            overflow: "hidden",
            whiteSpace: "nowrap"
          }}>
            <span className="rail-workspace-mark"><Activity size={14} aria-hidden="true" /></span>
            <div className="rail-workspace-copy">
              <small>OPERATIONS</small>
              <strong>{lang === "zh" ? "运维工作台" : "Operations workspace"}</strong>
            </div>
          </div>

          {/* Buttons Container */}
          <div className="command-rail-controls" style={{
            position: "absolute",
            right: sidebarCollapsed ? "16px" : "16px",
            display: "flex",
            gap: "6px",
            alignItems: "center",
            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
          }}>
            {!sidebarCollapsed && (
              <button
                onClick={() => setLang(lang === "zh" ? "en" : "zh")}
                className="rail-language"
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
              className="rail-collapse"
              style={{
                width: "36px",
                height: "36px",
                padding: 0,
                fontSize: "12px"
              }}
              title={sidebarCollapsed ? (lang === "zh" ? "展开菜单" : "Expand Menu") : (lang === "zh" ? "收起菜单" : "Collapse Menu")}
            >
              {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          </div>
        </div>

        <DesktopMcpControl collapsed={sidebarCollapsed} lang={lang} />
        <McpSetupControl collapsed={sidebarCollapsed} lang={lang} />
        <DesktopSettingsControl collapsed={sidebarCollapsed} lang={lang} />

        {/* Tab Selection - Upgraded */}
        {selectedSessionId && (
          <div className="rail-navigation" style={{
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
            {([
              { id: "terminal", icon: <TerminalSquare size={16} />, label: t("tabTerminal") },
              { id: "sftp",     icon: <FileText size={16} />, label: t("tabSftp") },
              { id: "monitor",  icon: <Activity size={16} />, label: t("tabMonitor") }
            ] satisfies Array<{ id: "terminal" | "sftp" | "monitor"; icon: React.ReactNode; label: string }>).map(tab => {
              const isActive = activeTab === tab.id;
              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  title={sidebarCollapsed ? tab.label : undefined}
                  className={`rail-nav-item ${isActive ? "is-active" : ""}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "8px 12px",
                    width: sidebarCollapsed ? "40px" : "260px",
                    height: "36px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: isActive ? 600 : 500,
                    position: "relative",
                    border: "none",
                    justifyContent: "flex-start",
                    overflow: "hidden",
                    whiteSpace: "nowrap"
                  }}
                >
                  <div style={{ 
                    display: "flex", 
                    alignItems: "center", 
                    justifyContent: "center",
                    width: "16px",
                    flexShrink: 0,
                  }}>
                    {tab.icon}
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
        <div className="rail-content" style={{
          flex: 1, 
          overflow: "hidden", 
          opacity: sidebarCollapsed ? 0 : 1,
          width: sidebarCollapsed ? "0px" : "300px",
          transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
          pointerEvents: sidebarCollapsed ? "none" : "auto"
        }}>
          <div className="rail-scroll" style={{ width: "300px", padding: "16px 12px", height: "100%", overflowY: "auto", boxSizing: "border-box" }}>
          <div className="rail-section-heading">
            <div>
              {t("sessionsTitle")} ({sessions.length})
            </div>
            <button
              onClick={openCreateModal}
              className="rail-add-button"
              style={{
                width: "24px",
                height: "24px",
                padding: 0,
                fontSize: "12px",
              }}
              title={t("connectNewSession")}
            >
              <Plus size={14} />
            </button>
          </div>
          
          {sessions.length === 0 ? (
            <div className="rail-empty-state">
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
            <div className="rail-terminal-section">
              <div className="rail-section-heading">
                <div>
                  {t("terminalsTitle")}
                </div>
                <button
                  className="rail-new-shell"
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
                <div className="rail-empty-state is-compact">
                  {t("noTerminals")}
                </div>
              ) : (
                filteredShells.map((sh) => (
                  <div
                    key={sh.id}
                    onClick={() => setActiveShellId(sh.id)}
                    className={activeShellId === sh.id ? "shell-list-item active" : "shell-list-item"}
                  >
                    <div className="shell-list-main">
                      <div className={sh.closed ? "shell-list-dot closed" : "shell-list-dot"} />
                      <div className="shell-list-text">
                        <span>{t("terminalShell")} {sh.id.substring(3, 13)}</span>
                        <small>{t("terminalAge")}: {sh.age}s{sh.keepAlive ? " - " + t("terminalKeepAlive") : ""}</small>
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleCloseShell(sh.id); }}
                      title={lang === "zh" ? "关闭此终端" : "Close terminal"}
                      className="shadcn-btn shadcn-btn-ghost shell-close-btn"
                    >
                      x
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Version Footer inside scrollable area */}
          <div className="rail-version" style={{
            marginTop: "24px",
            paddingTop: "12px",
            fontSize: "11px",
            textAlign: "center",
            fontFamily: "monospace"
          }}>
            ssh-mcp v{serverVersion}
          </div>
          </div>
        </div>
      </div>

      {/* Main Panel */}
      <div className="workspace-panel">
        {!selectedSessionId ? (
          <div className="workspace-empty">
            <div className="workspace-empty-copy">
              <span className="workspace-kicker">AI OPERATIONS BRIDGE</span>
              <h2>{lang === "zh" ? "让 AI 操作，人在终端中掌舵。" : "Let AI operate. Keep a human at the helm."}</h2>
              <p>{lang === "zh"
                ? "SSH-MCP 把 Agent、真实 PTY 与人工控制放在同一个可观察工作区。连接服务器后，AI 与你看到的是同一块终端。"
                : "SSH-MCP brings agents, a real PTY, and human control into one observable workspace. You and the AI see the same terminal."}</p>
              <div className="workspace-empty-actions">
                <button className="workspace-primary-action" onClick={openCreateModal}><Plus size={17} />{t("connectNewSession")}</button>
                <span><i />{lang === "zh" ? "本地优先 · APP 授权 · 随时接管" : "Local-first · App-gated · Human takeover"}</span>
              </div>
            </div>
            <div className="workspace-flow-card" aria-label={lang === "zh" ? "连接流程" : "Connection flow"}>
              <header><span>CONTROL PATH</span><em>LOCAL</em></header>
              <div><i>01</i><span><strong>AI CLIENT</strong><small>Claude · Codex · Cursor</small></span><b>CONFIG</b></div>
              <div><i>02</i><span><strong>DESKTOP GATE</strong><small>{lang === "zh" ? "由你决定是否授权" : "You control authorization"}</small></span><b>MCP</b></div>
              <div><i>03</i><span><strong>SHARED PTY</strong><small>{lang === "zh" ? "AI 与人工共享终端" : "One terminal, shared control"}</small></span><b>SSH</b></div>
              <footer><ShieldCheck size={15} />{lang === "zh" ? "关闭 APP 即关闭全部能力" : "Close the App to stop every process"}</footer>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            <SelectedSessionView
              session={sessions.find((s) => s.id === selectedSessionId) ?? null}
              lang={lang}
              onEdit={openEditModal}
            />
            <div 
              style={{ flex: 1, position: "relative", overflow: "hidden", width: "100%", display: "flex" }}
              onMouseMove={(e) => {
                if (!isDragging.current) return;
                const container = e.currentTarget;
                const rect = container.getBoundingClientRect();
                const newWidth = ((e.clientX - rect.left) / rect.width) * 100;
                setSplitWidth(Math.max(10, Math.min(90, newWidth)));
              }}
              onMouseUp={() => isDragging.current = false}
              onMouseLeave={() => isDragging.current = false}
            >
              <div style={{ width: secondaryPane ? `${splitWidth}%` : "100%", height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", overflow: "hidden", position: "relative" }}>
                  <div style={{ display: activeTab === "terminal" ? "flex" : "none", flex: 1, height: "100%", width: "100%", overflow: "hidden" }}>
                    {activeShellId ? (
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
                    )}
                  </div>
                  <div style={{ display: activeTab === "sftp" ? "flex" : "none", flex: 1, height: "100%", width: "100%", overflow: "hidden" }}>
                    <SftpView sessionId={selectedSessionId} lang={lang} onOpenFile={(path: string) => setSecondaryPane({ type: "editor", filePath: path })} />
                  </div>
                  <div style={{ display: activeTab === "monitor" ? "flex" : "none", flex: 1, height: "100%", width: "100%", overflow: "hidden" }}>
                    <MonitorView sessionId={selectedSessionId} lang={lang} />
                  </div>
                </div>
              </div>

              {secondaryPane && (
                <>
                  <div 
                    style={{ 
                      width: "4px", 
                      height: "100%", 
                      cursor: "col-resize", 
                      backgroundColor: "transparent",
                      zIndex: 10,
                      position: "relative"
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      isDragging.current = true;
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "hsl(var(--border))"}
                    onMouseLeave={(e) => { if (!isDragging.current) e.currentTarget.style.backgroundColor = "transparent"; }}
                  >
                    {/* Visual line */}
                    <div style={{ width: "1px", height: "100%", margin: "0 auto", backgroundColor: "hsl(var(--border))" }} />
                  </div>
                  <div style={{ width: `calc(${100 - splitWidth}% - 4px)`, height: "100%", overflow: "hidden" }}>
                    {secondaryPane.type === "editor" && (
                      <EditorView sessionId={selectedSessionId} filePath={secondaryPane.filePath || ""} onClose={() => setSecondaryPane(null)} />
                    )}
                    {secondaryPane.type === "monitor" && (
                      <MonitorView sessionId={selectedSessionId} lang={lang} />
                    )}
                  </div>
                </>
              )}
            </div>
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
    </>
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
    <div className="session-context-bar" style={{
      padding: "10px 16px", 
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "20px",
    }}>
      {/* Session Title & Connection Info */}
      <div style={{ display: "flex", alignItems: "center", gap: "14px", flex: 1, minWidth: 0 }}>
        {/* Status Dot */}
        <div className={`context-status ${session.connected ? "is-online" : ""}`}><i /></div>
        
        {/* Session Name */}
        <span className="context-session-name" style={{ flexShrink: 0 }}>
          {session.label}{!session.connected && (lang === "zh" ? " (未连接)" : " (Disconnected)")}
        </span>
        
        <div className="context-divider" />

        {/* Horizontal Info Items */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px", flex: 1, minWidth: 0, overflowX: "auto" }}>
          <InlineInfoItem label={t("hostPort")} value={`${session.username}@${session.host}:${session.port}`} iconType="host" />
          <InlineInfoItem label={t("authStatus")} value={authLabel} iconType="auth" />
        </div>
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('open-monitor', { detail: { sessionId: session.id } }))}
          className="context-action"
          style={{
            padding: '6px 12px',
            fontSize: '12px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
          title={t("tabMonitor")}
        >
          <Activity size={14} /> {t("tabMonitor")}
        </button>
        <button
          onClick={() => onEdit(session)}
          className="context-action"
          style={{
            padding: '6px 12px',
            fontSize: '12px',
            height: '32px',
          }}
        >
          {t("editSession")}
        </button>
      </div>
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
  const autoScrollRef = useRef(true);
  const [isHeartbeating, setIsHeartbeating] = useState<boolean>(false);
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  const [autoScroll, setAutoScroll] = useState(true);
  const [terminalSize, setTerminalSize] = useState({ cols: 0, rows: 0 });

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
      scrollback: 10000,
      theme: {
        background: "#091019",
        foreground: "#d8e2ec",
        cursor: "#5eead4",
        cursorAccent: "#091019",
        selectionBackground: "#1f3f48",
        black: "#0b121b",
        red: "#fb7185",
        green: "#5eead4",
        yellow: "#fbbf24",
        blue: "#7dd3fc",
        magenta: "#c4b5fd",
        cyan: "#67e8f9",
        white: "#e8eef4",
        brightBlack: "#64748b",
      }
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    term.open(containerRef.current);
    fitAddon.fit();
    setTerminalSize({ cols: term.cols, rows: term.rows });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const wsUrl = `${WS_BASE}/ws/shell?shellId=${encodeURIComponent(shellId)}`;
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;
    const syncTerminalSize = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(`\x01RS${term.cols},${term.rows}`);
      }
    };
    socket.onopen = () => {
      setIsSocketConnected(true);
      syncTerminalSize();
    };

    socket.onmessage = (event) => { 
      if (typeof event.data === "string" && event.data === "\x01HB") {
        setIsHeartbeating(true);
        if (hbTimeout) clearTimeout(hbTimeout);
        hbTimeout = setTimeout(() => {
          setIsHeartbeating(false);
        }, 1500);
      } else {
        term.write(event.data);
        if (autoScrollRef.current) term.scrollToBottom();
      }
    };
    socket.onclose = () => {
      setIsSocketConnected(false);
      term.write("\r\n\r\n[WebSocket connection disconnected]\r\n");
    };
    term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });

    const handleResize = () => {
      fitAddon.fit();
      setTerminalSize({ cols: term.cols, rows: term.rows });
      syncTerminalSize();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      if (hbTimeout) clearTimeout(hbTimeout);
      window.removeEventListener("resize", handleResize);
      socket.close();
      term.dispose();
    };
  }, [shellId]);

  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.fontSize = fontSize;
    fitAddonRef.current?.fit();
    setTerminalSize({ cols: terminalRef.current.cols, rows: terminalRef.current.rows });
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(`\x01RS${terminalRef.current.cols},${terminalRef.current.rows}`);
    }
  }, [fontSize]);

  const writeControl = (input: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(input);
  };

  const copyTerminalOutput = async () => {
    const term = terminalRef.current;
    if (!term) return;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    await navigator.clipboard.writeText(lines.join("\n").trimEnd());
  };

  return (
    <div className="terminal-page">
      <div className="terminal-toolbar">
        <div className="terminal-titlebar">
          <div className={isSocketConnected ? "terminal-status-dot online" : "terminal-status-dot offline"} />
          <div>
            <div className="terminal-title">{t("activeTerminal")}: {shellId}</div>
            <div className="terminal-meta">
              {isSocketConnected ? t("wsConnected") : t("wsDisconnected")} - {t("terminalSize")} {terminalSize.cols}x{terminalSize.rows}
            </div>
          </div>
          {isHeartbeating && (
            <div className="terminal-heartbeat">
              <span role="img" aria-label="heartbeat">HB</span> {lang === "zh" ? "心跳" : "Heartbeat"}
            </div>
          )}
        </div>
        <div className="terminal-actions">
          <button onClick={copyTerminalOutput} className="shadcn-btn shadcn-btn-outline terminal-action-btn" title={t("terminalCopyOutput")}>
            {t("terminalCopyOutput")}
          </button>
          <button onClick={() => writeControl("\x03")} className="shadcn-btn shadcn-btn-outline terminal-action-btn" title="Ctrl+C">
            Ctrl+C
          </button>
          <button onClick={() => writeControl("\x04")} className="shadcn-btn shadcn-btn-outline terminal-action-btn" title="Ctrl+D">
            Ctrl+D
          </button>
          <button onClick={() => setFontSize(size => Math.max(11, size - 1))} className="shadcn-btn shadcn-btn-outline terminal-icon-btn" title={t("terminalFontDown")}>
            A-
          </button>
          <button onClick={() => setFontSize(size => Math.min(18, size + 1))} className="shadcn-btn shadcn-btn-outline terminal-icon-btn" title={t("terminalFontUp")}>
            A+
          </button>
          <label className="terminal-toggle" title={t("terminalAutoScroll")}>
            <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
            <span>{t("terminalAutoScroll")}</span>
          </label>
          <button onClick={() => terminalRef.current?.clear()} className="shadcn-btn shadcn-btn-outline terminal-action-btn">
            {t("clear")}
          </button>
        </div>
      </div>

      <div className="terminal-shell-frame">
        <div ref={containerRef} className="terminal-container" />
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
