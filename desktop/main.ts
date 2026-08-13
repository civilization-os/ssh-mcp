import { app, BrowserWindow, ipcMain, safeStorage, session, shell, utilityProcess } from "electron";
import type { ProxyConfig, UtilityProcess } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import nodeNet from "node:net";
import path from "node:path";
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  initializeUpdateManager,
  applyUpdaterProxy,
  quitAndInstallUpdate,
} from "./updateManager.js";

type ProxyMode = "system" | "direct" | "fixed";

interface DesktopProxySettings {
  mode: ProxyMode;
  url: string;
  bypassRules: string;
  username: string;
  passwordEncrypted?: string;
}

interface RendererProxySettings {
  mode: ProxyMode;
  url: string;
  bypassRules: string;
  username: string;
  password: string;
  hasPassword: boolean;
  clearPassword: boolean;
}

interface DesktopSettings {
  mcpEnabled: boolean;
  proxy: DesktopProxySettings;
  autoCheckUpdates: boolean;
}

interface DesktopRuntimeState {
  schemaVersion: 1;
  appName: "SSH-MCP Desktop";
  appVersion: string;
  pid: number;
  port: number;
  token: string;
  mcpEnabled: boolean;
  startedAt: string;
}

interface RendererDesktopState {
  desktop: true;
  version: string;
  port: number;
  bridgePath: string;
  mcpEnabled: boolean;
  shuttingDown: boolean;
}

const APP_NAME = "SSH-MCP Desktop";
const APP_ID = "io.civilization.sshmcp.desktop";
const DEFAULT_PORT = 12222;
const MAX_PORT_ATTEMPTS = 20;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_PROXY_SETTINGS: DesktopProxySettings = {
  mode: "system",
  url: "",
  bypassRules: "",
  username: "",
};

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let coreProcess: UtilityProcess | null = null;
let coreExitPromise: Promise<number> | null = null;
let desktopPort = DEFAULT_PORT;
let desktopToken = "";
let mcpEnabled = false;
let proxySettings: DesktopProxySettings = { ...DEFAULT_PROXY_SETTINGS };
let proxyPassword = "";
let autoCheckUpdates = true;
let shuttingDown = false;
let shutdownFinished = false;
let startedAt = new Date().toISOString();

function getUserDataDirectory(): string {
  return app.getPath("userData");
}

function getSettingsPath(): string {
  return path.join(getUserDataDirectory(), "settings.json");
}

function getRuntimePath(): string {
  return path.join(getUserDataDirectory(), "runtime.json");
}

function getWindowIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(app.getAppPath(), "desktop", "resources", "icon.png");
}

function readSettings(): DesktopSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsPath(), "utf-8")) as Partial<DesktopSettings>;
    return {
      mcpEnabled: parsed.mcpEnabled === true,
      proxy: normalizeProxySettings(parsed.proxy),
      autoCheckUpdates: parsed.autoCheckUpdates !== false,
    };
  } catch {
    return {
      mcpEnabled: false,
      proxy: { ...DEFAULT_PROXY_SETTINGS },
      autoCheckUpdates: true,
    };
  }
}

function writeJsonAtomically(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temporaryPath, targetPath);
  try { fs.chmodSync(targetPath, 0o600); } catch {}
}

function persistSettings(): void {
  writeJsonAtomically(getSettingsPath(), {
    mcpEnabled,
    proxy: proxySettings,
    autoCheckUpdates,
  } satisfies DesktopSettings);
}

function normalizeProxySettings(value: unknown): DesktopProxySettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_PROXY_SETTINGS };
  const candidate = value as Partial<DesktopProxySettings>;
  const mode: ProxyMode = candidate.mode === "direct" || candidate.mode === "fixed" ? candidate.mode : "system";
  const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
  const bypassRules = typeof candidate.bypassRules === "string" ? candidate.bypassRules.trim() : "";
  const username = typeof candidate.username === "string" ? candidate.username.trim() : "";
  const passwordEncrypted = typeof candidate.passwordEncrypted === "string" && candidate.passwordEncrypted
    ? candidate.passwordEncrypted
    : undefined;
  if (mode === "fixed") validateProxyUrl(url);
  return { mode, url, bypassRules, username, passwordEncrypted };
}

