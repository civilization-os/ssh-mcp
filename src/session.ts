import { Client, ConnectConfig } from "ssh2";
import { Session, SshCredentials } from "./types.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import net from "net";
import { globalEvents } from "./eventBus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIRECTORY = process.env.SSH_MCP_DATA_DIR?.trim()
  ? path.resolve(process.env.SSH_MCP_DATA_DIR.trim())
  : path.join(__dirname, "..");
fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
const SESSIONS_STORE_PATH = path.join(DATA_DIRECTORY, "sessions-store.json");
const SESSIONS_META_PATH = path.join(DATA_DIRECTORY, "sessions-meta.json");
const ENCRYPTION_KEY_PATH = path.join(DATA_DIRECTORY, ".mcp-key");

export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

let nextId = 1;
const sessions = new Map<string, Session>();

// Runtime-only credentials kept in memory for the life of this process.
interface StoredCredentials {
  id: string;
  type: "ssh";
  label: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  proxyEnabled?: boolean;
  proxyUrl?: string;
}

/** Non-sensitive session metadata persisted across restarts (credentials now encrypted and saved). */
interface SessionMeta {
  id: string;
  type: "ssh";
  label: string;
  host: string;
  port: number;
  username: string;
  createdAt: number;
  lastUsedAt: number;
  passwordEncrypted?: string;
  privateKeyEncrypted?: string;
  passphraseEncrypted?: string;
  proxyEnabled?: boolean;
  proxyUrl?: string;
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getOrCreateEncryptionKey(): Buffer {
  try {
    if (!fs.existsSync(ENCRYPTION_KEY_PATH)) {
      const key = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(ENCRYPTION_KEY_PATH, key, "utf-8");
    }
    const keyHex = fs.readFileSync(ENCRYPTION_KEY_PATH, "utf-8").trim();
    return Buffer.from(keyHex, "hex");
  } catch (e) {
    console.error("[session] Failed to get or create encryption key:", e);
    return Buffer.alloc(32, "ssh-mcp-fallback-encryption-key-32");
  }
}

function encrypt(text: string): string {
  try {
    const key = getOrCreateEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let encrypted = cipher.update(text, "utf-8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");
    return `${iv.toString("hex")}:${authTag}:${encrypted}`;
  } catch (e) {
    console.error("[session] Encryption failed:", e);
    return "";
  }
}

function decrypt(cipherText: string): string {
  try {
    if (!cipherText || !cipherText.includes(":")) return "";
    const parts = cipherText.split(":");
    if (parts.length !== 3) return "";
    const [ivHex, authTagHex, encryptedHex] = parts;
    const key = getOrCreateEncryptionKey();
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    return decrypted;
  } catch (e) {
    console.error("[session] Decryption failed:", e);
    return "";
  }
}

function getStoredCredentials(session: Session): StoredCredentials | undefined {
  return (session as any)._creds as StoredCredentials | undefined;
}

// Sensitive credentials must not survive process exit. If an older version
// created a sessions-store.json file, remove it proactively.
function removeLegacySessionsStore() {
  try {
    if (fs.existsSync(SESSIONS_STORE_PATH)) {
      fs.unlinkSync(SESSIONS_STORE_PATH);
      console.error("[session] Removed legacy sessions-store.json to avoid persisting sensitive credentials.");
    }
  } catch (e) {
    console.error("[session] Failed to remove legacy sessions store:", e);
  }
}

/** Persist metadata along with encrypted sensitive credentials so sessions survive a restart. */
function saveSessionMeta() {
  removeLegacySessionsStore();
  const meta: SessionMeta[] = [];
  for (const session of sessions.values()) {
    const stored = getStoredCredentials(session);
    const m: SessionMeta = {
      id: session.id,
      type: session.type,
      label: session.label,
      host: session.host,
      port: session.port,
      username: session.username,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      proxyEnabled: session.proxyEnabled,
      proxyUrl: session.proxyUrl,
    };

    if (stored) {
      if (stored.password) m.passwordEncrypted = encrypt(stored.password);
      if (stored.privateKey) m.privateKeyEncrypted = encrypt(stored.privateKey);
      if (stored.passphrase) m.passphraseEncrypted = encrypt(stored.passphrase);
    }
    meta.push(m);
  }
  try {
    fs.writeFileSync(SESSIONS_META_PATH, JSON.stringify(meta, null, 2), "utf-8");
    globalEvents.emit("sessions_changed");
  } catch (e) {
    console.error("[session] Failed to save session metadata:", e);
  }
}

/** Load metadata from previous run and decrypt credentials into memory. */
export function loadSessionMeta(): void {
  removeLegacySessionsStore();
  try {
    if (!fs.existsSync(SESSIONS_META_PATH)) return;
    const raw = fs.readFileSync(SESSIONS_META_PATH, "utf-8");
    const meta: SessionMeta[] = JSON.parse(raw);
    if (!Array.isArray(meta)) return;
    for (const m of meta) {
      // Don't re-add if already present
      if (sessions.has(m.id)) continue;

      // Ensure we don't load another session with the same username@host:port
      if (m.type === "ssh") {
        let isDuplicate = false;
        for (const s of sessions.values()) {
          if (s.type === "ssh" && s.username === m.username && s.host === m.host && s.port === m.port) {
            isDuplicate = true;
            break;
          }
        }
        if (isDuplicate) {
          console.error(`[session] Skipping duplicate session ${m.id} (${m.username}@${m.host}:${m.port}) from metadata`);
          continue;
        }
      }
      
      const session: Session = {
        id: m.id,
        type: m.type,
        client: undefined,
        label: m.label,
        host: m.host,
        port: m.port,
        username: m.username,
        createdAt: m.createdAt,
        lastUsedAt: m.lastUsedAt,
        proxyEnabled: m.proxyEnabled,
        proxyUrl: m.proxyUrl,
      };

      const creds: StoredCredentials = {
        id: m.id,
        type: m.type,
        label: m.label,
        host: m.host,
        port: m.port,
        username: m.username,
        proxyEnabled: m.proxyEnabled,
        proxyUrl: m.proxyUrl,
      };

      if (m.passwordEncrypted) {
        const decrypted = decrypt(m.passwordEncrypted);
        if (decrypted) creds.password = decrypted;
      }
      if (m.privateKeyEncrypted) {
        const decrypted = decrypt(m.privateKeyEncrypted);
        if (decrypted) creds.privateKey = decrypted;
      }
      if (m.passphraseEncrypted) {
        const decrypted = decrypt(m.passphraseEncrypted);
        if (decrypted) creds.passphrase = decrypted;
      }

      (session as any)._creds = creds;
      sessions.set(m.id, session);
    }
    console.error(`[session] Loaded ${meta.length} session(s) from metadata`);
  } catch (e) {
    console.error("[session] Failed to load session metadata:", e);
  }
}

export async function loadAndReconnectSessions(): Promise<void> {
  loadSessionMeta();
  // Auto-reconnect is intentionally NOT performed — credentials are never persisted.
  // Users can reconnect from the UI or via ssh_connect.
}

function registerClientListeners(sessionId: string, client: Client) {
  const onDisconnect = (reason: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    console.error(`[session] SSH connection for ${sessionId} disconnected: ${reason}`);

    // Clean up shells
    import("./handlers/shell.js").then(({ cleanShellsBySession }) => {
      try { cleanShellsBySession(sessionId); } catch {}
    }).catch(() => {});

    // Keep the session entry so metadata survives restart (user can reconnect)
    session.client = undefined;
    saveSessionMeta();
  };

  client.on("error", (err: Error) => onDisconnect(`error (${err.message})`));
  client.on("end", () => onDisconnect("end"));
  client.on("close", () => onDisconnect("close"));
}

function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    const now = Date.now();
    let changed = false;

