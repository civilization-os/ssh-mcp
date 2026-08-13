import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, Clipboard, Code2, ExternalLink, PlugZap, ShieldCheck, X } from "lucide-react";
import type { Language } from "./i18n";

type SetupFormat = "json" | "toml";

function jsonConfig(bridgePath: string): string {
  return JSON.stringify({
    mcpServers: {
      "ssh-mcp": { command: bridgePath },
    },
  }, null, 2);
}

function tomlConfig(bridgePath: string): string {
  return `[mcp_servers."ssh-mcp"]\ncommand = ${JSON.stringify(bridgePath)}`;
}

export function McpSetupControl({ collapsed, lang }: { collapsed: boolean; lang: Language }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SshMcpDesktopState | null>(null);
  const [format, setFormat] = useState<SetupFormat>("json");
  const [copied, setCopied] = useState(false);
  const zh = lang === "zh";

  useEffect(() => {
    const desktopApi = window.sshMcpDesktop;
    if (!desktopApi) return;
    let disposed = false;
    void desktopApi.getState()
      .then(value => { if (!disposed) setState(value); })
      .catch(() => { /* The status card remains in its safe, blocked state. */ });
    const unsubscribe = desktopApi.onStateChanged(value => { if (!disposed) setState(value); });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const bridgePath = state?.bridgePath || "C:\\Path\\To\\SSH-MCP Desktop\\ssh-mcp-bridge.cmd";
  const config = useMemo(
    () => format === "json" ? jsonConfig(bridgePath) : tomlConfig(bridgePath),
    [bridgePath, format],
  );

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(config);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = config;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <>
      <div className={`mcp-setup-entry ${collapsed ? "is-collapsed" : ""}`}>
        <button type="button" onClick={() => setOpen(true)} title={zh ? "连接 AI 客户端" : "Connect an AI client"}>
          <PlugZap size={17} />
          {!collapsed && (
            <span>
              <strong>{zh ? "连接 AI" : "Connect AI"}</strong>
              <small>{zh ? "复制 MCP 客户端配置" : "Copy MCP client config"}</small>
            </span>
          )}
          {!collapsed && <kbd>JSON</kbd>}
        </button>
      </div>

      {open && createPortal(
        <div className="mcp-setup-backdrop" role="presentation" onMouseDown={event => {
          if (event.currentTarget === event.target) setOpen(false);
        }}>
          <section className="mcp-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-setup-title">
            <header>
              <div className="mcp-setup-heading">
                <span><Bot size={21} /></span>
                <div>
                  <p>{zh ? "AGENT CONNECTION" : "AGENT CONNECTION"}</p>
                  <h2 id="mcp-setup-title">{zh ? "把 SSH 能力接入你的 AI" : "Connect SSH capabilities to your AI"}</h2>
                </div>
              </div>
              <button type="button" className="mcp-setup-close" onClick={() => setOpen(false)} aria-label={zh ? "关闭" : "Close"}>
                <X size={19} />
              </button>
            </header>

            <div className="mcp-setup-grid">
              <aside>
                <div className={`mcp-setup-status ${state?.mcpEnabled ? "is-ready" : ""}`}>
                  <span><ShieldCheck size={17} /></span>
                  <div>
                    <strong>{state?.mcpEnabled ? (zh ? "MCP 已授权" : "MCP is allowed") : (zh ? "等待 MCP 授权" : "MCP access is blocked")}</strong>
                    <small>{state?.mcpEnabled
                      ? (zh ? "AI 客户端现在可以发现 SSH 工具" : "AI clients can discover SSH tools now")
                      : (zh ? "复制配置后，还需要打开左侧 MCP 开关" : "After configuring, turn on the MCP switch")}</small>
                  </div>
                </div>

                <ol className="mcp-setup-steps">
                  <li><i>01</i><span><strong>{zh ? "复制配置" : "Copy config"}</strong><small>{zh ? "选择客户端需要的格式" : "Choose the format your client uses"}</small></span></li>
                  <li><i>02</i><span><strong>{zh ? "重启 AI 客户端" : "Restart the AI client"}</strong><small>{zh ? "让客户端加载 MCP Server" : "Let it load the MCP server"}</small></span></li>
                  <li><i>03</i><span><strong>{zh ? "保持 APP 开启" : "Keep this App open"}</strong><small>{zh ? "关闭 APP 会终止 MCP 与 SSH 进程" : "Closing it terminates MCP and SSH processes"}</small></span></li>
                </ol>

                <div className="mcp-setup-clients">
                  <span>{zh ? "适用于" : "Works with"}</span>
                  <strong>Claude</strong><strong>Cursor</strong><strong>Windsurf</strong><strong>Codex</strong>
                </div>
              </aside>

              <main>
                <div className="mcp-config-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={format === "json"} className={format === "json" ? "is-active" : ""} onClick={() => setFormat("json")}>
                    <Code2 size={15} /> MCP JSON
                  </button>
                  <button type="button" role="tab" aria-selected={format === "toml"} className={format === "toml" ? "is-active" : ""} onClick={() => setFormat("toml")}>
                    <Code2 size={15} /> Codex TOML
                  </button>
                </div>

                <div className="mcp-config-context">
                  <div>
                    <strong>{format === "json" ? "Claude Desktop · Cursor · Windsurf" : "Codex ~/.codex/config.toml"}</strong>
                    <small>{zh ? "已自动填入当前 APP 的 Bridge 路径" : "Uses this App's installed Bridge path"}</small>
                  </div>
                  <button type="button" onClick={copyConfig}>
                    {copied ? <Check size={15} /> : <Clipboard size={15} />}
                    {copied ? (zh ? "已复制" : "Copied") : (zh ? "复制配置" : "Copy config")}
                  </button>
                </div>

                <pre className="mcp-config-code"><code>{config}</code></pre>

                <div className="mcp-config-note">
                  <ShieldCheck size={17} />
                  <p><strong>{zh ? "APP 是唯一授权入口" : "The App is the authorization boundary"}</strong><span>{zh
                    ? "Bridge 不保存 Token，也不会自行启动后台服务。只有本 APP 正在运行且 MCP 开关打开时，AI 才能使用 SSH 能力。"
                    : "The Bridge stores no token and cannot start the service itself. SSH tools exist only while this App is running and MCP access is enabled."}</span></p>
                </div>

                <a className="mcp-setup-docs" href="https://github.com/civilization-os/ssh-mcp#desktop-mcp-configuration" target="_blank" rel="noreferrer">
                  {zh ? "查看完整配置说明" : "Open full setup guide"}<ExternalLink size={14} />
                </a>
              </main>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
