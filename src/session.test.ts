import { describe, it, expect, vi } from "vitest";
import {
  buildConnectConfig,
  listSessions,
  touchSession,
  getSession,
  disconnectSession,
  deleteSession,
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

  it("rejects when proxy is enabled but no proxy URL is available", async () => {
    const { sshConnect } = await import("./session.js");
    await expect(sshConnect({ host: "1.2.3.4", proxyEnabled: true }, 5000)).rejects.toThrow("Proxy is enabled for this session, but no proxy URL is configured");
  });
});

// ─── Proxy Socket (HTTP CONNECT & SOCKS5) ───────────────────────────────────

describe("createProxySocket", () => {
  it("rejects unsupported protocols", async () => {
    const { createProxySocket } = await import("./session.js");
    await expect(createProxySocket("ftp://127.0.0.1:21", "example.com", 22)).rejects.toThrow("Unsupported proxy protocol");
  });

  it("establishes HTTP CONNECT tunnel with basic auth support", async () => {
    const net = await import("net");
    const { createProxySocket } = await import("./session.js");
    let receivedConnect = "";
    const server = net.createServer((c) => {
      c.on("data", (data) => {
        receivedConnect += data.toString();
        c.write("HTTP/1.1 200 Connection established\r\n\r\n");
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as any;
    const proxyUrl = `http://testuser:testpass@127.0.0.1:${address.port}`;

    const socket = await createProxySocket(proxyUrl, "remote.host.internal", 22, 2000);
    expect(socket).toBeTruthy();
    expect(receivedConnect).toContain("CONNECT remote.host.internal:22 HTTP/1.1");
    expect(receivedConnect).toContain("Proxy-Authorization: Basic ");

    socket.destroy();
    server.close();
  });

  it("establishes SOCKS5 tunnel without auth", async () => {
    const net = await import("net");
    const { createProxySocket } = await import("./session.js");
    const server = net.createServer((c) => {
      let state = 0;
      c.on("data", (_data) => {
        if (state === 0) {
          // Greeting response: VER 5, METHOD 0 (NO_AUTH)
          c.write(Buffer.from([0x05, 0x00]));
          state = 1;
        } else if (state === 1) {
          // Connect response: VER 5, REP 0 (SUCCESS), RSV 0, ATYP 1 (IPv4), BND.ADDR 0.0.0.0, BND.PORT 0
          c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 22]));
          state = 2;
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as any;
    const proxyUrl = `socks5://127.0.0.1:${address.port}`;

    const socket = await createProxySocket(proxyUrl, "192.168.1.50", 22, 2000);
    expect(socket).toBeTruthy();

    socket.destroy();
    server.close();
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

  it("disconnectSession returns false for unknown session", () => {
    expect(disconnectSession("nonexistent")).toBe(false);
  });

  it("deleteSession returns false for unknown session", async () => {
    const result = await deleteSession("nonexistent");
    expect(result).toBe(false);
  });
});