    // Dynamically import to check active shells
    let hasActiveShellsFn: (sid: string) => boolean = () => false;
    try {
      const shellModule = await import("./handlers/shell.js");
      hasActiveShellsFn = shellModule.hasActiveShells;
    } catch {}

    for (const [id, session] of sessions) {
      // If there are active shells, do not clean up and keep the session active
      if (hasActiveShellsFn(id)) {
        session.lastUsedAt = now;
        continue;
      }

      if (now - session.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
        if (session.type === "ssh" && session.client) {
          try {
            session.client.removeAllListeners("error");
            session.client.removeAllListeners("end");
            session.client.removeAllListeners("close");
            session.client.end();
          } catch {}
          session.client = undefined;
          try {
            const { cleanShellsBySession } = await import("./handlers/shell.js");
            cleanShellsBySession(id);
          } catch {}
        }
        // Keep metadata entry so it survives restart (user can reconnect)
        changed = true;
      }
    }
    if (changed) saveSessionMeta();
    if (sessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
}

function generateId(prefix: string = "sess"): string {
  return `${prefix}_${Date.now()}_${nextId++}`;
}

export function buildConnectConfig(creds: Partial<SshCredentials>): ConnectConfig {
  const config: ConnectConfig = {
    host: creds.host ?? "localhost",
    port: creds.port ?? 22,
    username: creds.username ?? "root",
    readyTimeout: creds.timeout ?? 10000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  };
  if (creds.password) {
    config.password = creds.password;
  } else if (creds.privateKey) {
    config.privateKey = creds.privateKey;
    if (creds.passphrase) config.passphrase = creds.passphrase;
  }
  return config;
}

export interface GlobalProxyConfig {
  mode: "direct" | "system" | "fixed";
  url?: string;
  systemProxyUrl?: string;
  bypassRules?: string;
  username?: string;
  password?: string;
}

let globalProxyConfig: GlobalProxyConfig = {
  mode: "direct",
};

export function setGlobalProxyConfig(config: Partial<GlobalProxyConfig>): void {
  globalProxyConfig = {
    ...globalProxyConfig,
    ...config,
  };
  const activeUrl = globalProxyConfig.url || globalProxyConfig.systemProxyUrl || "none";
  console.log(`[session] Global proxy config updated: mode=${globalProxyConfig.mode}, url=${activeUrl}, hasAuth=${Boolean(globalProxyConfig.username || globalProxyConfig.password)}`);
}

export function getGlobalProxyConfig(): GlobalProxyConfig {
  return { ...globalProxyConfig };
}

export function shouldBypassProxy(targetHost: string, bypassRulesStr?: string): boolean {
  if (!bypassRulesStr || !bypassRulesStr.trim()) return false;
  const host = targetHost.toLowerCase().trim();
  const rules = bypassRulesStr
    .split(/[,;\n]/)
    .map(r => r.trim().toLowerCase())
    .filter(Boolean);

  for (const rule of rules) {
    if (rule === "<local>") {
      if (host === "localhost" || host.startsWith("127.") || host === "::1" || !host.includes(".")) {
        return true;
      }
      continue;
    }
    if (rule === "*") return true;
    if (rule === host) return true;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(2);
      if (host === suffix || host.endsWith("." + suffix)) return true;
    } else if (rule.startsWith(".")) {
      const suffix = rule.slice(1);
      if (host === suffix || host.endsWith("." + suffix)) return true;
    } else if (rule.endsWith("*")) {
      const prefix = rule.slice(0, -1);
      if (host.startsWith(prefix)) return true;
    }
  }
  return false;
}