function validateProxyUrl(value: string): void {
  if (!value) throw new Error("A proxy URL is required in manual mode.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Enter a valid proxy URL, for example http://127.0.0.1:7890."); }
  if (!["http:", "https:", "socks4:", "socks5:"].includes(parsed.protocol)) {
    throw new Error("Proxy URL must use http, https, socks4, or socks5.");
  }
  if (!parsed.hostname || !parsed.port) throw new Error("Proxy URL must include a host and port.");
  if (parsed.username || parsed.password) throw new Error("Enter proxy credentials in the username and password fields, not in the URL.");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("Proxy URL cannot contain a path, query, or fragment.");
}

function getProxyConfig(settings: DesktopProxySettings): ProxyConfig {
  if (settings.mode === "direct") return { mode: "direct" };
  if (settings.mode === "system") return { mode: "system" };
  const localBypass = ["<local>", "127.0.0.1", "localhost", "[::1]"];
  const customBypass = settings.bypassRules.split(/[;,\n]/).map(rule => rule.trim()).filter(Boolean);
  return {
    mode: "fixed_servers",
    proxyRules: settings.url,
    proxyBypassRules: [...new Set([...localBypass, ...customBypass])].join(","),
  };
}

async function applyProxySettings(settings: DesktopProxySettings): Promise<void> {
  return applyProxySettingsWithPassword(settings, proxyPassword);
}

async function applyProxySettingsWithPassword(settings: DesktopProxySettings, password: string): Promise<void> {
  const config = getProxyConfig(settings);
  const authority = configuredProxyAuthority(settings);
  const updaterCredentials = authority && settings.username && password
    ? { ...authority, username: settings.username, password }
    : null;
  await Promise.all([
    session.defaultSession.setProxy(config),
    applyUpdaterProxy(config, updaterCredentials),
  ]);
  await session.defaultSession.closeAllConnections();
}

function getApplicationSettings() {
  return {
    proxy: {
      mode: proxySettings.mode,
      url: proxySettings.url,
      bypassRules: proxySettings.bypassRules,
      username: proxySettings.username,
      password: "",
      hasPassword: Boolean(proxyPassword),
      clearPassword: false,
    } satisfies RendererProxySettings,
    autoCheckUpdates,
  };
}

async function setApplicationProxy(value: unknown) {
  if (!value || typeof value !== "object") throw new TypeError("Proxy settings are required.");
  const input = value as Partial<RendererProxySettings>;
  const next = normalizeProxySettings(input);
  const suppliedPassword = typeof input.password === "string" ? input.password : "";
  const clearPassword = input.clearPassword === true || !next.username;
  const nextPassword = clearPassword ? "" : suppliedPassword || proxyPassword;
  next.passwordEncrypted = nextPassword ? await encryptProxyPassword(nextPassword) : undefined;
  await applyProxySettingsWithPassword(next, nextPassword);
  proxySettings = next;
  proxyPassword = nextPassword;
  persistSettings();
  return getApplicationSettings();
}

async function encryptProxyPassword(password: string): Promise<string> {
  if (!await safeStorage.isAsyncEncryptionAvailable()) {
    throw new Error("The operating system secure storage is unavailable; the proxy password was not saved.");
  }
  return (await safeStorage.encryptStringAsync(password)).toString("base64");
}

async function loadProxyPassword(): Promise<void> {
  proxyPassword = "";
  if (!proxySettings.passwordEncrypted) return;
  try {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error("OS secure storage is unavailable");
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(proxySettings.passwordEncrypted, "base64"));
    proxyPassword = decrypted.result;
    if (decrypted.shouldReEncrypt && proxyPassword) {
      proxySettings.passwordEncrypted = await encryptProxyPassword(proxyPassword);
      persistSettings();
    }
  } catch (error) {
    console.error("[desktop] Failed to decrypt saved proxy password:", error);
  }
}

function configuredProxyAuthority(settings: DesktopProxySettings = proxySettings): { host: string; port: number } | null {
  if (settings.mode !== "fixed") return null;
  try {
    const parsed = new URL(settings.url);
    return { host: parsed.hostname.toLowerCase(), port: Number(parsed.port) };
  } catch {
    return null;
  }
}

function setAutoCheckUpdates(value: unknown) {
  if (typeof value !== "boolean") throw new TypeError("autoCheckUpdates must be a boolean");
  autoCheckUpdates = value;
  persistSettings();
  return getApplicationSettings();
}

function getRuntimeState(): DesktopRuntimeState {
  return {
    schemaVersion: 1,
    appName: APP_NAME,
    appVersion: app.getVersion(),
    pid: process.pid,
    port: desktopPort,
    token: desktopToken,
    mcpEnabled,
    startedAt,
  };
}

