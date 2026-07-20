import { useEffect, useRef, useState } from "react";
import { translations } from "./i18n";
import type { Language } from "./i18n";

const API_BASE = "";

interface SftpFile {
  name: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mode: string;
  mtime: number;
  linkTarget?: string;
}

interface SftpViewProps {
  sessionId: string;
  lang: Language;
}

export function SftpView({ sessionId, lang, onOpenFile }: SftpViewProps & { onOpenFile?: (path: string) => void }) {
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

  const folderCount = files.filter(file => file.type === "dir").length;
  const fileCount = files.length - folderCount;
  const selectedFilePath = selectedFile ? `${path.endsWith("/") ? path : `${path}/`}${selectedFile.name}` : "";

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

  const handleRowDoubleClick = (file: SftpFile) => {
    if (file.type === "dir") {
      const slash = path.endsWith("/") ? "" : "/";
      loadFiles(`${path}${slash}${file.name}`);
    } else if (file.type === "file" || file.type === "symlink") {
      if (onOpenFile) onOpenFile(path === "/" ? `/${file.name}` : `${path}/${file.name}`);
    }
  };

  const handleRowClick = (file: SftpFile) => {
    setSelectedFile(prev => prev?.name === file.name ? null : file);
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
    <div className="sftp-page">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: "16px", fontWeight: 600, margin: 0, color: "hsl(var(--foreground))" }}>
          📂 {t("sftpTitle")}
        </h2>
        <div className="sftp-summary">
          {files.length} {t("sftpItemsSummary")} · {folderCount} {t("sftpFolderCount")} · {fileCount} {t("sftpFileCount")}
          {selectedFile && <> · {t("sftpSelected")}: {selectedFilePath}</>}
        </div>
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
      <div className="sftp-toolbar shadcn-card" style={{ padding: "8px 12px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", borderRadius: "6px" }}>
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
      <div className="sftp-table-card shadcn-card" style={{ flex: 1, overflowY: "auto", padding: "4px" }}>
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
          <table className="sftp-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <th style={{ padding: "10px 12px" }}>{t("fileName")}</th>
                <th style={{ padding: "10px 12px", width: "90px" }}>{t("fileType")}</th>
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
                    onDoubleClick={() => handleRowDoubleClick(file)}
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
                    <td style={{ padding: "10px 12px", color: "hsl(var(--muted-foreground))", fontSize: "12px" }}>
                      {file.type === "dir" ? t("sftpDirectory") : file.type === "symlink" ? t("sftpSymlink") : t("sftpFile")}
                    </td>
                    <td style={{ padding: "10px 12px", color: "hsl(var(--muted-foreground))", fontFamily: "monospace", fontSize: "12px" }}>
                      {file.type === "dir" ? "—" : formatBytes(file.size)}
                    </td>
                    <td style={{ padding: "10px 12px", color: "hsl(var(--muted-foreground))", fontSize: "12px" }}>
                      {new Date(file.mtime * 1000).toLocaleString()}
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", alignItems: "center" }} onClick={e => e.stopPropagation()}>
                        {/* Edit (files and symlinks) */}
                        {(file.type === "file" || file.type === "symlink") && (
                          <button
                            title={t("sftpEdit")}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onOpenFile) {
                                onOpenFile(path === "/" ? `/${file.name}` : `${path}/${file.name}`);
                              }
                            }}
                            className="shadcn-btn shadcn-btn-underline"
                          >
                            ✎ {t("sftpEdit")}
                          </button>
                        )}
                        {/* Download (files and symlinks) */}
                        {(file.type === "file" || file.type === "symlink") && (
                          <button
                            title={t("sftpDownload")}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownload(file);
                            }}
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