export interface EffectiveProxyResult {
  bypass: boolean;
  proxyUrl?: URL;
  error?: string;
}

export function resolveEffectiveProxy(targetHost: string): EffectiveProxyResult {
  const cfg = globalProxyConfig;

  let mode = cfg.mode;
  let rawUrl = cfg.url;
  let bypassRules = cfg.bypassRules;
  let username = cfg.username;
  let password = cfg.password;

  // Fallback if core was not started via Desktop or not yet synchronized
  if (mode === "direct" && !rawUrl) {
    try {
      const desktopSettingsPath = path.join(DATA_DIRECTORY, "settings.json");
      if (fs.existsSync(desktopSettingsPath)) {
        const parsed = JSON.parse(fs.readFileSync(desktopSettingsPath, "utf-8"));
        if (parsed?.proxy) {
          mode = parsed.proxy.mode || "direct";
          if (parsed.proxy.mode === "fixed" && parsed.proxy.url) {
            rawUrl = parsed.proxy.url;
          }
          if (parsed.proxy.bypassRules) {
            bypassRules = parsed.proxy.bypassRules;
          }
          if (parsed.proxy.username) {
            username = parsed.proxy.username;
          }
        }
      }
    } catch {}
  }

  // Check bypass rules
  if (shouldBypassProxy(targetHost, bypassRules)) {
    console.log(`[session] Target "${targetHost}" matches proxy bypass rules ("${bypassRules}"), connecting directly.`);
    return { bypass: true };
  }

  let finalProxyUrlStr: string | undefined;

  if (mode === "system") {
    finalProxyUrlStr = cfg.systemProxyUrl;
    if (!finalProxyUrlStr) {
      finalProxyUrlStr = process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    }
    if (!finalProxyUrlStr) {
      return {
        bypass: false,
        error: "Proxy is set to 'system' in Desktop Settings, but no system proxy could be detected.",
      };
    }
  } else if (mode === "fixed") {
    finalProxyUrlStr = rawUrl;
  } else {
    // Mode is direct, check environment variable fallback
    const envProxy = process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (envProxy) {
      finalProxyUrlStr = envProxy;
    } else {
      return {
        bypass: false,
        error: "Proxy is enabled for this session, but no proxy URL is configured (Desktop Settings mode is Direct or unset).",
      };
    }
  }

  if (!finalProxyUrlStr || !finalProxyUrlStr.trim()) {
    return {
      bypass: false,
      error: "Proxy is enabled for this session, but no proxy URL is configured in Desktop Settings.",
    };
  }

  try {
    let urlString = finalProxyUrlStr.trim();
    if (!urlString.includes("://")) {
      urlString = `http://${urlString}`;
    }
    const parsedUrl = new URL(urlString);
    if (username && !parsedUrl.username) {
      parsedUrl.username = encodeURIComponent(username);
    }
    if (password && !parsedUrl.password) {
      parsedUrl.password = encodeURIComponent(password);
    }
    return { bypass: false, proxyUrl: parsedUrl };
  } catch (err: any) {
    return {
      bypass: false,
      error: `Invalid proxy URL "${finalProxyUrlStr}": ${err.message}`,
    };
  }
}

