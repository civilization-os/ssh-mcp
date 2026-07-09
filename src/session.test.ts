import { describe, it, expect, vi } from "vitest";
import {
  buildConnectConfig,
  listSessions,
  touchSession,
  getSession,
} from "./session.js";

// ─── buildConnectConfig ──────────────────────────────────────────────────────

describe("buildConnectConfig", () => {
  it("returns defaults for empty creds", () => {
    const cfg = buildConnectConfig({});
    expect(cfg.host).toBe("localhost");
    expect(cfg.port).toBe(22);
    expect(cfg.username).toBe("root");
    expect(cfg.readyTimeout).toBe(10000);
    expect(cfg.keepaliveInterval).toBe(15000);
    expect(cfg.keepaliveCountMax).toBe(3);
  });

  it("overrides with provided values", () => {
    const cfg = buildConnectConfig({
      host: "10.0.0.1",
      port: 2222,
      username: "admin",
      timeout: 30000,
    });
    expect(cfg.host).toBe("10.0.0.1");
    expect(cfg.port).toBe(2222);
    expect(cfg.username).toBe("admin");
    expect(cfg.readyTimeout).toBe(30000);
  });

  it("sets password auth when password provided", () => {
    const cfg = buildConnectConfig({ password: "secret" });
    expect(cfg.password).toBe("secret");
    expect((cfg as any).privateKey).toBeUndefined();
  });

  it("sets privateKey auth when privateKey provided", () => {
    const cfg = buildConnectConfig({ privateKey: "key-content" });
    expect(cfg.privateKey).toBe("key-content");
    expect((cfg as any).password).toBeUndefined();
  });

  it("sets passphrase with privateKey", () => {
    const cfg = buildConnectConfig({ privateKey: "key", passphrase: "pass" });
    expect(cfg.passphrase).toBe("pass");
  });
});

// ─── sshConnect ──────────────────────────────────────────────────────────────

describe("sshConnect", () => {
  it("rejects null host", async () => {
    const { sshConnect } = await import("./session.js");
    await expect(sshConnect({ host: "" }, 5000)).rejects.toThrow();
  });
});

// ─── Session lifecycle (in-memory state) ───────────────────────────────────

describe("session lifecycle", () => {
  it("listSessions returns empty array initially", () => {
    expect(listSessions()).toEqual([]);
  });

  it("touchSession returns false for unknown session", () => {
    expect(touchSession("nonexistent")).toBe(false);
  });

  it("getSession returns undefined for unknown session", () => {
    expect(getSession("nonexistent")).toBeUndefined();
  });
});
