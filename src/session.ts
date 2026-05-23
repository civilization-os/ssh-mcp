import { Client, ConnectConfig } from "ssh2";
import { Session, SshCredentials } from "./types.js";

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

let nextId = 1;
const sessions = new Map<string, Session>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
        try { session.client.end(); } catch { /* ignore */ }
        sessions.delete(id);
      }
    }
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
  const session: Session = {
    id: generateId(),
    client,
    label: label ?? `${creds.username ?? "root"}@${creds.host}:${creds.port ?? 22}`,
    host: creds.host ?? "unknown",
    port: creds.port ?? 22,
    username: creds.username ?? "root",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  sessions.set(session.id, session);
  startCleanup();
  return session;
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
  return true;
}

export function listSessions(): Omit<Session, "client">[] {
  const result: Omit<Session, "client">[] = [];
  for (const session of sessions.values()) {
    result.push({
      id: session.id,
      label: session.label,
      host: session.host,
      port: session.port,
      username: session.username,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
    });
  }
  return result;
}

/** Resolve sessionId or create a one-shot connection. Returns a cleanup function. */
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
