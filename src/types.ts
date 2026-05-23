import { Client } from "ssh2";

// --- Connection credentials (shared across tools) ---

export interface SshCredentials {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  timeout?: number;
}

// --- Session ---

export interface Session {
  id: string;
  client: Client;
  label: string;
  host: string;
  port: number;
  username: string;
  createdAt: number;
  lastUsedAt: number;
}

// --- Tool argument types ---

export interface SshConnectArgs extends SshCredentials {
  name?: string;
}

export interface SshDisconnectArgs {
  sessionId: string;
}

export type SshExecArgs = {
  sessionId?: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  timeout?: number;
} & Partial<SshCredentials>;

export interface SshBgRun {
  id: string;
  sessionId: string;
  pid: number;
  command: string;
  startedAt: number;
  outFile?: string;
}

export type SshExecBgArgs = {
  sessionId?: string;
  command: string;
  cwd?: string;
  sudo?: boolean;
  timeout?: number;
} & Partial<SshCredentials>;

export interface SshExecStopArgs {
  sessionId: string;
  runId?: string;
  pid?: number;
  force?: boolean;
}

export interface SshExecBgResultArgs {
  sessionId: string;
  runId: string;
}

export type SshScriptArgs = {
  sessionId?: string;
  script: string;
  interpreter?: string;
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshFileReadArgs = {
  sessionId?: string;
  path: string;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshFileWriteArgs = {
  sessionId?: string;
  path: string;
  content: string;
  mkdir?: boolean;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshFileListArgs = {
  sessionId?: string;
  path: string;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshFileDeleteArgs = {
  sessionId?: string;
  path: string;
  recursive?: boolean;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshFileRenameArgs = {
  sessionId?: string;
  source: string;
  dest: string;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshFileMkdirArgs = {
  sessionId?: string;
  path: string;
  parents?: boolean;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshFileChmodArgs = {
  sessionId?: string;
  path: string;
  mode: string;
  recursive?: boolean;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshFileStatArgs = {
  sessionId?: string;
  path: string;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshSysinfoArgs = {
  sessionId?: string;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshProcessesArgs = {
  sessionId?: string;
  sort?: "cpu" | "memory" | "pid";
  limit?: number;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshDiskUsageArgs = {
  sessionId?: string;
  path?: string;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshLogTailArgs = {
  sessionId?: string;
  path: string;
  lines?: number;
  timeout?: number;
} & Partial<SshCredentials>;

export type SshLogSearchArgs = {
  sessionId?: string;
  path: string;
  pattern: string;
  context?: number;
  timeout?: number;
} & Partial<SshCredentials>;

// --- Validation helpers ---

function isRecord(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function extractCredentials(args: Record<string, unknown>): Partial<SshCredentials> {
  return {
    host: str(args.host),
    port: num(args.port),
    username: str(args.username),
    password: str(args.password),
    privateKey: str(args.privateKey),
    passphrase: str(args.passphrase),
    timeout: num(args.timeout),
  };
}

export function extractSessionId(args: Record<string, unknown>): string | undefined {
  return str(args.sessionId);
}

export function validateSshExecBgArgs(args: unknown): args is SshExecBgArgs {
  return isRecord(args) && typeof args.command === "string";
}

export function validateSshExecStopArgs(args: unknown): args is SshExecStopArgs {
  return isRecord(args) && typeof args.sessionId === "string" && (typeof args.runId === "string" || typeof args.pid === "number");
}

export function validateSshExecBgResultArgs(args: unknown): args is SshExecBgResultArgs {
  return isRecord(args) && typeof args.sessionId === "string" && typeof args.runId === "string";
}

export function validateSshConnectArgs(args: unknown): args is SshConnectArgs {
  return isRecord(args) && typeof args.host === "string";
}

export function validateSshDisconnectArgs(args: unknown): args is SshDisconnectArgs {
  return isRecord(args) && typeof args.sessionId === "string";
}

export function validateSshExecArgs(args: unknown): args is SshExecArgs {
  return isRecord(args) && typeof args.command === "string";
}

export function validateSshScriptArgs(args: unknown): args is SshScriptArgs {
  return isRecord(args) && typeof args.script === "string";
}

export function validateSshFileReadArgs(args: unknown): args is SshFileReadArgs {
  return isRecord(args) && typeof args.path === "string";
}

export function validateSshFileWriteArgs(args: unknown): args is SshFileWriteArgs {
  return isRecord(args) && typeof args.path === "string" && typeof args.content === "string";
}

export function validateSshFileListArgs(args: unknown): args is SshFileListArgs {
  return isRecord(args) && typeof args.path === "string";
}

export function validateSshFileDeleteArgs(args: unknown): args is SshFileDeleteArgs {
  return isRecord(args) && typeof args.path === "string";
}

export function validateSshFileRenameArgs(args: unknown): args is SshFileRenameArgs {
  return isRecord(args) && typeof args.source === "string" && typeof args.dest === "string";
}

export function validateSshFileMkdirArgs(args: unknown): args is SshFileMkdirArgs {
  return isRecord(args) && typeof args.path === "string";
}

export function validateSshFileChmodArgs(args: unknown): args is SshFileChmodArgs {
  return isRecord(args) && typeof args.path === "string" && typeof args.mode === "string";
}

export function validateSshFileStatArgs(args: unknown): args is SshFileStatArgs {
  return isRecord(args) && typeof args.path === "string";
}

export function validateSshSysinfoArgs(_args: unknown): _args is SshSysinfoArgs {
  return isRecord(_args);
}

export function validateSshProcessesArgs(_args: unknown): _args is SshProcessesArgs {
  return isRecord(_args);
}

export function validateSshDiskUsageArgs(_args: unknown): _args is SshDiskUsageArgs {
  return isRecord(_args);
}

export function validateSshLogTailArgs(args: unknown): args is SshLogTailArgs {
  return isRecord(args) && typeof args.path === "string";
}

export function validateSshLogSearchArgs(args: unknown): args is SshLogSearchArgs {
  return isRecord(args) && typeof args.path === "string" && typeof args.pattern === "string";
}
