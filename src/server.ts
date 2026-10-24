import http from "http";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import sirv from "sirv";
import { WebSocketServer, WebSocket, createWebSocketStream } from "ws";
import type { SFTPWrapper } from "ssh2";
import { listSessions, disconnectSession, deleteSession, resolveClient } from "./session.js";
import {
  attachWsToShell,
  detachWsFromShell,
  writeInputToShell,
  listActiveShells,
  resizeShell,
} from "./handlers/shell.js";
import { globalEvents } from "./eventBus.js";
import { MultipartUploadError, streamMultipartFile } from "./multipartUpload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// UI assets are located in the sibling 'ui/dist' folder relative to 'build/'
const uiDistPath = path.resolve(__dirname, "..", "ui", "dist");
// dev: true forces sirv to always read from disk instead of caching in RAM
const serve = sirv(uiDistPath, {
  dev: true,
  single: true,
  setHeaders: (res, pathname) => {
    if (pathname === "/" || pathname === "/index.html" || pathname.endsWith(".html") || pathname.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
});

export interface HttpServerStartResult {
  port: number;
  reused: boolean;
  server?: http.Server;
  close?: () => Promise<void>;
}

const API_AUTH_TOKEN = process.env.SSH_MCP_AUTH_TOKEN?.trim() || "";
let mcpAccessEnabled = process.env.SSH_MCP_ENABLED === "1";

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!API_AUTH_TOKEN) return true;
  return req.headers.authorization === `Bearer ${API_AUTH_TOKEN}`;
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

let SERVER_VERSION = "2.1.2";
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
    const url = new URL(req.url || "", `http://localhost:${currentPort}`);
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

    if (origin && !isAllowedOrigin(origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Origin is not allowed" }));
      return;
    }

    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/api/version" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: SERVER_VERSION, desktopManaged: Boolean(API_AUTH_TOKEN) }));
      return;
    }

    if (url.pathname.startsWith("/api/") && !isAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "Desktop authorization required" }));
      return;
    }

    if (url.pathname === "/api/desktop/mcp-state" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ enabled: mcpAccessEnabled }));
      return;
    }

    if (url.pathname === "/api/desktop/mcp-state" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => {
        if (body.length < 16 * 1024) body += chunk;
      });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body) as { enabled?: unknown };
          if (typeof payload.enabled !== "boolean") throw new Error("enabled must be a boolean");
          mcpAccessEnabled = payload.enabled;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ enabled: mcpAccessEnabled }));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        }
      });
      return;
    }

    if ((url.pathname.startsWith("/api/mcp/") || url.pathname === "/api/mcp/tool") && !mcpAccessEnabled) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "MCP access is disabled in SSH-MCP Desktop" }));
      return;
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      res.write("retry: 3000\n\n");

      const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const onSessionsChanged = () => sendEvent("sessions_changed", {});
      const onShellsChanged = () => sendEvent("shells_changed", {});
      const onSftpChanged = (data: any) => sendEvent("sftp_changed", data);

      globalEvents.on("sessions_changed", onSessionsChanged);
      globalEvents.on("shells_changed", onShellsChanged);
      globalEvents.on("sftp_changed", onSftpChanged);

      req.on("close", () => {
        globalEvents.off("sessions_changed", onSessionsChanged);
        globalEvents.off("shells_changed", onShellsChanged);
        globalEvents.off("sftp_changed", onSftpChanged);
      });
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

    // ======== MCP Proxy Routes ========
    if (url.pathname === "/api/mcp/tool" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        try {
          const { name, args } = JSON.parse(body);
          const { handleMcpToolCall } = await import("./handlers/mcp.js");
          const result = await handleMcpToolCall(name, args, currentPort);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ isError: true, error: err.message }));
        }
      });
      return;
    }

    if (url.pathname === "/api/mcp/resources" && req.method === "GET") {
      try {
        const { handleMcpListResources } = await import("./handlers/mcp.js");
        const result = await handleMcpListResources();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/mcp/resource" && req.method === "GET") {
      const uri = url.searchParams.get("uri");
      if (!uri) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: "Missing uri parameter" }));
        return;
      }
      try {
        const { handleMcpReadResource } = await import("./handlers/mcp.js");
        const result = await handleMcpReadResource(uri);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
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
            username: session.username,
            proxyEnabled: session.proxyEnabled,
            proxyUrl: session.proxyUrl,
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
            username: session.username,
            proxyEnabled: session.proxyEnabled,
            proxyUrl: session.proxyUrl,
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
        const ok = await deleteSession(sessionId);
        if (ok) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, message: `Session ${sessionId} deleted` }));
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

    // POST /api/sessions/:sessionId/disconnect
    const sessionDisconnectMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/disconnect$/);
    if (sessionDisconnectMatch && req.method === "POST") {
      const sessionId = sessionDisconnectMatch[1];
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
      const fileName = path.posix.basename(filePath) || "download";
      if (!filePath) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: "Path is required" }));
        return;
      }

      try {
        await resolveClient({ sessionId }, async client => {
          return new Promise<void>((resolve, reject) => {
            client.sftp((err, sftp) => {
              if (err) return reject(err);

              sftp.stat(filePath, (statErr, stats) => {
                if (statErr) {
                  try { sftp.end(); } catch {}
                  return reject(statErr);
                }
                if (stats.isDirectory()) {
                  try { sftp.end(); } catch {}
                  return reject(new Error("Cannot download a directory directly"));
                }

                res.writeHead(200, {
                  "Content-Type": "application/octet-stream",
                  "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
                  "Content-Length": stats.size,
                });

                const readStream = sftp.createReadStream(filePath);

                readStream.on("error", (streamErr: any) => {
                  try { sftp.end(); } catch {}
                  if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ isError: true, error: streamErr.message }));
                  } else {
                    res.destroy(streamErr);
                  }
                  reject(streamErr);
                });

                req.on("close", () => {
                  readStream.destroy();
                  try { sftp.end(); } catch {}
                });

                readStream.on("end", () => {
                  try { sftp.end(); } catch {}
                  resolve();
                });

                readStream.pipe(res);
              });
            });
          });
        });
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ isError: true, error: err.message || "Download failed" }));
        }
      }
      return;
    }

    // SFTP UPLOAD  POST /api/sessions/:id/sftp/upload?path=/remote/file  multipart/form-data
    const sftpUploadMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/sftp\/upload$/);
    if (sftpUploadMatch && req.method === "POST") {
      const sessionId = sftpUploadMatch[1];
      const targetQueryPath = url.searchParams.get("path")?.trim() ?? "";
      if (!targetQueryPath) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: "Remote upload path is required" }));
        return;
      }

      try {
        const upload = await resolveClient({ sessionId }, async client => {
          const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
            client.sftp((error, channel) => error ? reject(error) : resolve(channel));
          });

          let writeStarted = false;
          let temporaryPath = "";
          let finalUploadPath = targetQueryPath;

          try {
            const result = await streamMultipartFile(req, req.headers, (info) => {
              const originalFilename = info.filename || "upload.bin";
              if (targetQueryPath.endsWith("/")) {
                finalUploadPath = path.posix.join(targetQueryPath, originalFilename);
              } else {
                finalUploadPath = targetQueryPath;
              }

              temporaryPath = `${finalUploadPath}.ssh-mcp-upload-${randomBytes(8).toString("hex")}.tmp`;
              writeStarted = true;
              return sftp.createWriteStream(temporaryPath);
            });

            // Check if destination exists; if so, unlink before rename because OpenSSH SFTP v3 fails rename if destination exists
            const destStat = await new Promise<import("ssh2").Stats | null>(res => {
              sftp.stat(finalUploadPath, (err, stats) => res(err ? null : stats));
            });
            if (destStat && !destStat.isDirectory()) {
              await new Promise<void>(res => {
                sftp.unlink(finalUploadPath, () => res());
              });
            }

            await new Promise<void>((resolve, reject) => {
              sftp.rename(temporaryPath, finalUploadPath, error => error ? reject(error) : resolve());
            });

            return {
              ...result,
              destinationPath: finalUploadPath,
            };
          } catch (error) {
            if (writeStarted && temporaryPath) {
              await new Promise<void>(resolve => {
                sftp.unlink(temporaryPath, () => resolve());
              });
            }
            throw error;
          } finally {
            try { sftp.end(); } catch {}
          }
        }) as { bytesWritten: number; filename: string; mimeType: string; destinationPath: string };

        globalEvents.emit("sftp_changed", { sessionId, path: upload.destinationPath });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          content: [{ type: "text", text: `Uploaded ${upload.bytesWritten} bytes to ${upload.destinationPath}` }],
          bytesWritten: upload.bytesWritten,
          path: upload.destinationPath,
        }));
      } catch (error) {
        const statusCode = error instanceof MultipartUploadError ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : "Upload failed";
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: message }));
      }
      return;
    }


    // ======== Kubernetes REST Routes ========



    // ======== System Monitoring REST Routes ========
    const statsMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/stats$/);
    if (statsMatch && req.method === "GET") {
      const sessionId = statsMatch[1];
      try {
        const { handleStats } = await import("./handlers/system.js");
        const result = await handleStats({ sessionId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ isError: true, error: err.message }));
      }
      return;
    }

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
      const text = message.toString();
      if (text.startsWith("\x01RS")) {
        const match = text.match(/^\x01RS(\d+),(\d+)$/);
        if (match) resizeShell(shellId, Number(match[1]), Number(match[2]));
        return;
      }
      // Forward ordinary text input to the shell.
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

  const mcpWss = new WebSocketServer({ noServer: true });
  mcpWss.on("connection", (ws: WebSocket) => {
    console.log("[WebSocket] MCP Proxy connected for events");
    ws.on("error", console.error);
  });

  // Listen for shell data events and broadcast to all connected proxies
  try {
    import("./handlers/shell.js").then(({ shellEvents }) => {
      shellEvents.on("data", (shellId: string) => {
        const uri = `mcp://ssh/shell/${shellId}/output`;
        const msg = JSON.stringify({ type: "resourceUpdated", uri });
        for (const client of mcpWss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
          }
        }
      });
    }).catch(console.error);
  } catch (err) {
    console.error("[WebSocket] Failed to bind shell events to MCP events:", err);
  }

  // Upgrade HTTP connections to WebSocket
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://localhost:${currentPort}`);
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;

    if (!isAllowedOrigin(origin) || !isAuthorized(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (url.pathname === "/ws/shell") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else if (url.pathname === "/ws/mcp-events") {
      if (!mcpAccessEnabled) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      mcpWss.handleUpgrade(request, socket, head, (ws) => {
        mcpWss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  const closeServer = async () => {
    for (const client of wss.clients) client.terminate();
    for (const client of mcpWss.clients) client.terminate();
    await Promise.all([
      new Promise<void>(resolve => wss.close(() => resolve())),
      new Promise<void>(resolve => mcpWss.close(() => resolve())),
    ]);
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  };

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
      resolve({ port: currentPort, reused: false, server, close: closeServer });
    });
  });
}