export function getEffectiveProxyUrl(customProxyUrl?: string): string | undefined {
  const custom = normalizeOptionalString(customProxyUrl);
  if (custom) return custom;
  const res = resolveEffectiveProxy("example.com");
  return res.proxyUrl?.toString();
}

export async function createProxySocket(
  proxyTarget: string | URL,
  targetHost: string,
  targetPort: number,
  timeoutMs: number = 10000,
): Promise<net.Socket> {
  let proxyUrl: URL;
  if (typeof proxyTarget === "string") {
    let s = proxyTarget.trim();
    if (!s.includes("://")) s = `http://${s}`;
    try {
      proxyUrl = new URL(s);
    } catch (err: any) {
      throw new Error(`Invalid proxy URL "${proxyTarget}": ${err.message}`);
    }
  } else {
    proxyUrl = proxyTarget;
  }

  const protocol = proxyUrl.protocol.replace(/:$/, "").toLowerCase();
  const proxyHost = proxyUrl.hostname;
  const proxyPort = Number(proxyUrl.port) || (protocol.startsWith("socks") ? 1080 : 80);

  if (protocol === "http" || protocol === "https") {
    return await createHttpConnectSocket(proxyUrl, proxyHost, proxyPort, targetHost, targetPort, timeoutMs);
  } else if (protocol === "socks" || protocol === "socks5" || protocol === "socks5h") {
    return await createSocks5Socket(proxyUrl, proxyHost, proxyPort, targetHost, targetPort, timeoutMs);
  } else {
    throw new Error(`Unsupported proxy protocol "${protocol}". Supported protocols: http, https, socks5`);
  }
}

