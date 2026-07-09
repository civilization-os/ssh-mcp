import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.doMock (non-hoisted) so each describe block gets its own mock scope.

describe("handleReadFile", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error when SFTP fails", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(new Error("sftp failed"))),
      })),
      touchSession: vi.fn(),
    }));
    const { handleReadFile } = await import("./sftp.js");
    await expect(handleReadFile({ path: "/etc/hosts" })).rejects.toThrow("sftp failed");
  });
});

describe("handleWriteFile", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error when SFTP fails", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(new Error("sftp write failed"))),
      })),
      touchSession: vi.fn(),
    }));
    const { handleWriteFile } = await import("./sftp.js");
    await expect(handleWriteFile({ path: "/tmp/test", content: "hello" })).rejects.toThrow("sftp write failed");
  });
});

describe("handleListDir", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error when SFTP fails", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(new Error("sftp list failed"))),
      })),
      touchSession: vi.fn(),
    }));
    const { handleListDir } = await import("./sftp.js");
    await expect(handleListDir({ path: "/tmp" })).rejects.toThrow("sftp list failed");
  });
});

describe("handleDelete", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns success on file delete", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(null, makeSftp({ unlink: (_p: string, cb2: Function) => cb2(null) }))),
      })),
      touchSession: vi.fn(),
    }));
    const { handleDelete } = await import("./sftp.js");
    const result = await handleDelete({ path: "/tmp/test.txt" }) as any;
    expect(result.content[0].text).toContain("Deleted");
  });
});

describe("handleRename", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns success on rename", async () => {
    const renameFn = vi.fn((_s: string, _d: string, cb: Function) => cb(null));
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(null, makeSftp({ rename: renameFn }))),
      })),
    }));
    const { handleRename } = await import("./sftp.js");
    const result = await handleRename({ source: "/a", dest: "/b" }) as any;
    expect(result.content[0].text).toContain("Renamed");
    expect(renameFn).toHaveBeenCalledWith("/a", "/b", expect.any(Function));
  });
});

describe("handleMkdir", () => {
  beforeEach(() => { vi.resetModules(); });

  it("creates a directory", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(null, makeSftp({ mkdir: (_p: string, cb2: Function) => cb2(null) }))),
      })),
    }));
    const { handleMkdir } = await import("./sftp.js");
    const result = await handleMkdir({ path: "/new/dir" }) as any;
    expect(result.content[0].text).toContain("Directory created");
  });
});

describe("handleChmod", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error for invalid mode", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn(),
    }));
    const { handleChmod } = await import("./sftp.js");
    const result = await handleChmod({ path: "/f", mode: "invalid" }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid mode");
  });

  it("changes mode on file", async () => {
    const chmodFn = vi.fn((_p: string, _m: number, cb: Function) => cb(null));
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(null, makeSftp({
          chmod: chmodFn,
          stat: (_p: string, cb2: Function) => cb2(null, { isDirectory: () => false }),
          readdir: vi.fn(),
        }))),
      })),
    }));
    const { handleChmod } = await import("./sftp.js");
    const result = await handleChmod({ path: "/f", mode: "644" }) as any;
    expect(result.content[0].text).toContain("Mode changed");
    expect(chmodFn).toHaveBeenCalledWith("/f", 0o644, expect.any(Function));
  });
});

describe("handleStat", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns file stats", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(null, makeSftp({
          stat: (_p: string, cb2: Function) => cb2(null, {
            size: 1024,
            mode: 0o100644,
            uid: 1000,
            gid: 1000,
            mtime: 1700000000,
            atime: 1700000000,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          }),
        }))),
      })),
    }));
    const { handleStat } = await import("./sftp.js");
    const result = await handleStat({ path: "/f" }) as any;
    expect(result.content[0].text).toContain("/f");
    expect(result.content[0].text).toContain("1024");
    expect(result.content[0].text).toContain("file");
  });
});

// Helper to build a mock SFTP wrapper
function makeSftp(methods: Record<string, any>) {
  return { ...methods, end: vi.fn(() => {}) };
}
