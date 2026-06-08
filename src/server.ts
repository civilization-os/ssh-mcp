import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { listSessions, disconnectSession } from "./session.js";
import {
  attachWsToShell,
  detachWsFromShell,
  writeInputToShell,
  listActiveShells
} from "./handlers/shell.js";

export function startHttpServer(initialPort: number = 12222) {
  let currentPort = initialPort;
  const maxRetries = 10;
  let retryCount = 0;

  const server = http.createServer(async (req, res) => {
    // ... rest of the handler remains the same ...
    // (I will keep the existing handler code inside this block)
    // Add CORS headers for Vite/frontend development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || "", `http://localhost:${currentPort}`);

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      const sessions = listSessions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }

    if (url.pathname === "/api/sessions" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        try {
          const creds = JSON.parse(body);
          const { createSession } = await import("./session.js");
          const session = await createSession(creds, creds.name);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: session.id,
            label: session.label,
            host: session.host,
            port: session.port,
            username: session.username
          }));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`Error: ${err.message}`);
        }
      });
      return;
    }

    // DELETE /api/sessions/:sessionId
    const sessionDeleteMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)$/);
    if (sessionDeleteMatch && req.method === "DELETE") {
      const sessionId = sessionDeleteMatch[1];
      try {
        const ok = disconnectSession(sessionId);
        if (ok) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, message: `Session ${sessionId} disconnected` }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Session not found" }));
        }
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // DELETE /api/shells/:shellId
    const shellDeleteMatch = url.pathname.match(/^\/api\/shells\/([^\/]+)$/);
    if (shellDeleteMatch && req.method === "DELETE") {
      const shellId = shellDeleteMatch[1];
      try {
        const { handleShellClose } = await import("./handlers/shell.js");
        const result = await handleShellClose({ shellId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: !result.isError }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/shells" && req.method === "GET") {
      const shells = listActiveShells();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(shells));
      return;
    }

    const shellMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/shells$/);
    if (shellMatch && req.method === "POST") {
      const sessionId = shellMatch[1];
      try {
        const { handleShellCreate } = await import("./handlers/shell.js");
        const result = await handleShellCreate({ sessionId });
        res.writeHead(result.isError ? 400 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
      return;
    }

    // ======== SFTP REST Routes ========
    const sftpListMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/sftp\/list$/);
    if (sftpListMatch && req.method === "GET") {
      const sessionId = sftpListMatch[1];
      const path = url.searchParams.get("path") || "/";
      try {
        const { handleListDir } = await import("./handlers/sftp.js");
        const result = await handleListDir({ sessionId, path });
        
        if ((result as any).isError) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }
        
        const lines = result.content[0].text.split("\n").filter(Boolean);
        const filesList = lines.map(line => {
          const isDir = line.startsWith("d");
          const rest = line.substring(11).trim();
          const cols = rest.split(/\s+/);
          const size = parseInt(cols[0], 10);
          const dateStr = `${cols[1]} ${cols[2]}`;
          const name = cols.slice(3).join(" ");
          return {
            name,
            type: isDir ? "dir" : "file",
            size: isNaN(size) ? 0 : size,
            mtime: Math.floor(new Date(dateStr).getTime() / 1000) || 0
          };
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(filesList) }] }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
      return;
    }

    // SFTP DELETE file/dir  DELETE /api/sessions/:id/sftp/delete?path=...
    const sftpDeleteMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/sftp\/delete$/);
    if (sftpDeleteMatch && req.method === "DELETE") {
      const sessionId = sftpDeleteMatch[1];
      const path = url.searchParams.get("path") || "";
      try {
        const { handleDelete } = await import("./handlers/sftp.js");
        const result = await handleDelete({ sessionId, path }) as any;
        res.writeHead(result.isError ? 400 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
      return;
    }

    // SFTP RENAME  POST /api/sessions/:id/sftp/rename  {oldPath, newPath}
    const sftpRenameMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/sftp\/rename$/);
    if (sftpRenameMatch && req.method === "POST") {
      const sessionId = sftpRenameMatch[1];
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", async () => {
        try {
          const { oldPath, newPath } = JSON.parse(body);
          const { handleRename } = await import("./handlers/sftp.js");
          const result = await handleRename({ sessionId, source: oldPath, dest: newPath }) as any;
          res.writeHead(result.isError ? 400 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ isError: true, error: err.message }));
        }
      });
      return;
    }

    // SFTP MKDIR  POST /api/sessions/:id/sftp/mkdir  {path}
    const sftpMkdirMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/sftp\/mkdir$/);
    if (sftpMkdirMatch && req.method === "POST") {
      const sessionId = sftpMkdirMatch[1];
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", async () => {
        try {
          const { path: mkPath } = JSON.parse(body);
          const { handleMkdir } = await import("./handlers/sftp.js");
          const result = await handleMkdir({ sessionId, path: mkPath }) as any;
          res.writeHead(result.isError ? 400 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ isError: true, error: err.message }));
        }
      });
      return;
    }

    // SFTP DOWNLOAD  GET /api/sessions/:id/sftp/download?path=...
    const sftpDownloadMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/sftp\/download$/);
    if (sftpDownloadMatch && req.method === "GET") {
      const sessionId = sftpDownloadMatch[1];
      const filePath = url.searchParams.get("path") || "";
      const fileName = filePath.split("/").pop() || "download";
      try {
        const { handleReadFile } = await import("./handlers/sftp.js");
        const result = await handleReadFile({ sessionId, path: filePath }) as any;
        if (result.isError) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }
        const content = result.content[0].type === "text"
          ? Buffer.from(result.content[0].text, "utf-8")
          : Buffer.from((result.content[0] as any).data, "base64");
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
          "Content-Length": content.length
        });
        res.end(content);
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
      return;
    }

    // SFTP UPLOAD  POST /api/sessions/:id/sftp/upload  multipart/form-data
    const sftpUploadMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/sftp\/upload$/);
    if (sftpUploadMatch && req.method === "POST") {
      const sessionId = sftpUploadMatch[1];
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", async () => {
        try {
          const raw = Buffer.concat(chunks);
          const rawStr = raw.toString("latin1");
          const boundary = (req.headers["content-type"] || "").split("boundary=")[1];
          if (!boundary) throw new Error("No boundary in multipart");

          // Parse multipart manually
          const parts = rawStr.split(`--${boundary}`).filter(p => p !== "--\r\n" && p.trim() !== "" && p !== "--");
          let uploadPath = "";
          let fileBuffer: Buffer | null = null;

          for (const part of parts) {
            const [rawHead, ...bodyParts] = part.split("\r\n\r\n");
            const body = bodyParts.join("\r\n\r\n").replace(/\r\n$/, "");
            if (rawHead.includes("name=\"path\"")) {
              uploadPath = body;
            } else if (rawHead.includes("name=\"file\"")) {
              fileBuffer = Buffer.from(body, "latin1");
            }
          }

          if (!uploadPath || !fileBuffer) throw new Error("Missing path or file in upload");

          const { handleWriteFile } = await import("./handlers/sftp.js");
          const result = await handleWriteFile({
            sessionId,
            path: uploadPath,
            content: fileBuffer.toString("base64")
          }) as any;
          res.writeHead(result.isError ? 400 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ isError: true, error: err.message }));
        }
      });
      return;
    }


    // ======== Kubernetes REST Routes ========

    const k8sPodsMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/k8s\/pods$/);
    if (k8sPodsMatch && req.method === "GET") {
      const sessionId = k8sPodsMatch[1];
      const namespace = url.searchParams.get("namespace") || "";
      try {
        const { handleK8sListPods } = await import("./handlers/k8s.js");
        const result = await handleK8sListPods({ sessionId, namespace });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
      return;
    }

    const k8sLogsMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/k8s\/logs$/);
    if (k8sLogsMatch && req.method === "GET") {
      const sessionId = k8sLogsMatch[1];
      const namespace = url.searchParams.get("namespace") || "default";
      const pod = url.searchParams.get("pod") || "";
      const container = url.searchParams.get("container") || "";
      const tail = parseInt(url.searchParams.get("tail") || "100", 10);
      try {
        const { handleK8sPodLogs } = await import("./handlers/k8s.js");
        const result = await handleK8sPodLogs({ sessionId, namespace, pod, container, tail });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
      return;
    }

    const k8sExecMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/k8s\/exec$/);
    if (k8sExecMatch && req.method === "POST") {
      const sessionId = k8sExecMatch[1];
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const args = JSON.parse(body);
          const { handleK8sPodExec } = await import("./handlers/k8s.js");
          const result = await handleK8sPodExec({ sessionId, ...args });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ isError: true, error: e.message }));
        }
      });
      return;
    }

    const k8sArthasMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/k8s\/arthas$/);
    if (k8sArthasMatch && req.method === "POST") {
      const sessionId = k8sArthasMatch[1];
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const args = JSON.parse(body);
          const { handleK8sArthasAttach } = await import("./handlers/k8s.js");
          const result = await handleK8sArthasAttach({ sessionId, ...args });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ isError: true, error: e.message }));
        }
      });
      return;
    }

    // ======== System Monitoring REST Routes ========
    const sysinfoMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/sysinfo$/);
    if (sysinfoMatch && req.method === "GET") {
      const sessionId = sysinfoMatch[1];
      try {
        const { handleSysinfo } = await import("./handlers/system.js");
        const result = await handleSysinfo({ sessionId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
      return;
    }

    const processesMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/processes$/);
    if (processesMatch && req.method === "GET") {
      const sessionId = processesMatch[1];
      const sort = (url.searchParams.get("sort") || "cpu") as "cpu" | "memory" | "pid";
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      try {
        const { handleProcesses } = await import("./handlers/system.js");
        const result = await handleProcesses({ sessionId, sort, limit });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
      return;
    }



    // Default 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, request: http.IncomingMessage) => {
    const url = new URL(request.url || "", `http://localhost:${currentPort}`);
    const shellId = url.searchParams.get("shellId");

    if (!shellId) {
      ws.close(4000, "Missing shellId parameter");
      return;
    }

    console.log(`[WebSocket] Connected client to shell: ${shellId}`);
    const ok = attachWsToShell(shellId, ws);
    if (!ok) {
      ws.close(4004, `Shell session ${shellId} not found`);
      return;
    }

    ws.on("message", (message) => {
      // Forward text input to the shell
      const text = message.toString();
      writeInputToShell(shellId, text);
    });

    ws.on("close", () => {
      console.log(`[WebSocket] Disconnected client from shell: ${shellId}`);
      detachWsFromShell(shellId, ws);
    });

    ws.on("error", (err) => {
      console.error(`[WebSocket Error] Shell ${shellId}:`, err);
      detachWsFromShell(shellId, ws);
    });
  });

  // Upgrade HTTP connections to WebSocket
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://localhost:${currentPort}`);
    if (url.pathname === "/ws/shell") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE" && retryCount < maxRetries) {
      retryCount++;
      currentPort++;
      console.error(`[REST Server] Port ${currentPort - 1} in use, retrying on ${currentPort}...`);
      server.listen(currentPort, "127.0.0.1");
    } else {
      console.error(`[REST Server] Failed to start: ${err.message}`);
      // Don't throw/exit to keep the main MCP stdio channel alive
    }
  });

  server.listen(currentPort, "127.0.0.1", () => {
    console.error(`[REST/WebSocket Server] Running at http://127.0.0.1:${currentPort}`);
  });

  return server;
}