function createHttpConnectSocket(
  proxyUrl: URL,
  proxyHost: string,
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let resolved = false;

    const cleanup = () => {
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("data", onData);
    };

    const onError = (err: Error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        socket.destroy();
        reject(new Error(`HTTP proxy connection to ${proxyHost}:${proxyPort} failed: ${err.message}`));
      }
    };

    const onTimeout = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        socket.destroy();
        reject(new Error(`HTTP proxy connection timed out after ${timeoutMs}ms`));
      }
    };

    socket.setTimeout(timeoutMs, onTimeout);
    socket.once("error", onError);

    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("binary");
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        cleanup();
        socket.setTimeout(0); // clear timeout for ongoing SSH session

        const headerText = buffer.slice(0, headerEnd);
        const statusLine = headerText.split("\r\n")[0];
        const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/i);
        const statusCode = match ? parseInt(match[1], 10) : 0;

        if (statusCode >= 200 && statusCode < 300) {
          resolved = true;
          const remainderBinary = buffer.slice(headerEnd + 4);
          if (remainderBinary.length > 0) {
            socket.unshift(Buffer.from(remainderBinary, "binary"));
          }
          resolve(socket);
        } else {
          resolved = true;
          socket.destroy();
          reject(new Error(`HTTP proxy rejected CONNECT request with status ${statusCode}: ${statusLine}`));
        }
      }
    };

    socket.on("connect", () => {
      let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (proxyUrl.username || proxyUrl.password) {
        const auth = Buffer.from(
          `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
        ).toString("base64");
        connectReq += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      connectReq += "Proxy-Connection: Keep-Alive\r\n\r\n";
      socket.on("data", onData);
      socket.write(connectReq);
    });
  });
}

function createSocks5Socket(
  proxyUrl: URL,
  proxyHost: string,
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let resolved = false;

    const cleanup = () => {
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("data", onData);
    };

    const onError = (err: Error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        socket.destroy();
        reject(new Error(`SOCKS5 proxy connection to ${proxyHost}:${proxyPort} failed: ${err.message}`));
      }
    };

    const onTimeout = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        socket.destroy();
        reject(new Error(`SOCKS5 proxy connection timed out after ${timeoutMs}ms`));
      }
    };

    socket.setTimeout(timeoutMs, onTimeout);
    socket.once("error", onError);

    const hasAuth = Boolean(proxyUrl.username || proxyUrl.password);
    let state: "HANDSHAKE" | "AUTH" | "CONNECT" = "HANDSHAKE";
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (state === "HANDSHAKE") {
        if (buffer.length < 2) return;
        const ver = buffer[0];
        const method = buffer[1];
        buffer = buffer.slice(2);

        if (ver !== 0x05) {
          resolved = true;
          cleanup();
          socket.destroy();
          reject(new Error(`Invalid SOCKS version from server: ${ver}`));
          return;
        }

        if (method === 0x00) {
          sendConnectRequest();
        } else if (method === 0x02 && hasAuth) {
          state = "AUTH";
          const uBytes = Buffer.from(decodeURIComponent(proxyUrl.username || ""));
          const pBytes = Buffer.from(decodeURIComponent(proxyUrl.password || ""));
          const authPacket = Buffer.concat([
            Buffer.from([0x01, uBytes.length]),
            uBytes,
            Buffer.from([pBytes.length]),
            pBytes,
          ]);
          socket.write(authPacket);
        } else {
          resolved = true;
          cleanup();
          socket.destroy();
          reject(new Error(`SOCKS5 server requested unsupported auth method: ${method}`));
          return;
        }
      } else if (state === "AUTH") {
        if (buffer.length < 2) return;
        const status = buffer[1];
        buffer = buffer.slice(2);

        if (status !== 0x00) {
          resolved = true;
          cleanup();
          socket.destroy();
          reject(new Error(`SOCKS5 username/password authentication failed (status ${status})`));
          return;
        }

        sendConnectRequest();
      } else if (state === "CONNECT") {
        if (buffer.length < 4) return;
        const rep = buffer[1];
        const atyp = buffer[3];

        if (rep !== 0x00) {
          resolved = true;
          cleanup();
          socket.destroy();
          const errCodes: Record<number, string> = {
            1: "General SOCKS server failure",
            2: "Connection not allowed by ruleset",
            3: "Network unreachable",
            4: "Host unreachable",
            5: "Connection refused",
            6: "TTL expired",
            7: "Command not supported",
            8: "Address type not supported",
          };
          reject(new Error(`SOCKS5 connect failed: ${errCodes[rep] || `Error code ${rep}`}`));
          return;
        }

        let addrLen = 0;
        if (atyp === 0x01) { // IPv4
          addrLen = 4;
        } else if (atyp === 0x04) { // IPv6
          addrLen = 16;
        } else if (atyp === 0x03) { // Domain name
          if (buffer.length < 5) return;
          addrLen = 1 + buffer[4];
        }

        const totalResponseLen = 4 + addrLen + 2;
        if (buffer.length < totalResponseLen) return;

        const remainder = buffer.slice(totalResponseLen);
        cleanup();
        socket.setTimeout(0);
        resolved = true;

        if (remainder.length > 0) {
          socket.unshift(remainder);
        }
        resolve(socket);
      }
    };

    function sendConnectRequest() {
      state = "CONNECT";
      let destBuf: Buffer;
      if (net.isIPv4(targetHost)) {
        const parts = targetHost.split(".").map(Number);
        destBuf = Buffer.from([0x01, ...parts]);
      } else {
        const dBytes = Buffer.from(targetHost);
        destBuf = Buffer.concat([Buffer.from([0x03, dBytes.length]), dBytes]);
      }

      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort, 0);

      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00]),
        destBuf,
        portBuf,
      ]);
      socket.write(req);
    }

    socket.on("connect", () => {
      socket.on("data", onData);
      if (hasAuth) {
        socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      } else {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      }
    });
  });
}

export async function sshConnect(creds: Partial<SshCredentials>, timeoutMs: number): Promise<Client> {
  const config = buildConnectConfig(creds);
  let proxySocket: net.Socket | undefined;

  if (creds.proxyEnabled) {
    const targetHost = creds.host ?? "localhost";
    const targetPort = creds.port ?? 22;
    const resolved = resolveEffectiveProxy(targetHost);

    if (resolved.error) {
      throw new Error(resolved.error);
    }

    if (!resolved.bypass && resolved.proxyUrl) {
      proxySocket = await createProxySocket(resolved.proxyUrl, targetHost, targetPort, timeoutMs);
      config.sock = proxySocket;
    }
  }

  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      proxySocket?.destroy();
      reject(new Error(`SSH connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.on("ready", () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      proxySocket?.destroy();
      reject(err);
    });
    client.on("close", () => {
      clearTimeout(timer);
      proxySocket?.destroy();
    });
    client.connect(config);
  });
}

