import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DesktopRuntimeState {
  schemaVersion: 1;
  appName: "SSH-MCP Desktop";
  appVersion: string;
  pid: number;
  port: number;
  token: string;
  mcpEnabled: boolean;
  startedAt: string;
}

const APP_DIRECTORY_NAME = "SSH-MCP Desktop";
const RUNTIME_FILE_NAME = "runtime.json";

export function getDefaultDesktopDataDirectory(): string {
  if (process.env.SSH_MCP_DATA_DIR?.trim()) {
    return path.resolve(process.env.SSH_MCP_DATA_DIR.trim());
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, APP_DIRECTORY_NAME);
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DIRECTORY_NAME);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ssh-mcp-desktop");
}

export function getDesktopRuntimeFilePath(): string {
  return process.env.SSH_MCP_RUNTIME_FILE?.trim()
    ? path.resolve(process.env.SSH_MCP_RUNTIME_FILE.trim())
    : path.join(getDefaultDesktopDataDirectory(), RUNTIME_FILE_NAME);
}

export function registerDesktopBridge(state: DesktopRuntimeState): () => void {
  const bridgeDirectory = path.join(path.dirname(getDesktopRuntimeFilePath()), "bridges");
  const bridgePath = path.join(bridgeDirectory, `${process.pid}.json`);
  fs.mkdirSync(bridgeDirectory, { recursive: true });
  fs.writeFileSync(bridgePath, JSON.stringify({
    pid: process.pid,
    desktopPid: state.pid,
    desktopStartedAt: state.startedAt,
  }), { encoding: "utf-8", mode: 0o600 });

  const unregister = () => {
    try { fs.rmSync(bridgePath, { force: true }); } catch {}
  };
  process.once("exit", unregister);
  return unregister;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readDesktopRuntimeState(): DesktopRuntimeState | null {
  try {
    const runtimePath = getDesktopRuntimeFilePath();
    const state = JSON.parse(fs.readFileSync(runtimePath, "utf-8")) as Partial<DesktopRuntimeState>;
    if (
      state.schemaVersion !== 1 ||
      state.appName !== APP_DIRECTORY_NAME ||
      typeof state.pid !== "number" ||
      typeof state.port !== "number" ||
      typeof state.token !== "string" ||
      !state.token ||
      typeof state.mcpEnabled !== "boolean"
    ) {
      return null;
    }
    if (!isProcessAlive(state.pid)) return null;
    return state as DesktopRuntimeState;
  } catch {
    return null;
  }
}

export function getDesktopDaemonUrl(state: DesktopRuntimeState): string {
  return `http://127.0.0.1:${state.port}`;
}

export function getDesktopAuthorizationHeaders(state: DesktopRuntimeState): Record<string, string> {
  return { Authorization: `Bearer ${state.token}` };
}

export function requireEnabledDesktopRuntime(): DesktopRuntimeState {
  const state = readDesktopRuntimeState();
  if (!state) {
    throw new Error("SSH-MCP Desktop is not running. Open the Desktop app and enable MCP access.");
  }
  if (!state.mcpEnabled) {
    throw new Error("MCP access is disabled in SSH-MCP Desktop.");
  }
  return state;
}
