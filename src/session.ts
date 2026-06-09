import { Client, ConnectConfig } from "ssh2";
import { Session, SshCredentials } from "./types.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_STORE_PATH = path.join(__dirname, "..", "sessions-store.json");

export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

let nextId = 1;
const sessions = new Map<string, Session>();

// 凭据持久化存储结构
interface StoredCredentials {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  kubectlPath?: string;
  kubeconfig?: string;
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getStoredCredentials(session: Session): StoredCredentials | undefined {
  return (session as any)._creds as StoredCredentials | undefined;
}

// ======== 持久化读写 ========

function saveSessionsStore() {
  try {
    const stored: StoredCredentials[] = [];
    for (const [id, session] of sessions) {
      const cred = (session as any)._creds as StoredCredentials | undefined;
      if (cred) stored.push({ ...cred, id });
    }
    fs.writeFileSync(SESSIONS_STORE_PATH, JSON.stringify(stored, null, 2), "utf-8");
  } catch (e) {
    console.error("[session] Failed to save sessions store:", e);
  }
}

function loadStoredCredentials(): StoredCredentials[] {
  try {
    if (!fs.existsSync(SESSIONS_STORE_PATH)) return [];
    const raw = fs.readFileSync(SESSIONS_STORE_PATH, "utf-8");
    return JSON.parse(raw) as StoredCredentials[];
  } catch {
    return [];
  }
}

/** 启动时读取持久化文件并逐一重连，失败则跳过 */
export async function loadAndReconnectSessions(): Promise<void> {
  const stored = loadStoredCredentials();
  if (stored.length === 0) return;
  console.error(`[session] Restoring ${stored.length} persisted session(s)...`);

  for (const cred of stored) {
    try {
      const client = await sshConnect(cred, 10000);
      const session: Session = {
        id: cred.id,
        client,
        label: cred.label,
        host: cred.host,
        port: cred.port,
        username: cred.username,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        kubectlPath: cred.kubectlPath,
        kubeconfig: cred.kubeconfig,
      };
      (session as any)._creds = cred;
      sessions.set(session.id, session);
      startCleanup();
      console.error(`[session] Restored: ${cred.label} (${cred.id})`);
    } catch (e: any) {
      console.error(`[session] Failed to restore ${cred.label}: ${e.message}`);
    }
  }
  // 重新保存（跳过失败的连接）
  saveSessionsStore();
}

// ======== 工具函数 ========

function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, session] of sessions) {
      if (now - session.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
        try { session.client.end(); } catch { /* ignore */ }
        sessions.delete(id);
        changed = true;
      }
    }
    if (changed) saveSessionsStore();
    if (sessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
}

function generateId(): string {
  return `sess_${Date.now()}_${nextId++}`;
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

export function sshConnect(creds: Partial<SshCredentials>, timeoutMs: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const config = buildConnectConfig(creds);
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`SSH connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    client.on("ready", () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    client.connect(config);
  });
}

export async function createSession(creds: Partial<SshCredentials>, label?: string): Promise<Session> {
  const timeout = creds.timeout ?? 15000;
  const client = await sshConnect(creds, timeout);
  const id = generateId();
  const session: Session = {
    id,
    client,
    label: label ?? `${creds.username ?? "root"}@${creds.host}:${creds.port ?? 22}`,
    host: creds.host ?? "unknown",
    port: creds.port ?? 22,
    username: creds.username ?? "root",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    kubectlPath: creds.kubectlPath,
    kubeconfig: creds.kubeconfig,
  };

  // 存储凭据供持久化使用
  const storedCred: StoredCredentials = {
    id,
    label: session.label,
    host: session.host,
    port: session.port,
    username: session.username,
    password: creds.password,
    privateKey: creds.privateKey ? String(creds.privateKey) : undefined,
    passphrase: creds.passphrase,
    kubectlPath: creds.kubectlPath,
    kubeconfig: creds.kubeconfig,
  };
  (session as any)._creds = storedCred;

  sessions.set(session.id, session);
  startCleanup();
  saveSessionsStore();
  return session;
}

export async function updateSession(sessionId: string, creds: Partial<SshCredentials>, label?: string): Promise<Session> {
  const existing = sessions.get(sessionId);
  if (!existing) {
    throw new Error(`Session '${sessionId}' not found`);
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
    kubectlPath: creds.kubectlPath !== undefined ? normalizeOptionalString(creds.kubectlPath) : stored.kubectlPath,
    kubeconfig: creds.kubeconfig !== undefined ? normalizeOptionalString(creds.kubeconfig) : stored.kubeconfig,
  };

  if (creds.password !== undefined) {
    nextCreds.password = normalizeOptionalString(creds.password);
    nextCreds.privateKey = undefined;
  } else if (creds.privateKey !== undefined) {
    nextCreds.privateKey = normalizeOptionalString(creds.privateKey);
    nextCreds.password = undefined;
  }

  const client = await sshConnect(nextCreds, creds.timeout ?? 15000);
  try { existing.client.end(); } catch { /* ignore */ }

  existing.client = client;
  existing.label = nextCreds.label;
  existing.host = nextCreds.host;
  existing.port = nextCreds.port;
  existing.username = nextCreds.username;
  existing.kubectlPath = nextCreds.kubectlPath;
  existing.kubeconfig = nextCreds.kubeconfig;
  existing.lastUsedAt = Date.now();
  (existing as any)._creds = nextCreds;

  sessions.set(sessionId, existing);
  saveSessionsStore();
  return existing;
}

export function getSession(sessionId: string): Session | undefined {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastUsedAt = Date.now();
  }
  return session;
}

export function disconnectSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  try { session.client.end(); } catch { /* ignore */ }
  sessions.delete(sessionId);
  saveSessionsStore();
  return true;
}

export function listSessions(): Omit<Session, "client">[] {
  const result: Array<Omit<Session, "client"> & {
    authType?: "password" | "privateKey";
    hasPassword?: boolean;
    hasPrivateKey?: boolean;
    idleTimeoutMs: number;
  }> = [];
  for (const session of sessions.values()) {
    const stored = getStoredCredentials(session);
    result.push({
      id: session.id,
      label: session.label,
      host: session.host,
      port: session.port,
      username: session.username,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      kubectlPath: session.kubectlPath,
      kubeconfig: session.kubeconfig,
      idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
      authType: stored?.privateKey ? "privateKey" : stored?.password ? "password" : undefined,
      hasPassword: Boolean(stored?.password),
      hasPrivateKey: Boolean(stored?.privateKey),
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
    return fn(session.client);
  }
  // Stateless mode: connect, execute, disconnect
  const timeout = args.timeout ?? 30000;
  const client = await sshConnect(args, timeout);
  return fn(client).finally(() => {
    try { client.end(); } catch { /* ignore */ }
  });
}
