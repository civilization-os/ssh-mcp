import { useState, useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Save, FileCode, X, Check } from "lucide-react";

interface EditorViewProps {
  sessionId: string;
  filePath: string;
  onClose: () => void;
}

const API_BASE = "";

export function EditorView({ sessionId, filePath, onClose }: EditorViewProps) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" | "" }>({ msg: "", type: "" });
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const initialContentRef = useRef<string>("");

  const showToast = (msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast({ msg: "", type: "" }), 3000);
  };

  useEffect(() => {
    const controller = new AbortController();
    const fetchFile = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/sftp/download?path=${encodeURIComponent(filePath)}`, {
          signal: controller.signal
        });
        if (!res.ok) throw new Error("Failed to load file");
        const text = await res.text();
        setContent(text);
        initialContentRef.current = text;
        setIsDirty(false);
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") return;
        showToast("加载文件失败", "error");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchFile();
    return () => controller.abort();
  }, [sessionId, filePath]);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // Add Ctrl+S / Cmd+S shortcut
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSave();
    });

    // Track content change
    editor.onDidChangeModelContent(() => {
      const val = editor.getValue();
      setIsDirty(val !== initialContentRef.current);
    });
  };

  const handleSave = async () => {
    if (!editorRef.current) return;
    const value = editorRef.current.getValue();
    setSaving(true);
    try {
      const formData = new FormData();
      const fileName = filePath.split("/").pop() || "file";
      const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
      formData.append("file", blob, fileName);

      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/sftp/upload?path=${encodeURIComponent(filePath)}`, {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        initialContentRef.current = value;
        setIsDirty(false);
        showToast("已保存至服务器", "success");
      } else {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Save failed (${res.status})`);
      }
    } catch {
      showToast("保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const fileName = filePath.split("/").pop() || "";
  const linesCount = (editorRef.current?.getValue() ?? content).split("\n").length;
  const charsCount = (editorRef.current?.getValue() ?? content).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", backgroundColor: "#0e1722", borderLeft: "1px solid #1f2d3a", position: "relative" }}>
      {/* Editor Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", borderBottom: "1px solid #1f2d3a", background: "#101923" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          <FileCode size={16} style={{ color: "#38bdf8", flexShrink: 0 }} />
          <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
            <span style={{ fontWeight: 650, fontSize: "13px", color: "#f1f5f9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {fileName}
            </span>
            {isDirty ? (
              <span style={{
                fontSize: "10px",
                padding: "1px 6px",
                borderRadius: "999px",
                background: "rgba(245, 158, 11, 0.15)",
                color: "#fbbf24",
                border: "1px solid rgba(245, 158, 11, 0.3)",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: "3px"
              }}>
                ● 未保存
              </span>
            ) : (
              <span style={{
                fontSize: "10px",
                padding: "1px 6px",
                borderRadius: "999px",
                background: "rgba(16, 185, 129, 0.1)",
                color: "#34d399",
                border: "1px solid rgba(16, 185, 129, 0.2)",
                display: "inline-flex",
                alignItems: "center",
                gap: "2px"
              }}>
                <Check size={10} /> 已同步
              </span>
            )}
          </div>
          <span style={{ fontSize: "11px", color: "#64748b", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={filePath}>
            {filePath}
          </span>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <div style={{ fontSize: "11px", color: "#64748b", fontFamily: "monospace", paddingRight: "4px" }}>
            {linesCount} 行 · {charsCount} 字符
          </div>
          <button
            onClick={handleSave}
            disabled={loading || saving || !isDirty}
            className="shadcn-btn shadcn-btn-primary"
            style={{
              padding: "4px 12px",
              height: "28px",
              fontSize: "11px",
              gap: "5px",
              background: isDirty ? "#0f766e" : "#1e293b",
              borderColor: isDirty ? "#14b8a6" : "#334155",
              color: isDirty ? "#e6fffa" : "#94a3b8",
            }}
            title="快捷键: Ctrl+S"
          >
            <Save size={13} />
            {saving ? "保存中..." : "保存 (Ctrl+S)"}
          </button>
          <button
            onClick={onClose}
            className="shadcn-btn shadcn-btn-ghost"
            style={{ width: "28px", height: "28px", padding: 0, color: "#94a3b8" }}
            title="关闭编辑器"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Editor Body */}
      <div style={{ flex: 1, position: "relative" }}>
        <Editor
          height="100%"
          theme="vs-dark"
          path={filePath}
          value={content}
          loading={null}
          onMount={handleEditorDidMount}
          options={{
            readOnly: loading,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            padding: { top: 12, bottom: 12 },
            lineNumbersMinChars: 3,
            renderLineHighlight: "all",
            smoothScrolling: true,
          }}
        />
        {loading && (
          <div className="editor-loading-overlay">
            加载远程文件中...
          </div>
        )}
      </div>

      {/* Toast Notification */}
      {toast.msg && (
        <div style={{
          position: "absolute", bottom: "18px", right: "18px",
          backgroundColor: toast.type === "error" ? "#ef4444" : "#10b981",
          color: "white", padding: "6px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 500,
          boxShadow: "0 8px 24px rgba(0,0,0,0.3)", zIndex: 50,
          display: "flex", alignItems: "center", gap: "6px",
        }}>
          {toast.type === "success" ? <Check size={14} /> : null}
          {toast.msg}
        </div>
      )}
    </div>
  );
}
