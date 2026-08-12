import { app } from "electron";
import type { AuthInfo, ProxyConfig } from "electron";
import { createRequire } from "node:module";
import type { ProgressInfo, UpdateInfo } from "electron-updater";

const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "not-published"
  | "error"
  | "unsupported";

export interface DesktopUpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  percent: number | null;
  transferred: number | null;
  total: number | null;
  bytesPerSecond: number | null;
  message: string;
}

let initialized = false;
let onStateChanged: ((state: DesktopUpdateState) => void) | null = null;
let proxyCredentials: UpdaterProxyCredentials | null = null;

export interface UpdaterProxyCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}
let state: DesktopUpdateState = {
  phase: "idle",
  currentVersion: app.getVersion(),
  availableVersion: null,
  releaseName: null,
  releaseNotes: null,
  releaseDate: null,
  percent: null,
  transferred: null,
  total: null,
  bytesPerSecond: null,
  message: "",
};

function emit(patch: Partial<DesktopUpdateState>): DesktopUpdateState {
  state = { ...state, ...patch };
  onStateChanged?.(state);
  return state;
}

function notesToText(notes: UpdateInfo["releaseNotes"]): string | null {
  if (typeof notes === "string") return notes.trim() || null;
  if (!Array.isArray(notes)) return null;
  const text = notes
    .map(note => [note.version, note.note].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
  return text || null;
}

function applyUpdateInfo(info: UpdateInfo): Partial<DesktopUpdateState> {
  return {
    availableVersion: info.version || null,
    releaseName: info.releaseName || null,
    releaseNotes: notesToText(info.releaseNotes),
    releaseDate: info.releaseDate || null,
  };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message;
}

function isUpdateChannelMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /latest\.yml|404|406|no published versions|unable to find latest version|production release exists|releases feed/i.test(message);
}

function emitUpdateError(error: unknown): DesktopUpdateState {
  if (isUpdateChannelMissing(error)) {
    return emit({
      phase: "not-published",
      message: "The Desktop update channel has not been published yet.",
      availableVersion: null,
      percent: null,
    });
  }
  return emit({ phase: "error", message: describeError(error) });
}

export function initializeUpdateManager(listener: (state: DesktopUpdateState) => void): void {
  onStateChanged = listener;
  if (initialized) return;
  initialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = console;

  autoUpdater.on("login", (authInfo: AuthInfo, callback: (username: string, password: string) => void) => {
    const credentials = proxyCredentials;
    const challengeHost = authInfo.host.replace(/^\[|\]$/g, "").toLowerCase();
    const configuredHost = credentials?.host.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      !authInfo.isProxy ||
      !credentials ||
      challengeHost !== configuredHost ||
      authInfo.port !== credentials.port
    ) {
      callback("", "");
      return;
    }
    callback(credentials.username, credentials.password);
  });

  autoUpdater.on("checking-for-update", () => {
    emit({ phase: "checking", message: "Checking GitHub Releases for updates…", percent: null });
  });
  autoUpdater.on("update-available", info => {
    emit({
      phase: "available",
      ...applyUpdateInfo(info),
      message: `Version ${info.version} is available.`,
      percent: null,
    });
  });
  autoUpdater.on("update-not-available", info => {
    emit({
      phase: "up-to-date",
      ...applyUpdateInfo(info),
      availableVersion: null,
      message: "You are using the latest version.",
      percent: null,
    });
  });
  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    emit({
      phase: "downloading",
      percent: Math.max(0, Math.min(100, progress.percent)),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      message: `Downloading update… ${Math.round(progress.percent)}%`,
    });
  });
  autoUpdater.on("update-downloaded", info => {
    emit({
      phase: "downloaded",
      ...applyUpdateInfo(info),
      percent: 100,
      message: "The update is ready. Restart to install it.",
    });
  });
  autoUpdater.on("error", error => {
    emitUpdateError(error);
  });
}

export function getUpdateState(): DesktopUpdateState {
  return state;
}

export async function applyUpdaterProxy(
  config: ProxyConfig,
  credentials: UpdaterProxyCredentials | null = null,
): Promise<void> {
  proxyCredentials = credentials;
  await autoUpdater.netSession.setProxy(config);
  await autoUpdater.netSession.closeAllConnections();
}

export async function checkForUpdates(): Promise<DesktopUpdateState> {
  if (!app.isPackaged) {
    return emit({
      phase: "unsupported",
      message: "Online updates are available in packaged builds only.",
    });
  }
  if (state.phase === "checking" || state.phase === "downloading") return state;
  emit({ phase: "checking", message: "Checking GitHub Releases for updates…", percent: null });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    emitUpdateError(error);
  }
  return state;
}

export async function downloadUpdate(): Promise<DesktopUpdateState> {
  if (state.phase !== "available") {
    throw new Error("No update is ready to download.");
  }
  emit({ phase: "downloading", message: "Preparing update download…", percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    emitUpdateError(error);
  }
  return state;
}

export function quitAndInstallUpdate(): void {
  if (state.phase !== "downloaded") throw new Error("The update has not finished downloading.");
  autoUpdater.quitAndInstall(false, true);
}