export async function createSession(creds: Partial<SshCredentials>, label?: string): Promise<Session> {
  // If no explicit credentials provided, try to auto-fill from saved sessions
  if (!creds.password && !creds.privateKey) {
    for (const s of sessions.values()) {
      if (s.type === "ssh" && s.host === (creds.host ?? "localhost")) {
        if (creds.port && s.port !== creds.port) continue;
        if (creds.username && s.username !== creds.username) continue;
        
        const stored = (s as any)._creds;
        if (stored && (stored.password || stored.privateKey)) {
          creds.password = stored.password;
          creds.privateKey = stored.privateKey;
          creds.passphrase = stored.passphrase;
          if (!creds.username) creds.username = stored.username;
          if (!creds.port) creds.port = stored.port;
          break;
        }
      }
    }
  }

  const targetHost = creds.host ?? "localhost";
  const targetPort = creds.port ?? 22;
  const targetUsername = creds.username ?? "root";

  // Check if session already exists for this username@host:port
  let existingSession: Session | undefined;
  for (const s of sessions.values()) {
    if (
      s.type === "ssh" &&
      s.host === targetHost &&
      s.port === targetPort &&
      s.username === targetUsername
    ) {
      existingSession = s;
      break;
    }
  }

  const timeout = creds.timeout ?? 15000;
  const client = await sshConnect(creds, timeout);

  if (existingSession) {
    // Gracefully disconnect old client if active
    if (existingSession.client) {
      existingSession.client.removeAllListeners("error");
      existingSession.client.removeAllListeners("end");
      existingSession.client.removeAllListeners("close");
      try { existingSession.client.end(); } catch {}
    }

    existingSession.client = client;
    if (label) {
      existingSession.label = label;
    } else if (existingSession.label.includes("@") && existingSession.label.includes(":")) {
      // If it was using default label, update it
      existingSession.label = `${targetUsername}@${targetHost}:${targetPort}`;
    }
    existingSession.lastUsedAt = Date.now();

    const storedCred: StoredCredentials = {
      id: existingSession.id,
      type: "ssh",
      label: existingSession.label,
      host: existingSession.host,
      port: existingSession.port,
      username: existingSession.username,
      password: creds.password,
      privateKey: creds.privateKey ? String(creds.privateKey) : undefined,
      passphrase: creds.passphrase,
      proxyEnabled: creds.proxyEnabled,
      proxyUrl: normalizeOptionalString(creds.proxyUrl),
    };
    existingSession.proxyEnabled = creds.proxyEnabled;
    existingSession.proxyUrl = normalizeOptionalString(creds.proxyUrl);
    (existingSession as any)._creds = storedCred;

    registerClientListeners(existingSession.id, client);
    startCleanup();
    saveSessionMeta();
    return existingSession;
  }

  const id = generateId();
  const session: Session = {
    id,
    type: "ssh",
    client,
    label: label ?? `${targetUsername}@${targetHost}:${targetPort}`,
    host: targetHost,
    port: targetPort,
    username: targetUsername,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    proxyEnabled: creds.proxyEnabled,
    proxyUrl: normalizeOptionalString(creds.proxyUrl),
  };

  const storedCred: StoredCredentials = {
    id,
    type: "ssh",
    label: session.label,
    host: session.host,
    port: session.port,
    username: session.username,
    password: creds.password,
    privateKey: creds.privateKey ? String(creds.privateKey) : undefined,
    passphrase: creds.passphrase,
    proxyEnabled: creds.proxyEnabled,
    proxyUrl: normalizeOptionalString(creds.proxyUrl),
  };
  (session as any)._creds = storedCred;

  sessions.set(session.id, session);
  registerClientListeners(session.id, client);
  startCleanup();
  saveSessionMeta();
  return session;
}