function persistRuntimeState(): void {
  writeJsonAtomically(getRuntimePath(), getRuntimeState());
}

function getRendererState(): RendererDesktopState {
  return {
    desktop: true,
    version: app.getVersion(),
    port: desktopPort,
    bridgePath: path.join(path.dirname(process.execPath), "ssh-mcp-bridge.cmd"),
    mcpEnabled,
    shuttingDown,
  };
}

function broadcastDesktopState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:state-changed", getRendererState());
  }
}

function broadcastUpdateState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:update-state-changed", getUpdateState());
  }
}

function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = nodeNet.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(): Promise<number> {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const candidate = DEFAULT_PORT + offset;
    if (await canListen(candidate)) return candidate;
  }
  throw new Error(`No available Desktop port found between ${DEFAULT_PORT} and ${DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1}`);
}

async function waitForCoreReady(): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${desktopPort}/api/version`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("SSH-MCP Core did not become ready in time");
}

function getCoreModulePath(): string {
  return path.join(app.getAppPath(), "build", "daemon.js");
}

function startCoreProcess(): void {
  const environment = Object.fromEntries(
    Object.entries({
      ...process.env,
      PORT: String(desktopPort),
      SSH_MCP_AUTH_TOKEN: desktopToken,
      SSH_MCP_ENABLED: mcpEnabled ? "1" : "0",
      SSH_MCP_DATA_DIR: getUserDataDirectory(),
      SSH_MCP_DESKTOP_MANAGED: "1",
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );

  const child = utilityProcess.fork(getCoreModulePath(), [], {
    env: environment,
    serviceName: "SSH-MCP Core Runtime",
    stdio: "pipe",
  });
  coreProcess = child;
  coreExitPromise = new Promise(resolve => child.once("exit", code => resolve(code)));

  child.stdout?.on("data", chunk => console.log(`[core] ${chunk.toString().trimEnd()}`));
  child.stderr?.on("data", chunk => console.error(`[core] ${chunk.toString().trimEnd()}`));
}

async function updateCoreMcpState(enabled: boolean): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${desktopPort}/api/desktop/mcp-state`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${desktopToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error(`Core rejected MCP state update (${response.status})`);
}

async function setMcpEnabled(enabled: boolean): Promise<RendererDesktopState> {
  if (shuttingDown) throw new Error("SSH-MCP Desktop is shutting down");
  await updateCoreMcpState(enabled);
  mcpEnabled = enabled;
  persistSettings();
  persistRuntimeState();
  broadcastDesktopState();
  return getRendererState();
}

function configureAuthorizedRequests(window: BrowserWindow): void {
  const requestFilter = {
    urls: [
      `http://127.0.0.1:${desktopPort}/*`,
      `ws://127.0.0.1:${desktopPort}/*`,
    ],
  };
  window.webContents.session.webRequest.onBeforeSendHeaders(requestFilter, (details, callback) => {
    details.requestHeaders.Authorization = `Bearer ${desktopToken}`;
    callback({ requestHeaders: details.requestHeaders });
  });
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: "#0b131c",
    title: APP_NAME,
    icon: getWindowIconPath(),
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0b131c",
      symbolColor: "#dce6ee",
      height: 42,
    },
    webPreferences: {
      preload: path.join(app.getAppPath(), "desktop-dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  await Promise.all([
    window.webContents.session.clearStorageData({
      origin: `http://127.0.0.1:${desktopPort}`,
      storages: ["serviceworkers", "cachestorage"],
    }),
    window.webContents.session.clearCache(),
  ]);
  configureAuthorizedRequests(window);

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.once("ready-to-show", () => window.show());
  window.on("close", event => {
    if (!shutdownFinished) {
      event.preventDefault();
      void shutdownAndExit("window-close");
    }
  });
  window.on("closed", () => { mainWindow = null; });

  await window.loadURL(`http://127.0.0.1:${desktopPort}/`);
}

async function stopCoreProcess(): Promise<void> {
  const child = coreProcess;
  if (!child) return;

  try { child.postMessage({ type: "shutdown" }); } catch {}

  const exited = await Promise.race([
    coreExitPromise?.then(() => true) ?? Promise.resolve(true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS)),
  ]);
  if (!exited) child.kill();
  coreProcess = null;
  coreExitPromise = null;
}

