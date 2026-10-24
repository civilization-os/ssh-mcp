import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle2, Download, Globe2, RefreshCw, RotateCcw, Settings, X } from "lucide-react";
import type { Language } from "./i18n";

interface DesktopSettingsControlProps {
  collapsed: boolean;
  lang: Language;
}

const DEFAULT_SETTINGS: SshMcpApplicationSettings = {
  proxy: {
    mode: "system",
    url: "",
    bypassRules: "",
    username: "",
    password: "",
    hasPassword: false,
    clearPassword: false,
  },
  autoCheckUpdates: true,
};

const DEFAULT_UPDATE: SshMcpUpdateState = {
  phase: "idle",
  currentVersion: "",
  availableVersion: null,
  releaseName: null,
  releaseNotes: null,
  releaseDate: null,
  percent: null,
  transferred: null,
  total: null,
  bytesPerSecond: null,
  message: "",
};

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function ReleaseNotesView({ notes }: { notes: string }) {
  const isHtml = /<\/?[a-z][\s\S]*>/i.test(notes);

  if (isHtml) {
    const cleanHtml = notes
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "")
      .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
      .replace(/on\w+="[^"]*"/gi, "")
      .replace(/on\w+='[^']*'/gi, "");

    return (
      <div
        className="desktop-release-notes-content"
        dangerouslySetInnerHTML={{ __html: cleanHtml }}
      />
    );
  }

  return (
    <div className="desktop-release-notes-content">
      <pre>{notes}</pre>
    </div>
  );
}

function phaseLabel(phase: SshMcpUpdatePhase, lang: Language): string {
  const labels: Record<SshMcpUpdatePhase, [string, string]> = {
    idle: ["尚未检查", "Not checked"],
    checking: ["正在检查", "Checking"],
    available: ["发现新版本", "Update available"],
    downloading: ["正在下载", "Downloading"],
    downloaded: ["等待安装", "Ready to install"],
    "up-to-date": ["已是最新版", "Up to date"],
    "not-published": ["更新通道待发布", "Update channel pending"],
    error: ["检查失败", "Check failed"],
    unsupported: ["开发模式", "Development build"],
  };
  return labels[phase][lang === "zh" ? 0 : 1];
}