export async function updateSession(sessionId: string, creds: Partial<SshCredentials>, label?: string): Promise<Session> {
  const existing = sessions.get(sessionId);
  if (!existing || existing.type !== "ssh") {
    throw new Error(`SSH Session '${sessionId}' not found`);
  }

  const stored = getStoredCredentials(existing);
  if (!stored) {
    throw new Error(`Session '${sessionId}' credentials are unavailable`);
  }

  const nextCreds: StoredCredentials = {
    ...stored,
    label: normalizeOptionalString(label) ?? stored.label,
    host: normalizeOptionalString(creds.host) ?? stored.host,
    port: creds.port ?? stored.port,
    username: normalizeOptionalString(creds.username) ?? stored.username,
    passphrase: creds.passphrase !== undefined ? normalizeOptionalString(creds.passphrase) : stored.passphrase,
    proxyEnabled: creds.proxyEnabled !== undefined ? creds.proxyEnabled : stored.proxyEnabled,
    proxyUrl: creds.proxyUrl !== undefined ? normalizeOptionalString(creds.proxyUrl) : stored.proxyUrl,
  };

  if (creds.password !== undefined) {
    nextCreds.password = normalizeOptionalString(creds.password);
    nextCreds.privateKey = undefined;
  } else if (creds.privateKey !== undefined) {
    nextCreds.privateKey = normalizeOptionalString(creds.privateKey);
    nextCreds.password = undefined;
  }

  const client = await sshConnect(nextCreds, creds.timeout ?? 15000);
  if (existing.client) {
    existing.client.removeAllListeners("error");
    existing.client.removeAllListeners("end");
    existing.client.removeAllListeners("close");
    try { existing.client.end(); } catch {}
  }

  existing.client = client;
  existing.label = nextCreds.label;
  existing.host = nextCreds.host;
  existing.port = nextCreds.port;
  existing.username = nextCreds.username;
  existing.proxyEnabled = nextCreds.proxyEnabled;
  existing.proxyUrl = nextCreds.proxyUrl;
  existing.lastUsedAt = Date.now();
  (existing as any)._creds = nextCreds;

  sessions.set(sessionId, existing);
  registerClientListeners(sessionId, client);
  saveSessionMeta();
  return existing;
}

export async function reconnectSessionById(sessionId: string): Promise<Session> {
  const existing = sessions.get(sessionId);
  if (!existing || existing.type !== "ssh") {
    throw new Error(`SSH Session '${sessionId}' not found`);
  }
  
  const stored = (existing as any)._creds;
  const creds: Partial<SshCredentials> = {
    host: existing.host,
    port: existing.port,
    username: existing.username,
    password: stored?.password,
    privateKey: stored?.privateKey,
    passphrase: stored?.passphrase,
    proxyEnabled: existing.proxyEnabled,
    proxyUrl: existing.proxyUrl,
  };
  
  return await createSession(creds, existing.label);
}

