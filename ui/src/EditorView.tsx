import { useState, useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";

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
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" | "" }>({ msg: "", type: "" });
  const editorRef = useRef<any>(null);

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
      } catch (e: any) {
        if (e.name === "AbortError") return;
        showToast("加载文件失败", "error");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchFile();
    return () => controller.abort();
  }, [sessionId, filePath]);

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    
    // Add Ctrl+S / Cmd+S shortcut
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSave();
    });
  };

  const handleSave = async () => {
    if (!editorRef.current) return;
    const value = editorRef.current.getValue();
    setSaving(true);
    try {
      const formData = new FormData();
      formData.append("path", filePath);
      const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
      formData.append("file", blob, filePath.split('/').pop());

      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/sftp/upload`, {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        showToast("已保存至服务器", "success");
      } else {
        throw new Error("Save failed");
      }
    } catch (e) {
      showToast("保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", backgroundColor: "hsl(var(--card))", borderLeft: "1px solid hsl(var(--border))" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid hsl(var(--border))" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontWeight: 600, fontSize: "13px" }}>📝 {filePath.split("/").pop()}</span>
          <span style={{ fontSize: "11px", color: "hsl(var(--muted-foreground))" }}>{filePath}</span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={handleSave} disabled={loading || saving} className="shadcn-btn shadcn-btn-primary" style={{ padding: "4px 12px", height: "28px", fontSize: "12px" }}>
            {saving ? "保存中..." : "保存 (Ctrl+S)"}
          </button>
          <button onClick={onClose} className="shadcn-btn shadcn-btn-outline" style={{ padding: "4px 8px", height: "28px", fontSize: "12px" }}>
            ✕
          </button>
        </div>
      </div>
      
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
            fontSize: 14,
            fontFamily: "monospace",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            padding: { top: 16 }
          }}
        />
        {loading && (
          <div className="editor-loading-overlay">
            加载中...
          </div>
        )}
      </div>

      {toast.msg && (
        <div style={{
          position: "absolute", bottom: "20px", right: "20px",
          backgroundColor: toast.type === "error" ? "hsl(var(--destructive))" : "#22c55e",
          color: "white", padding: "8px 16px", borderRadius: "6px", fontSize: "13px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)", zIndex: 50,
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
