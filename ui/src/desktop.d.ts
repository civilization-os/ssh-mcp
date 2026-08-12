interface SshMcpDesktopState {
  desktop: true;
  version: string;
  port: number;
  mcpEnabled: boolean;
  shuttingDown: boolean;
}

type SshMcpProxyMode = "system" | "direct" | "fixed";

interface SshMcpProxySettings {
  mode: SshMcpProxyMode;
  url: string;
  bypassRules: string;
  username: string;
  password: string;
  hasPassword: boolean;
  clearPassword: boolean;
}

interface SshMcpApplicationSettings {
  proxy: SshMcpProxySettings;
  autoCheckUpdates: boolean;
}

type SshMcpUpdatePhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "up-to-date" | "not-published" | "error" | "unsupported";

interface SshMcpUpdateState {
  phase: SshMcpUpdatePhase;
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

interface SshMcpDesktopApi {
  getState(): Promise<SshMcpDesktopState>;
  setMcpEnabled(enabled: boolean): Promise<SshMcpDesktopState>;
  getSettings(): Promise<SshMcpApplicationSettings>;
  setProxy(settings: SshMcpProxySettings): Promise<SshMcpApplicationSettings>;
  setAutoCheckUpdates(enabled: boolean): Promise<SshMcpApplicationSettings>;
  getUpdateState(): Promise<SshMcpUpdateState>;
  checkForUpdates(): Promise<SshMcpUpdateState>;
  downloadUpdate(): Promise<SshMcpUpdateState>;
  installUpdate(): Promise<void>;
  quit(): Promise<void>;
  onStateChanged(listener: (state: SshMcpDesktopState) => void): () => void;
  onUpdateStateChanged(listener: (state: SshMcpUpdateState) => void): () => void;
}

interface Window {
  sshMcpDesktop?: SshMcpDesktopApi;
}
