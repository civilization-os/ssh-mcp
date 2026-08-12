import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("../session.js", () => ({
  getSession: getSessionMock,
}));

describe("handleShellCreate", () => {
  beforeEach(() => {
    vi.resetModules();
    getSessionMock.mockReset();
  });

  it("returns error for unknown session", async () => {
    getSessionMock.mockReturnValue(undefined);

    const { handleShellCreate } = await import("./shell.js");
    const result = await handleShellCreate({ sessionId: "bad_session" }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error for k8s-type session", async () => {
    getSessionMock.mockReturnValue({
      id: "k8s_1",
      type: "k8s",
      client: undefined,
    });

    const { handleShellCreate } = await import("./shell.js");
    const result = await handleShellCreate({ sessionId: "k8s_1" }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not an SSH session");
  });
});

describe("handleShellList", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns empty list when no shells", async () => {
    const { handleShellList } = await import("./shell.js");
    const result = await handleShellList() as any;
    expect(result.content[0].text).toContain("No active interactive shells");
  });
});

describe("handleShellWrite", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error for unknown shellId", async () => {
    const { handleShellWrite } = await import("./shell.js");
    const result = await handleShellWrite({ shellId: "bad_shell", input: "ls" }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });
});

describe("handleShellRead", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error for unknown shellId", async () => {
    const { handleShellRead } = await import("./shell.js");
    const result = await handleShellRead({ shellId: "bad_shell" }) as any;
    expect(result.isError).toBe(true);
  });

  it("returns terminal-rendered output while preserving raw output for the App", async () => {
    const channel = new EventEmitter() as any;
    channel.stderr = new EventEmitter();
    channel.stdin = { write: vi.fn((_input: string, _encoding: string, callback: (error?: Error) => void) => callback()) };
    channel.setWindow = vi.fn();
    channel.close = vi.fn();
    const client = {
      shell: vi.fn((_options: unknown, callback: (error: undefined, channel: any) => void) => callback(undefined, channel)),
    };
    getSessionMock.mockReturnValue({ id: "sess_1", type: "ssh", client });

    const shellModule = await import("./shell.js");
    const created = await shellModule.handleShellCreate({ sessionId: "sess_1", cols: 40, rows: 6 }) as any;
    const shellId = created.content[0].text.match(/Interactive shell created: (\S+)/)?.[1];
    expect(shellId).toBeTruthy();

    const appMessages: string[] = [];
    const ws = { send: (data: string) => appMessages.push(data), readyState: 1 };
    expect(shellModule.attachWsToShell(shellId, ws)).toBe(true);
    await shellModule.handleShellWrite({ shellId, input: "deploy" });
    channel.emit("data", Buffer.from("Pulling 10%\r\x1b[2KPulling 90%\r\x1b[2KStarted\r\nroot@test:~# "));

    const read = await shellModule.handleShellRead({ shellId }) as any;
    const payload = JSON.parse(read.content[0].text);
    expect(payload.content).toContain("Started");
    expect(payload.content).not.toMatch(/[\r\x1b]/);
    expect(payload.screen).toContain("root@test:~#");
    expect(payload.cursor).toEqual({ row: 1, column: 13 });
    expect(appMessages.join("" )).toContain("\x1b[2K");

    expect(shellModule.resizeShell(shellId, 80, 24)).toBe(true);
    const resized = await shellModule.handleShellRead({ shellId, peek: true }) as any;
    expect(JSON.parse(resized.content[0].text).dimensions).toEqual({ cols: 80, rows: 24 });
    expect(channel.setWindow).toHaveBeenCalledWith(24, 80, 0, 0);

    await shellModule.handleShellClose({ shellId });
  });

  it("does not satisfy expect from the echoed command itself", async () => {
    const channel = new EventEmitter() as any;
    channel.stderr = new EventEmitter();
    channel.stdin = { write: vi.fn((_input: string, _encoding: string, callback: (error?: Error) => void) => callback()) };
    channel.setWindow = vi.fn();
    channel.close = vi.fn();
    const client = {
      shell: vi.fn((_options: unknown, callback: (error: undefined, channel: any) => void) => {
        callback(undefined, channel);
        setTimeout(() => channel.emit("data", Buffer.from("root@host:~# ")), 10);
      }),
    };
    getSessionMock.mockReturnValue({ id: "sess_echo", type: "ssh", client });

    const shellModule = await import("./shell.js");
    const created = await shellModule.handleShellCreate({ sessionId: "sess_echo", cols: 80, rows: 8 }) as any;
    const shellId = created.content[0].text.match(/Interactive shell created: (\S+)/)?.[1];
    expect(shellId).toBeTruthy();

    const command = "echo __MCP_DONE__";
    await shellModule.handleShellWrite({ shellId, input: command });
    const readPromise = shellModule.handleShellRead({
      shellId,
      expect: "__MCP_DONE__",
      maxWaitMs: 500,
    }) as Promise<any>;

    channel.emit("data", Buffer.from(`${command}\r\n`));
    let resolved = false;
    void readPromise.then(() => { resolved = true; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(resolved).toBe(false);

    channel.emit("data", Buffer.from("__MCP_DONE__\r\nroot@host:~# "));
    const read = await readPromise;
    const payload = JSON.parse(read.content[0].text);
    expect(payload.inputEcho).toEqual([command]);
    expect(payload.content).toContain(command);
    expect(payload.programOutput).not.toContain(command);
    expect(payload.programOutput).toContain("__MCP_DONE__");

    await shellModule.handleShellClose({ shellId });
  });
});

describe("handleShellResize", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error for unknown shellId", async () => {
    const { handleShellResize } = await import("./shell.js");
    const result = await handleShellResize({ shellId: "bad_shell" }) as any;
    expect(result.isError).toBe(true);
  });
});

describe("handleShellClose", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error for unknown shellId", async () => {
    const { handleShellClose } = await import("./shell.js");
    const result = await handleShellClose({ shellId: "bad_shell" }) as any;
    expect(result.isError).toBe(true);
  });
});

describe("cleanShellsBySession", () => {
  beforeEach(() => { vi.resetModules(); });

  it("handles missing session gracefully", async () => {
    const { cleanShellsBySession } = await import("./shell.js");
    cleanShellsBySession("nonexistent");
    expect(true).toBe(true);
  });
});

describe("listActiveShells / hasActiveShells", () => {
  beforeEach(() => { vi.resetModules(); });

  it("listActiveShells returns empty when no shells", async () => {
    const { listActiveShells } = await import("./shell.js");
    expect(listActiveShells()).toEqual([]);
  });

  it("hasActiveShells returns false for unknown session", async () => {
    const { hasActiveShells } = await import("./shell.js");
    expect(hasActiveShells("bad")).toBe(false);
  });
});

describe("WebSocket helpers", () => {
  beforeEach(() => { vi.resetModules(); });

  it("attachWsToShell returns false for unknown shell", async () => {
    const { attachWsToShell } = await import("./shell.js");
    expect(attachWsToShell("bad", {})).toBe(false);
  });

  it("detachWsFromShell does not throw for unknown shell", async () => {
    const { detachWsFromShell } = await import("./shell.js");
    detachWsFromShell("bad", {});
    expect(true).toBe(true);
  });

  it("writeInputToShell returns false for unknown shell", async () => {
    const { writeInputToShell } = await import("./shell.js");
    expect(writeInputToShell("bad", "data")).toBe(false);
  });
});
