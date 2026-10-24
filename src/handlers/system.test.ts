import { describe, it, expect, vi, beforeEach } from "vitest";

describe("handleSysinfo", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns parsed system info", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: any, fn: (client: any) => Promise<any>) => fn({
        exec: vi.fn((_cmd: string, cb: Function) => {
          const channel: any = { on: vi.fn((evt: string, h: Function) => { if (evt === "close") h(); }), stderr: { on: vi.fn() } };
          cb(null, channel);
        }),
      })),
      touchSession: vi.fn(),
    }));

    const { handleSysinfo } = await import("./system.js");
    const result = await handleSysinfo({}) as any;
    expect(result.content[0].text).toContain("OS:");
  });
});

describe("handleProcesses", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns process list", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: any, fn: (client: any) => Promise<any>) => fn({
        exec: vi.fn((_cmd: string, cb: Function) => {
          const channel: any = { on: vi.fn((evt: string, h: Function) => { if (evt === "close") h(); }), stderr: { on: vi.fn() } };
          cb(null, channel);
        }),
      })),
    }));

    const { handleProcesses } = await import("./system.js");
    const result = await handleProcesses({}) as any;
    expect(result.isError).toBeFalsy();
  });

  it("accepts sort and limit parameters", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: any, fn: (client: any) => Promise<any>) => fn({
        exec: vi.fn((_cmd: string, cb: Function) => {
          const channel: any = { on: vi.fn((evt: string, h: Function) => { if (evt === "close") h(); }), stderr: { on: vi.fn() } };
          cb(null, channel);
        }),
      })),
    }));

    const { handleProcesses } = await import("./system.js");
    const result = await handleProcesses({ sort: "memory", limit: 10 }) as any;
    expect(result.isError).toBeFalsy();
  });
});

describe("handleDiskUsage", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns disk usage info", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: any, fn: (client: any) => Promise<any>) => fn({
        exec: vi.fn((_cmd: string, cb: Function) => {
          const channel: any = { on: vi.fn((evt: string, h: Function) => { if (evt === "close") h(); }), stderr: { on: vi.fn() } };
          cb(null, channel);
        }),
      })),
    }));

    const { handleDiskUsage } = await import("./system.js");
    const result = await handleDiskUsage({}) as any;
    expect(result.isError).toBeFalsy();
  });

  it("accepts custom path", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: any, fn: (client: any) => Promise<any>) => fn({
        exec: vi.fn((_cmd: string, cb: Function) => {
          const channel: any = { on: vi.fn((evt: string, h: Function) => { if (evt === "close") h(); }), stderr: { on: vi.fn() } };
          cb(null, channel);
        }),
      })),
    }));

    const { handleDiskUsage } = await import("./system.js");
    const result = await handleDiskUsage({ path: "/var" }) as any;
    expect(result.isError).toBeFalsy();
  });
});

describe("handleProcInfo", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error for invalid pid", async () => {
    const { handleProcInfo } = await import("./system.js");
    const result = await handleProcInfo({ pid: "invalid" as any }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid PID");
  });

  it("parses linux proc info and detects systemd service", async () => {
    const mockOutput = `===EXISTS===
CMDLINE=node /opt/dsh/server.js --port 3000 
EXE=/usr/bin/node
CWD=/opt/dsh
===CGROUP===
0::/system.slice/dsh-web.service
===STATUS===
Name: node
State: S (sleeping)
PPid: 1
Threads: 11
VmRSS: 125340 kB
VmSize: 1048576 kB
`;

    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: any, fn: (client: any) => Promise<any>) => fn({
        exec: vi.fn((_cmd: string, cb: Function) => {
          const channel: any = {
            on: vi.fn((evt: string, h: Function) => {
              if (evt === "data") h(Buffer.from(mockOutput));
              if (evt === "close") h();
            }),
            stderr: { on: vi.fn() },
          };
          cb(null, channel);
        }),
      })),
    }));

    const { handleProcInfo } = await import("./system.js");
    const result = await handleProcInfo({ pid: 155361 }) as any;
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("PID:          155361");
    expect(text).toContain("Systemd Unit: dsh-web.service");
    expect(text).toContain("CommandLine:  node /opt/dsh/server.js --port 3000");
    expect(text).toContain("WARNING: This process belongs to systemd service 'dsh-web.service'");
  });
});