export function touchSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastUsedAt = Date.now();
    return true;
  }
  return false;
}

export function getSession(sessionId: string): Session | undefined {
  const session = sessions.get(sessionId);
  if (session) {
    touchSession(sessionId);
  }
  return session;
}

export function disconnectSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  // Clean up shells for this session
  import("./handlers/shell.js").then(({ closeShellsForSession }) => {
    try { closeShellsForSession(sessionId); } catch {}
  }).catch(() => {});

  if (session.type === "ssh" && session.client) {
    try {
      session.client.removeAllListeners();
      session.client.end();
    } catch {}
    session.client = undefined;
  }

  // Keep the entry in metadata so it survives restart (allows reconnect)
  saveSessionMeta();
  return true;
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;

  // 1. Clean up and close all shells associated with this session
  try {
    const { closeShellsForSession } = await import("./handlers/shell.js");
    closeShellsForSession(sessionId);
  } catch (e) {
    console.error(`[session] Failed to close shells for session ${sessionId}:`, e);
  }

  // 2. Disconnect active SSH client and remove all event listeners
  if (session.type === "ssh" && session.client) {
    try {
      session.client.removeAllListeners();
      session.client.end();
    } catch {}
    session.client = undefined;
  }

  // 3. Remove session from in-memory Map
  sessions.delete(sessionId);

  // 4. Save metadata to remove the session from disk (sessions-meta.json) and emit sessions_changed
  saveSessionMeta();

  return true;
}

export function listSessions(): Omit<Session, "client">[] {
  const result: Array<Omit<Session, "client"> & {
    authType?: "password" | "privateKey";
    hasPassword?: boolean;
    hasPrivateKey?: boolean;
    idleTimeoutMs: number;
    connected: boolean;
    proxyEnabled?: boolean;
    proxyUrl?: string;
  }> = [];
  for (const session of sessions.values()) {
    const stored = getStoredCredentials(session);
    result.push({
      id: session.id,
      type: session.type,
      label: session.label,
      host: session.host,
      port: session.port,
      username: session.username,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
      authType: stored?.privateKey ? "privateKey" : stored?.password ? "password" : undefined,
      hasPassword: Boolean(stored?.password),
      hasPrivateKey: Boolean(stored?.privateKey),
      connected: Boolean(session.client),
      proxyEnabled: session.proxyEnabled,
      proxyUrl: session.proxyUrl,
    });
  }
  return result;
}

/** Resolve sessionId or create a one-shot connection. */
export async function resolveClient(
  args: { sessionId?: string } & Partial<SshCredentials>,
  fn: (client: Client) => Promise<unknown>
): Promise<unknown> {
  if (args.sessionId) {
    const session = getSession(args.sessionId);
    if (!session) throw new Error(`Session '${args.sessionId}' not found or expired`);
    if (session.type !== "ssh") {
      throw new Error(`Session '${args.sessionId}' is not an SSH session`);
    }
    if (!session.client) {
      const stored = getStoredCredentials(session);
      if (stored && (stored.password || stored.privateKey)) {
        console.error(`[session] Attempting auto-reconnect for session ${session.id}...`);
        try {
          const timeout = args.timeout ?? 15000;
          const client = await sshConnect(stored, timeout);
          session.client = client;
          registerClientListeners(session.id, client);
          console.error(`[session] Auto-reconnected session ${session.id} successfully.`);
        } catch (err: any) {
          throw new Error(`Session '${args.sessionId}' is disconnected and auto-reconnect failed: ${err.message}`);
        }
      } else {
        throw new Error(`Session '${args.sessionId}' is disconnected and no credentials are available`);
      }
    }
    return fn(session.client);
  }
  // Stateless mode: connect, execute, disconnect
  const timeout = args.timeout ?? 30000;
  const client = await sshConnect(args, timeout);
  return fn(client).finally(() => {
    try { client.end(); } catch {}
  });
}

export async function shutdownAllSessions(): Promise<void> {
  try {
    const { closeAllShells } = await import("./handlers/shell.js");
    closeAllShells();
  } catch {}

  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  saveSessionMeta();
  for (const session of sessions.values()) {
    if (session.client) {
      session.client.removeAllListeners();
      try { session.client.end(); } catch {}
      session.client = undefined;
    }
  }
}
