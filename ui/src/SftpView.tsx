import { useCallback, useEffect, useRef, useState } from "react";
import { translations } from "./i18n";
import type { Language } from "./i18n";
import {
  Folder,
  File,
  FileCode,
  FileImage,
  FileArchive,
  FileText,
  Link as LinkIcon,
  ArrowLeft,
  Search,
  UploadCloud,
  FolderPlus,
  RefreshCw,
  Copy,
  Check,
  Pencil,
  Trash2,
  Download,
  ExternalLink,
  X
} from "lucide-react";

const API_BASE = "";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  const [searchQuery, setSearchQuery] = useState("");
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [pathInputValue, setPathInputValue] = useState("");
  const [copiedPath, setCopiedPath] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const t = (key: keyof typeof translations["en"]): string =>
    translations[lang][key] || translations["en"][key] || "";

  const folderCount = files.filter(file => file.type === "dir").length;
  const fileCount = files.length - folderCount;
  const selectedFilePath = selectedFile ? `${path.endsWith("/") ? path : `${path}/`}${selectedFile.name}` : "";

  const showStatus = useCallback((msg: string, type: "success" | "error") => {
    setStatus({ msg, type });
    setTimeout(() => setStatus({ msg: "", type: "" }), 3500);
  }, []);

  const loadFiles = useCallback(async (targetPath: string) => {
    setLoading(true);
    setSelectedFile(null);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/sftp/list?path=${encodeURIComponent(targetPath)}`);
      const data = await res.json();
      if (!data.isError && data.content && data.content[0]) {
        const parsedFiles = JSON.parse(data.content[0].text);
        parsedFiles.sort((a: SftpFile, b: SftpFile) => {
          const rank = (type: string) => type === "dir" ? 0 : type === "symlink" ? 1 : 2;
          if (rank(a.type) !== rank(b.type)) return rank(a.type) - rank(b.type);
          return a.name.localeCompare(b.name);
        });
        setFiles(parsedFiles);
        setPath(targetPath);
      } else {
        showStatus(data.content?.[0]?.text || "Failed to load directory", "error");
      }
    } catch {
      showStatus("Network error", "error");
    } finally {
      setLoading(false);
    }
  }, [sessionId, showStatus]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadFiles("/"), 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadFiles]);

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
    } catch (error: unknown) {
      showStatus(`✗ ${errorMessage(error)}`, "error");
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
    } catch (error: unknown) {
      showStatus(`✗ ${errorMessage(error)}`, "error");
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
    } catch (error: unknown) {
      showStatus(`✗ ${errorMessage(error)}`, "error");
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
    } catch (error: unknown) {
      showStatus(`✗ ${errorMessage(error)}`, "error");
    }
  };

  const uploadFileBlob = async (file: globalThis.File) => {
    const remotePath = getFilePath(file.name);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/sftp/upload?path=${encodeURIComponent(remotePath)}`, {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    if (!res.ok || data.isError) {
      throw new Error(data.error || data.content?.[0]?.text || `Upload failed (${res.status})`);
    }
  };

  // Upload file via file picker
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await uploadFileBlob(file);
      showStatus(`✓ ${t("sftpUploadOk")}: ${file.name}`, "success");
      loadFiles(path);
    } catch (error: unknown) {
      showStatus(`✗ ${errorMessage(error)}`, "error");
    } finally {
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  // Drag and drop upload
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    setLoading(true);
    let successCount = 0;
    for (const file of droppedFiles) {
      try {
        await uploadFileBlob(file);
        successCount++;
      } catch (error: unknown) {
        showStatus(`✗ ${file.name}: ${errorMessage(error)}`, "error");
      }
    }
    if (successCount > 0) {
      showStatus(`✓ ${t("sftpUploadOk")} (${successCount})`, "success");
      loadFiles(path);
    } else {
      setLoading(false);
    }
  };

  const handleStartEditPath = () => {
    setPathInputValue(path);
    setIsEditingPath(true);
  };

  const handleJumpPath = () => {
    setIsEditingPath(false);
    const target = pathInputValue.trim();
    if (target && target !== path) {
      loadFiles(target.startsWith("/") ? target : `/${target}`);
    }
  };

  const handleCopyPath = () => {
    const textToCopy = selectedFilePath || path;
    navigator.clipboard.writeText(textToCopy);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const filteredFiles = files.filter(f =>
    searchQuery.trim() === "" || f.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="sftp-page">
      {/* Top Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "hsl(var(--foreground))", display: "flex", alignItems: "center", gap: "8px" }}>
            <Folder size={18} className="text-amber-500" style={{ color: "#f59e0b" }} />
            {t("sftpTitle")}
          </h2>
          <div className="sftp-summary">
            {files.length} {t("sftpItemsSummary")} · {folderCount} {t("sftpFolderCount")} · {fileCount} {t("sftpFileCount")}
            {selectedFile && <> · {t("sftpSelected")}: <code style={{ color: "#2dd4bf", fontWeight: 600 }}>{selectedFile.name}</code></>}
          </div>
        </div>

        {/* Status Toast */}
        {status.msg && (
          <div style={{
            fontSize: "12px",
            fontWeight: 500,
            padding: "6px 14px",
            borderRadius: "6px",
            background: status.type === "success" ? "rgba(45, 212, 191, 0.12)" : "rgba(239, 68, 68, 0.12)",
            border: `1px solid ${status.type === "success" ? "rgba(45, 212, 191, 0.35)" : "rgba(239, 68, 68, 0.35)"}`,
            color: status.type === "success" ? "#2dd4bf" : "#f87171",
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
            animation: "fadeIn 0.2s ease",
          }}>
            {status.msg}
          </div>
        )}
      </div>

      {/* Toolbar & Path Breadcrumb */}
      <div className="sftp-toolbar shadcn-card" style={{ padding: "8px 12px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", borderRadius: "8px" }}>
        {/* Back Button */}
        <button
          onClick={handleBack}
          disabled={path === "/"}
          className="shadcn-btn shadcn-btn-outline"
          style={{ padding: "6px 10px", height: "32px", fontSize: "12px", display: "flex", alignItems: "center", gap: "5px" }}
          title={t("backBtn")}
        >
          <ArrowLeft size={14} />
          <span>{t("backBtn")}</span>
        </button>

        {/* Path Bar: Interactive Breadcrumbs or Text Input */}
        <div style={{ flex: 1, minWidth: "220px", display: "flex", alignItems: "center", gap: "6px" }}>
          {isEditingPath ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "6px" }}>
              <input
                autoFocus
                type="text"
                value={pathInputValue}
                onChange={e => setPathInputValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") handleJumpPath();
                  if (e.key === "Escape") setIsEditingPath(false);
                }}
                onBlur={handleJumpPath}
                placeholder={t("sftpJumpPath")}
                className="shadcn-input"
                style={{ flex: 1, height: "32px", padding: "4px 10px", fontFamily: "monospace", fontSize: "12px", background: "#131e29", color: "#f8fafc", border: "1px solid #243342" }}
              />
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                fontFamily: "monospace",
                fontSize: "12px",
                padding: "4px 10px",
                display: "flex",
                alignItems: "center",
                gap: "2px",
                overflowX: "auto",
                whiteSpace: "nowrap",
                cursor: "pointer",
                borderRadius: "6px",
                background: "#131e29",
                border: "1px solid #243342"
              }}
              title={lang === "zh" ? "点击编辑或跳转路径" : "Click to edit path directly"}
              onClick={handleStartEditPath}
            >
              <span style={{ color: "#2dd4bf", fontWeight: 700 }}>/</span>
              {path.replace(/^\//, "").split("/").filter(Boolean).map((seg, i, arr) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center" }}>
                  <span
                    style={{
                      color: i === arr.length - 1 ? "#f8fafc" : "#94a3b8",
                      fontWeight: i === arr.length - 1 ? 600 : 400,
                      padding: "1px 4px",
                      borderRadius: "4px",
                      cursor: "pointer"
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const newPath = "/" + arr.slice(0, i + 1).join("/");
                      loadFiles(newPath);
                    }}
                  >
                    {seg}
                  </span>
                  {i < arr.length - 1 && <span style={{ color: "#475569", margin: "0 2px" }}>/</span>}
                </span>
              ))}
            </div>
          )}

          {/* Copy path button */}
          <button
            onClick={handleCopyPath}
            className="shadcn-btn shadcn-btn-ghost"
            style={{ width: "28px", height: "28px", padding: 0, color: "#94a3b8" }}
            title={copiedPath ? t("sftpCopied") : t("sftpCopyPath")}
          >
            {copiedPath ? <Check size={13} style={{ color: "#2dd4bf" }} /> : <Copy size={13} />}
          </button>
        </div>

        {/* Search / Filter box */}
        <div style={{ position: "relative", width: "180px" }}>
          <Search size={13} style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8" }} />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t("sftpSearchPlaceholder")}
            className="shadcn-input"
            style={{ width: "100%", height: "32px", paddingLeft: "28px", paddingRight: searchQuery ? "26px" : "10px", fontSize: "11px", background: "#131e29", color: "#f8fafc", border: "1px solid #243342" }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              style={{ position: "absolute", right: "6px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", padding: "2px" }}
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Toolbar Buttons */}
        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          <button
            onClick={() => { setMkdirMode(true); setMkdirName(""); }}
            className="shadcn-btn shadcn-btn-outline"
            style={{ padding: "6px 11px", height: "32px", fontSize: "12px", display: "flex", alignItems: "center", gap: "5px", background: "#131e29", color: "#cbd5e1", border: "1px solid #243342" }}
          >
            <FolderPlus size={14} />
            <span>{t("sftpMkdir")}</span>
          </button>

          <button
            onClick={() => uploadRef.current?.click()}
            className="shadcn-btn shadcn-btn-primary"
            style={{ padding: "6px 12px", height: "32px", fontSize: "12px", display: "flex", alignItems: "center", gap: "5px", background: "#0f766e", color: "#eafffb", border: "1px solid #14b8a6" }}
          >
            <UploadCloud size={14} />
            <span>{t("sftpUpload")}</span>
          </button>
          <input ref={uploadRef} type="file" style={{ display: "none" }} onChange={handleUpload} />

          <button
            onClick={() => loadFiles(path)}
            className="shadcn-btn shadcn-btn-outline"
            style={{ padding: "6px 10px", height: "32px", fontSize: "12px", display: "flex", alignItems: "center", gap: "5px", background: "#131e29", color: "#cbd5e1", border: "1px solid #243342" }}
            title={t("sftpRefresh")}
          >
            <RefreshCw size={13} className={loading ? "is-spinning" : ""} />
          </button>
        </div>
      </div>

      {/* Mkdir inline input */}
      {mkdirMode && (
        <div className="shadcn-card" style={{ display: "flex", gap: "8px", alignItems: "center", padding: "10px 14px", borderRadius: "8px" }}>
          <FolderPlus size={16} style={{ color: "#f59e0b" }} />
          <input
            autoFocus
            value={mkdirName}
            onChange={e => setMkdirName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleMkdir(); if (e.key === "Escape") setMkdirMode(false); }}
            placeholder={t("sftpMkdirPlaceholder")}
            className="shadcn-input"
            style={{ flex: 1, height: "34px" }}
          />
          <button onClick={handleMkdir} className="shadcn-btn shadcn-btn-primary" style={{ padding: "6px 14px", height: "34px", fontSize: "12px" }}>
            ✓ {t("sftpCreate")}
          </button>
          <button onClick={() => setMkdirMode(false)} className="shadcn-btn shadcn-btn-outline" style={{ padding: "6px 10px", height: "34px" }}>
            ✕
          </button>
        </div>
      )}

      {/* Rename inline input */}
      {renameTarget && (
        <div className="shadcn-card" style={{ display: "flex", gap: "8px", alignItems: "center", padding: "10px 14px", borderRadius: "8px" }}>
          <Pencil size={15} style={{ color: "hsl(var(--primary))" }} />
          <span style={{ fontSize: "12px", color: "hsl(var(--muted-foreground))" }}>
            {t("sftpRenamePrefix")}: <strong style={{ color: "hsl(var(--foreground))" }}>{renameTarget.name}</strong> →
          </span>
          <input
            autoFocus
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleRenameSubmit(); if (e.key === "Escape") setRenameTarget(null); }}
            placeholder={t("sftpNewName")}
            className="shadcn-input"
            style={{ flex: 1, height: "34px" }}
          />
          <button onClick={handleRenameSubmit} className="shadcn-btn shadcn-btn-primary" style={{ padding: "6px 14px", height: "34px", fontSize: "12px" }}>
            ✓ {t("sftpConfirm")}
          </button>
          <button onClick={() => setRenameTarget(null)} className="shadcn-btn shadcn-btn-outline" style={{ padding: "6px 10px", height: "34px" }}>
            ✕
          </button>
        </div>
      )}

      {/* Files Table & Drag Drop Area */}
      <div
        className="sftp-table-card shadcn-card"
        style={{
          flex: 1,
          overflowY: "auto",
          position: "relative",
          borderRadius: "8px",
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleDrop}
      >
        {/* Drag and Drop Overlay */}
        {isDraggingOver && (
          <div style={{
            position: "absolute",
            inset: 0,
            zIndex: 30,
            background: "rgba(15, 23, 42, 0.75)",
            backdropFilter: "blur(4px)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "14px",
            color: "#e8fffb",
            border: "2px dashed #2dd4bf",
            borderRadius: "8px",
          }}>
            <UploadCloud size={48} style={{ color: "#2dd4bf" }} />
            <div style={{ fontSize: "16px", fontWeight: 700 }}>{t("sftpDropZone")}</div>
            <div style={{ fontSize: "12px", opacity: 0.8 }}>{path}</div>
          </div>
        )}

        {loading ? (
          <div style={{ padding: "60px", textAlign: "center", color: "hsl(var(--muted-foreground))" }}>
            <RefreshCw size={26} className="is-spinning" style={{ margin: "0 auto 10px", color: "hsl(var(--muted-foreground))" }} />
            <div style={{ fontSize: "13px" }}>{t("monitorLoadingDiagnostics")}</div>
          </div>
        ) : filteredFiles.length === 0 ? (
          <div style={{ padding: "60px", textAlign: "center", color: "hsl(var(--muted-foreground))" }}>
            <Folder size={36} style={{ margin: "0 auto 10px", opacity: 0.4 }} />
            <div style={{ fontSize: "13px" }}>{searchQuery ? (lang === "zh" ? "没有找到匹配的文件" : "No matching files") : t("sftpEmpty")}</div>
          </div>
        ) : (
          <table className="sftp-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                <th style={{ padding: "10px 14px" }}>{t("fileName")}</th>
                <th style={{ padding: "10px 14px", width: "95px" }}>{t("fileType")}</th>
                <th style={{ padding: "10px 14px", width: "95px" }}>{t("fileSize")}</th>
                <th style={{ padding: "10px 14px", width: "155px" }}>{t("fileTime")}</th>
                <th style={{ padding: "10px 14px", width: "170px", textAlign: "right" }}>{t("sftpActions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredFiles.map((file, idx) => {
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
                      transition: "background-color 0.12s ease"
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.backgroundColor = "hsl(var(--accent) / 0.35)"; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.backgroundColor = "transparent"; }}
                  >
                    <td style={{ padding: "9px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                        <span style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                          {renderFileIcon(file)}
                        </span>
                        <span style={{
                          fontWeight: file.type === "dir" ? 600 : 400,
                          color: file.type === "dir" ? "#d97706" : "hsl(var(--foreground))",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap"
                        }}>
                          {file.name}
                        </span>
                        {file.type === "symlink" && file.linkTarget && (
                          <span style={{ fontSize: "10px", color: "hsl(var(--muted-foreground))", fontFamily: "monospace" }}>
                            → {file.linkTarget}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: "9px 14px", color: "hsl(var(--muted-foreground))", fontSize: "11px" }}>
                      {file.type === "dir" ? t("sftpDirectory") : file.type === "symlink" ? t("sftpSymlink") : t("sftpFile")}
                    </td>
                    <td style={{ padding: "9px 14px", color: "hsl(var(--muted-foreground))", fontFamily: "monospace", fontSize: "11px" }}>
                      {file.type === "dir" ? "—" : formatBytes(file.size)}
                    </td>
                    <td style={{ padding: "9px 14px", color: "hsl(var(--muted-foreground))", fontSize: "11px" }}>
                      {new Date(file.mtime * 1000).toLocaleString()}
                    </td>
                    <td style={{ padding: "6px 14px", textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "4px", justifyContent: "flex-end", alignItems: "center" }} onClick={e => e.stopPropagation()}>
                        {/* Edit file */}
                        {(file.type === "file" || file.type === "symlink") && (
                          <button
                            title={t("sftpEdit")}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onOpenFile) {
                                onOpenFile(path === "/" ? `/${file.name}` : `${path}/${file.name}`);
                              }
                            }}
                            className="shadcn-btn shadcn-btn-ghost"
                            style={{ height: "26px", padding: "0 6px", fontSize: "11px", gap: "3px" }}
                          >
                            <ExternalLink size={12} />
                            <span>{t("sftpEdit")}</span>
                          </button>
                        )}
                        {/* Download file */}
                        {(file.type === "file" || file.type === "symlink") && (
                          <button
                            title={t("sftpDownload")}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownload(file);
                            }}
                            className="shadcn-btn shadcn-btn-ghost"
                            style={{ height: "26px", padding: "0 6px", fontSize: "11px", gap: "3px" }}
                          >
                            <Download size={12} />
                            <span>{t("sftpDownload")}</span>
                          </button>
                        )}
                        {/* Rename */}
                        <button
                          title={t("sftpRename")}
                          onClick={() => { setRenameTarget(file); setRenameValue(file.name); }}
                          className="shadcn-btn shadcn-btn-ghost"
                          style={{ height: "26px", padding: "0 6px", fontSize: "11px", gap: "3px" }}
                        >
                          <Pencil size={12} />
                          <span>{t("sftpRename")}</span>
                        </button>
                        {/* Delete */}
                        <button
                          title={t("sftpDelete")}
                          onClick={() => handleDelete(file)}
                          className="shadcn-btn shadcn-btn-ghost"
                          style={{ height: "26px", padding: "0 6px", fontSize: "11px", color: "hsl(var(--destructive))", gap: "3px" }}
                        >
                          <Trash2 size={12} />
                          <span>{t("sftpDelete")}</span>
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

// Helper: render file icon using Lucide icons
function renderFileIcon(file: SftpFile) {
  if (file.type === "dir") {
    return <Folder size={16} style={{ color: "#f59e0b" }} />;
  }
  if (file.type === "symlink") {
    return <LinkIcon size={15} style={{ color: "#38bdf8" }} />;
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "ts", "tsx", "jsx", "py", "go", "rs", "java", "c", "cpp", "h", "sh", "bash", "html", "css", "json", "yaml", "yml", "toml", "sql"].includes(ext)) {
    return <FileCode size={15} style={{ color: "#3b82f6" }} />;
  }
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) {
    return <FileImage size={15} style={{ color: "#10b981" }} />;
  }
  if (["zip", "tar", "gz", "tgz", "rar", "7z", "bz2"].includes(ext)) {
    return <FileArchive size={15} style={{ color: "#a855f7" }} />;
  }
  if (["md", "txt", "log", "conf", "cfg", "env", "ini"].includes(ext)) {
    return <FileText size={15} style={{ color: "#64748b" }} />;
  }
  return <File size={15} style={{ color: "#94a3b8" }} />;
}

// Helper: format bytes
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