export function DesktopSettingsControl({ collapsed, lang }: DesktopSettingsControlProps) {
  const api = window.sshMcpDesktop;
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<SshMcpApplicationSettings>(DEFAULT_SETTINGS);
  const [proxyDraft, setProxyDraft] = useState<SshMcpProxySettings>(DEFAULT_SETTINGS.proxy);
  const [update, setUpdate] = useState<SshMcpUpdateState>(DEFAULT_UPDATE);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener("open-desktop-settings", handleOpen);
    return () => window.removeEventListener("open-desktop-settings", handleOpen);
  }, []);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    void Promise.all([api.getSettings(), api.getUpdateState()]).then(([nextSettings, nextUpdate]) => {
      if (disposed) return;
      setSettings(nextSettings);
      setProxyDraft(nextSettings.proxy);
      setUpdate(nextUpdate);
    }).catch(cause => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    });
    const unsubscribe = api.onUpdateStateChanged(next => {
      if (!disposed) setUpdate(next);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api]);

  if (!api) return null;

  const zh = lang === "zh";
  const saveProxy = async () => {
    setProxyBusy(true);
    setError("");
    try {
      const next = await api.setProxy(proxyDraft);
      setSettings(next);
      setProxyDraft(next.proxy);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProxyBusy(false);
    }
  };

  const setAutoCheck = async (enabled: boolean) => {
    setError("");
    try {
      setSettings(await api.setAutoCheckUpdates(enabled));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const runUpdateAction = async () => {
    setUpdateBusy(true);
    setError("");
    try {
      if (update.phase === "available") {
        setUpdate(await api.downloadUpdate());
      } else if (update.phase === "downloaded") {
        await api.installUpdate();
      } else {
        setUpdate(await api.checkForUpdates());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUpdateBusy(false);
    }
  };

  const actionLabel = update.phase === "available"
    ? (zh ? "下载更新" : "Download update")
    : update.phase === "downloaded"
      ? (zh ? "重启并安装" : "Restart and install")
      : (zh ? "检查更新" : "Check for updates");
  const actionIcon = update.phase === "available"
    ? <Download size={15} />
    : update.phase === "downloaded"
      ? <RotateCcw size={15} />
      : <RefreshCw size={15} className={update.phase === "checking" ? "is-spinning" : ""} />;

  return (
    <>
      <div className={`desktop-settings-entry ${collapsed ? "is-collapsed" : ""}`}>
        <button type="button" onClick={() => setOpen(true)} title={zh ? "应用设置" : "Application settings"}>
          <Settings size={17} />
          {!collapsed && (
            <span>
              <strong>{zh ? "应用设置" : "Application settings"}</strong>
              <small>{zh ? "代理与在线更新" : "Proxy and online updates"}</small>
            </span>
          )}
          {!collapsed && update.phase === "available" && <i>{zh ? "有更新" : "NEW"}</i>}
        </button>
      </div>

      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              className="desktop-settings-backdrop"
              role="presentation"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onMouseDown={event => {
                if (event.currentTarget === event.target) setOpen(false);
              }}
            >
              <motion.section
                className="desktop-settings-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="desktop-settings-title"
                initial={{ opacity: 0, scale: 0.95, y: 14 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 10 }}
                transition={{ type: "spring", damping: 26, stiffness: 360 }}
              >
            <header>
              <div className="desktop-settings-heading">
                <span><Settings size={18} /></span>
                <div>
                  <h2 id="desktop-settings-title">{zh ? "应用设置" : "Application settings"}</h2>
                  <p>{zh ? "管理联网方式与桌面端更新" : "Control networking and Desktop updates"}</p>
                </div>
              </div>
              <button type="button" className="desktop-settings-close" onClick={() => setOpen(false)} aria-label={zh ? "关闭" : "Close"}>
                <X size={18} />
              </button>
            </header>

            <div className="desktop-settings-body">
              <article className="desktop-settings-card">
                <div className="desktop-settings-card-title">
                  <span className="proxy"><Globe2 size={17} /></span>
                  <div>
                    <h3>{zh ? "APP 级代理" : "App proxy"}</h3>
                    <p>{zh ? "用于 GitHub 更新检查、下载和 App 网络请求" : "Used by GitHub update checks, downloads, and App network requests"}</p>
                  </div>
                </div>

                <div className="desktop-proxy-modes" role="radiogroup" aria-label={zh ? "代理模式" : "Proxy mode"}>
                  {([
                    ["system", zh ? "跟随系统" : "System"],
                    ["direct", zh ? "直连" : "Direct"],
                    ["fixed", zh ? "手动代理" : "Manual"],
                  ] as Array<[SshMcpProxyMode, string]>).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={proxyDraft.mode === mode}
                      className={proxyDraft.mode === mode ? "is-active" : ""}
                      onClick={() => setProxyDraft(current => ({ ...current, mode }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {proxyDraft.mode === "fixed" && (
                  <div className="desktop-proxy-fields">
                    <label>
                      <span>{zh ? "代理地址" : "Proxy URL"}</span>
                      <input
                        value={proxyDraft.url}
                        onChange={event => setProxyDraft(current => ({ ...current, url: event.target.value }))}
                        placeholder="http://127.0.0.1:7890"
                        spellCheck={false}
                      />
                      <small>{zh ? "支持 HTTP、HTTPS、SOCKS4 和 SOCKS5" : "Supports HTTP, HTTPS, SOCKS4, and SOCKS5"}</small>
                    </label>
                    <label>
                      <span>{zh ? "绕过规则（可选）" : "Bypass rules (optional)"}</span>
                      <input
                        value={proxyDraft.bypassRules}
                        onChange={event => setProxyDraft(current => ({ ...current, bypassRules: event.target.value }))}
                        placeholder="*.company.local, 10.*"
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      <span>{zh ? "代理用户名（可选）" : "Proxy username (optional)"}</span>
                      <input
                        value={proxyDraft.username}
                        onChange={event => setProxyDraft(current => ({ ...current, username: event.target.value }))}
                        placeholder={zh ? "需要认证时填写" : "Only for authenticated proxies"}
                        autoComplete="username"
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      <span>{zh ? "代理密码（可选）" : "Proxy password (optional)"}</span>
                      <div className="desktop-proxy-secret">
                        <input
                          type="password"
                          value={proxyDraft.password}
                          onChange={event => setProxyDraft(current => ({
                            ...current,
                            password: event.target.value,
                            clearPassword: false,
                          }))}
                          placeholder={proxyDraft.hasPassword && !proxyDraft.clearPassword
                            ? (zh ? "已安全保存；留空保持不变" : "Saved securely; leave blank to keep")
                            : (zh ? "输入代理密码" : "Enter proxy password")}
                          autoComplete="new-password"
                        />
                        {proxyDraft.hasPassword && !proxyDraft.clearPassword && (
                          <button type="button" onClick={() => setProxyDraft(current => ({
                            ...current,
                            password: "",
                            hasPassword: false,
                            clearPassword: true,
                          }))}>
                            {zh ? "清除" : "Clear"}
                          </button>
                        )}
                      </div>
                      <small>{zh ? "密码由 Windows DPAPI 加密保存，保存后不会回传到页面。" : "Encrypted by Windows DPAPI and never returned to the page after saving."}</small>
                    </label>
                  </div>
                )}

                <div className="desktop-settings-card-footer">
                  <p>{zh ? "本机 MCP 服务始终绕过代理；SSH 目标连接不经过此代理。" : "The local MCP service always bypasses the proxy. SSH target connections are unaffected."}</p>
                  <button type="button" className="desktop-settings-primary" onClick={saveProxy} disabled={proxyBusy}>
                    {proxyBusy ? (zh ? "正在应用…" : "Applying…") : (zh ? "保存并应用" : "Save and apply")}
                  </button>
                </div>
              </article>

              <article className="desktop-settings-card update-card">
                <div className="desktop-settings-card-title">
                  <span className="update"><RefreshCw size={17} /></span>
                  <div>
                    <h3>{zh ? "在线更新" : "Online update"}</h3>
                    <p>{zh ? "从 GitHub Releases 获取正式版本" : "Install stable releases from GitHub Releases"}</p>
                  </div>
                  <em className={`update-phase phase-${update.phase}`}>{phaseLabel(update.phase, lang)}</em>
                </div>

                <div className="desktop-update-version">
                  <div>
                    <span>{zh ? "当前版本" : "Current"}</span>
                    <strong>v{update.currentVersion || "—"}</strong>
                  </div>
                  <div className="version-line" />
                  <div>
                    <span>{zh ? "最新版本" : "Latest"}</span>
                    <strong>{update.availableVersion ? `v${update.availableVersion}` : "—"}</strong>
                  </div>
                </div>

                {update.phase === "downloading" && (
                  <div className="desktop-update-progress">
                    <div><i style={{ width: `${update.percent ?? 0}%` }} /></div>
                    <p>
                      <span>{Math.round(update.percent ?? 0)}%</span>
                      <span>{formatBytes(update.transferred)} / {formatBytes(update.total)} · {formatBytes(update.bytesPerSecond)}/s</span>
                    </p>
                  </div>
                )}

                {update.releaseNotes && (
                  <details className="desktop-release-notes" open>
                    <summary>{zh ? "版本说明" : "Release notes"}</summary>
                    <ReleaseNotesView notes={update.releaseNotes} />
                  </details>
                )}

                {update.message && (
                  <div className={`desktop-update-message ${update.phase === "error" ? "is-error" : ""}`}>
                    {update.phase === "up-to-date" ? <CheckCircle2 size={15} /> : null}
                    <span>{update.phase === "not-published"
                      ? (zh ? "GitHub 尚未发布包含 latest.yml 的 Desktop 正式版本；发布首个版本后即可正常检查。" : "No Desktop release containing latest.yml has been published yet. Update checks will activate after the first release.")
                      : update.message}</span>
                  </div>
                )}

                <div className="desktop-settings-card-footer update-footer">
                  <label className="desktop-auto-update">
                    <input
                      type="checkbox"
                      checked={settings.autoCheckUpdates}
                      onChange={event => void setAutoCheck(event.target.checked)}
                    />
                    <span>{zh ? "启动时自动检查" : "Check automatically at startup"}</span>
                  </label>
                  <button
                    type="button"
                    className="desktop-settings-primary"
                    onClick={runUpdateAction}
                    disabled={updateBusy || update.phase === "checking" || update.phase === "downloading"}
                  >
                    {actionIcon}
                    {actionLabel}
                  </button>
                </div>
              </article>

              {error && <div className="desktop-settings-error" role="alert">{error}</div>}
            </div>
              </motion.section>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
