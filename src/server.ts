import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sirv from "sirv";
import { WebSocketServer, WebSocket, createWebSocketStream } from "ws";
import { listSessions, disconnectSession } from "./session.js";
import {
  attachWsToShell,
  detachWsFromShell,
  writeInputToShell,
  listActiveShells
} from "./handlers/shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// UI assets are located in the sibling 'ui/dist' folder relative to 'build/'
const uiDistPath = path.resolve(__dirname, "..", "ui", "dist");
// dev: true forces sirv to always read from disk instead of caching in RAM
const serve = sirv(uiDistPath, { dev: true, single: true });

export interface HttpServerStartResult {
  port: number;
  reused: boolean;
  server?: http.Server;
}

let SERVER_VERSION = "2.1.1";
try {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  SERVER_VERSION = pkg.version;
} catch {}

async function checkExistingServer(port: number): Promise<{ exists: boolean, version?: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/version`);
    if (response.ok) {
      const data = await response.json();
      return { exists: true, version: data.version };
    }
    const fallback = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    if (fallback.ok) {
      return { exists: true, version: "1.0.0" }; // fallback for older versions
    }
  } catch {
    return { exists: false };
  }
  return { exists: false };
}

export async function startHttpServer(initialPort: number = 12222): Promise<HttpServerStartResult> {
  const maxRetries = 10;
  let currentPort = initialPort;

  for (let offset = 0; offset <= maxRetries; offset++) {
    const port = initialPort + offset;
    const check = await checkExistingServer(port);
    if (check.exists) {
      if (check.version && check.version !== SERVER_VERSION) {
        console.error(`[REST/WebSocket Server] Found older ssh-mcp UI (v${check.version}) on port ${port}. Requesting shutdown to take over...`);
        try {
          await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" });
          await new Promise(r => setTimeout(r, 1000));
          currentPort = port;
          break; // successfully told it to shut down, try binding here
        } catch (e) {
          console.error(`[REST/WebSocket Server] Failed to shutdown older server:`, e);
          continue; // continue to next port
        }
      } else {
        console.error(`[REST/WebSocket Server] Reusing existing ssh-mcp UI (v${check.version}) at http://127.0.0.1:${port}`);
        return { port, reused: true };
      }
    } else {
      currentPort = port;
      break;
    }
  }

  let retryCount = 0;

  const server = http.createServer(async (req, res) => {
    // ... rest of the handler remains the same ...
    // (I will keep the existing handler code inside this block)
    // Add CORS headers for Vite/frontend development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || "", `http://localhost:${currentPort}`);

    if (url.pathname === "/api/version" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: SERVER_VERSION }));
      return;
    }

    if (url.pathname === "/api/shutdown" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      console.error(`[REST/WebSocket Server] Received shutdown request from newer instance. Releasing port ${currentPort}...`);
      server.close();
      server.closeAllConnections?.();
      return;
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      const sessions = listSessions();
      try {
        const { touchSession } = await import("./session.js");
        for (const s of sessions) {
          touchSession(s.id);
        }
      } catch {}
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
    const sessionUpdateMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)$/);
    if (sessionUpdateMatch && req.method === "PUT") {
      const sessionId = sessionUpdateMatch[1];
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        try {
          const creds = JSON.parse(body);
          const { updateSession } = await import("./session.js");
          const session = await updateSession(sessionId, creds, creds.name);
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
          const isSymlink = line.startsWith("l");
          const rest = line.substring(11).trim();
          const cols = rest.split(/\s+/);
          const size = parseInt(cols[0], 10);
          const dateStr = `${cols[1]} ${cols[2]}`;
          const fullName = cols.slice(3).join(" ");
          
          let name = fullName;
          let linkTarget: string | undefined;
          if (isSymlink) {
            const arrowIdx = fullName.indexOf(" -> ");
            if (arrowIdx !== -1) {
              name = fullName.substring(0, arrowIdx);
              linkTarget = fullName.substring(arrowIdx + 4);
            }
          }
          
          return {
            name,
            type: isDir ? "dir" : isSymlink ? "symlink" : "file",
            size: isNaN(size) ? 0 : size,
            mtime: Math.floor(new Date(dateStr).getTime() / 1000) || 0,
            ...(linkTarget !== undefined ? { linkTarget } : {}),
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
      let totalSize = 0;
      const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500MB
      req.on("data", c => {
        totalSize += (c as Buffer).length;
        if (totalSize > MAX_UPLOAD_SIZE) {
          req.destroy(new Error("Upload too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", async () => {
        try {
          const raw = Buffer.concat(chunks);
          const boundaryRaw = Buffer.from("--" + ((req.headers["content-type"] || "").split("boundary=")[1] || ""));
          if (boundaryRaw.length <= 2) throw new Error("No boundary in multipart");

          // Parse multipart: split by boundary
          const parts: Buffer[] = [];
          let start = 0;
          while (true) {
            const idx = raw.indexOf(boundaryRaw, start);
            if (idx === -1) break;
            start = idx + boundaryRaw.length;
            // Skip the trailing -- and newlines
            if (start >= raw.length) break;
            if (raw[start] === 45 /* - */ || raw[start] === 13 /* \r */) {
              const nextEnd = raw.indexOf(boundaryRaw, start);
              if (nextEnd !== -1) {
                // There's another boundary — capture the part before it
                const part = raw.slice(start, nextEnd).toString("utf-8");
                if (part.includes("name=\"file\"")) {
                  // Find the double CRLF that separates headers from body
                  const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"), start);
                  if (headerEnd !== -1 && headerEnd < nextEnd) {
                    const bodyStart = headerEnd + 4;
                    const bodyEnd = nextEnd - 2; // trim trailing \r\n
                    if (bodyEnd > bodyStart) {
                      parts.push(raw.slice(bodyStart, bodyEnd));
                    }
                  }
                }
              }
              break;
            }
          }

          // Extract text parts the simpler way: find "path" and "file" fields
          const bodyStr = raw.toString("utf-8");
          const textParts = bodyStr.split(boundaryRaw.toString("utf-8"))
            .filter(p => !p.startsWith("--") && p.trim());

          let uploadPath = "";
          let fileBuffer: Buffer | null = null;

          for (const p of textParts) {
            const [rawHead, ...bodyLines] = p.split("\r\n\r\n");
            const body = bodyLines.join("\r\n\r\n").replace(/\r\n$/, "").trimEnd();
            if (rawHead.includes("name=\"path\"")) {
              uploadPath = body;
            } else if (rawHead.includes("name=\"file\"")) {
              fileBuffer = Buffer.from(body, "latin1");
            }
          }

          // Fallback: if we couldn't find file via text parsing, try buffer parsing
          if (!fileBuffer && parts.length > 0) {
            fileBuffer = parts[0]; // use the first binary part found
          }

          if (!uploadPath || !fileBuffer) throw new Error("Missing path or file in upload");

          // Write the file directly via SFTP — bypass handleWriteFile to avoid text encoding
          const { resolveClient } = await import("./session.js");
          await resolveClient({ sessionId }, async (client: any) => {
            return new Promise((resolve, reject) => {
              client.sftp((err: any, sftp: any) => {
                if (err) return reject(err);
                const stream = sftp.createWriteStream(uploadPath);
                stream.on("close", () => { try { sftp.end(); } catch {} resolve(undefined); });
                stream.on("error", (e: any) => { try { sftp.end(); } catch {} reject(e); });
                stream.end(fileBuffer);
              });
            });
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ content: [{ type: "text", text: `Uploaded ${fileBuffer.length} bytes to ${uploadPath}` }] }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ isError: true, error: err.message }));
        }
      });
      return;
    }


    // ======== Kubernetes REST Routes ========



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



    // Default: try serving static files from ui/dist
    serve(req, res, () => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });
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

  return await new Promise<HttpServerStartResult>((resolve) => {
    server.on("error", async (err: any) => {
      if (err.code === "EADDRINUSE" && retryCount < maxRetries) {
        const occupiedPort = currentPort;
        const check = await checkExistingServer(occupiedPort);
        if (check.exists && check.version === SERVER_VERSION) {
          console.error(`[REST/WebSocket Server] Reusing existing ssh-mcp UI at http://127.0.0.1:${occupiedPort}`);
          resolve({ port: occupiedPort, reused: true });
          return;
        }

        retryCount++;
        currentPort++;
        console.error(`[REST Server] Port ${occupiedPort} in use by another process, retrying on ${currentPort}...`);
        server.listen(currentPort, "127.0.0.1");
      } else {
        console.error(`[REST Server] Failed to start: ${err.message}`);
        resolve({ port: currentPort, reused: false });
      }
    });

    server.listen(currentPort, "127.0.0.1", () => {
      console.error(`[REST/WebSocket Server] Running at http://127.0.0.1:${currentPort}`);
      resolve({ port: currentPort, reused: false, server });
    });
  });
}
