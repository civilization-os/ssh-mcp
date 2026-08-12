import { contextBridge, ipcRenderer } from "electron";

export interface DesktopState {
  desktop: true;
  mcpEnabled: boolean;
  port: number;
  version: string;
  shuttingDown: boolean;
}

export interface DesktopProxySettings {
  mode: "system" | "direct" | "fixed";
  url: string;
  bypassRules: string;
  username: string;
  password: string;
  hasPassword: boolean;
  clearPassword: boolean;
}

export interface DesktopSettings {
  proxy: DesktopProxySettings;
  autoCheckUpdates: boolean;
}

export interface DesktopUpdateState {
  phase: "idle" | "checking" | "available" | "downloading" | "downloaded" | "up-to-date" | "not-published" | "error" | "unsupported";
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

contextBridge.exposeInMainWorld("sshMcpDesktop", {
  getState: (): Promise<DesktopState> => ipcRenderer.invoke("desktop:get-state"),
  setMcpEnabled: (enabled: boolean): Promise<DesktopState> =>
    ipcRenderer.invoke("desktop:set-mcp-enabled", enabled),
  getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke("desktop:get-settings"),
  setProxy: (settings: DesktopProxySettings): Promise<DesktopSettings> =>
    ipcRenderer.invoke("desktop:set-proxy", settings),
  setAutoCheckUpdates: (enabled: boolean): Promise<DesktopSettings> =>
    ipcRenderer.invoke("desktop:set-auto-check-updates", enabled),
  getUpdateState: (): Promise<DesktopUpdateState> => ipcRenderer.invoke("desktop:get-update-state"),
  checkForUpdates: (): Promise<DesktopUpdateState> => ipcRenderer.invoke("desktop:check-for-updates"),
  downloadUpdate: (): Promise<DesktopUpdateState> => ipcRenderer.invoke("desktop:download-update"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("desktop:install-update"),
  quit: (): Promise<void> => ipcRenderer.invoke("desktop:quit"),
  onStateChanged: (listener: (state: DesktopState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopState) => listener(state);
    ipcRenderer.on("desktop:state-changed", handler);
    return () => ipcRenderer.removeListener("desktop:state-changed", handler);
  },
  onUpdateStateChanged: (listener: (state: DesktopUpdateState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) => listener(state);
    ipcRenderer.on("desktop:update-state-changed", handler);
    return () => ipcRenderer.removeListener("desktop:update-state-changed", handler);
  },
});
