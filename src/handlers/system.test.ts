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