async function stopRegisteredBridgeProcesses(): Promise<void> {
  const bridgeDirectory = path.join(getUserDataDirectory(), "bridges");
  let entries: string[] = [];
  try { entries = fs.readdirSync(bridgeDirectory); } catch { return; }

  for (const entry of entries) {
    const bridgePath = path.join(bridgeDirectory, entry);
    try {
      const bridge = JSON.parse(fs.readFileSync(bridgePath, "utf-8")) as {
        pid?: unknown;
        desktopPid?: unknown;
        desktopStartedAt?: unknown;
      };
      if (
        typeof bridge.pid === "number" &&
        bridge.pid !== process.pid &&
        bridge.desktopPid === process.pid &&
        bridge.desktopStartedAt === startedAt
      ) {
        try { process.kill(bridge.pid, "SIGTERM"); } catch {}
      }
    } catch {}
    try { fs.rmSync(bridgePath, { force: true }); } catch {}
  }
  try { fs.rmdirSync(bridgeDirectory); } catch {}
}

async function prepareForShutdown(reason: string): Promise<boolean> {
  if (shuttingDown) return false;
  shuttingDown = true;
  console.log(`[desktop] Full shutdown requested (${reason})`);

  mcpEnabled = false;
  broadcastDesktopState();
  try { await updateCoreMcpState(false); } catch {}
  try { persistSettings(); } catch {}
  try { persistRuntimeState(); } catch {}

  await stopCoreProcess();
  try { fs.rmSync(getRuntimePath(), { force: true }); } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
  await stopRegisteredBridgeProcesses();

  return true;
}

async function shutdownAndExit(reason: string): Promise<void> {
  if (!await prepareForShutdown(reason)) return;

  shutdownFinished = true;
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(0);
}

async function installDownloadedUpdate(): Promise<void> {
  if (!await prepareForShutdown("update-install")) return;
  shutdownFinished = true;
  quitAndInstallUpdate();
}

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:get-state", () => getRendererState());
  ipcMain.handle("desktop:set-mcp-enabled", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    return setMcpEnabled(enabled);
  });
  ipcMain.handle("desktop:get-settings", () => getApplicationSettings());
  ipcMain.handle("desktop:set-proxy", (_event, value: unknown) => setApplicationProxy(value));
  ipcMain.handle("desktop:set-auto-check-updates", (_event, value: unknown) => setAutoCheckUpdates(value));
  ipcMain.handle("desktop:get-update-state", () => getUpdateState());
  ipcMain.handle("desktop:check-for-updates", () => checkForUpdates());
  ipcMain.handle("desktop:download-update", () => downloadUpdate());
  ipcMain.handle("desktop:install-update", () => installDownloadedUpdate());
  ipcMain.handle("desktop:quit", () => shutdownAndExit("renderer"));
}

async function bootstrap(): Promise<void> {
  const settings = readSettings();
  mcpEnabled = settings.mcpEnabled;
  proxySettings = settings.proxy;
  autoCheckUpdates = settings.autoCheckUpdates;
  await loadProxyPassword();
  await applyProxySettings(proxySettings);
  desktopPort = await findAvailablePort();
  desktopToken = crypto.randomBytes(32).toString("hex");
  startedAt = new Date().toISOString();

  startCoreProcess();
  await waitForCoreReady();
  persistRuntimeState();
  initializeUpdateManager(broadcastUpdateState);
  registerIpcHandlers();
  await createMainWindow();
  if (autoCheckUpdates && app.isPackaged) {
    setTimeout(() => { void checkForUpdates(); }, 4_000);
  }
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("login", (event, _webContents, _details, authInfo, callback) => {
  if (!authInfo.isProxy || !proxySettings.username || !proxyPassword) return;
  const authority = configuredProxyAuthority();
  const challengeHost = authInfo.host.replace(/^\[|\]$/g, "").toLowerCase();
  const configuredHost = authority?.host.replace(/^\[|\]$/g, "");
  if (!authority || configuredHost !== challengeHost || authority.port !== authInfo.port) return;
  event.preventDefault();
  callback(proxySettings.username, proxyPassword);
});

app.on("before-quit", event => {
  if (!shutdownFinished) {
    event.preventDefault();
    void shutdownAndExit("before-quit");
  }
});

app.on("window-all-closed", () => {
  if (!shutdownFinished) void shutdownAndExit("window-all-closed");
});

if (hasSingleInstanceLock) {
  app.whenReady().then(bootstrap).catch(error => {
    console.error("[desktop] Startup failed:", error);
    void shutdownAndExit("startup-failure");
  });
}
