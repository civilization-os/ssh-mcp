import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

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

  it("supports base64 encoding and range reading", async () => {
    const raw = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const createReadStream = vi.fn((_path: string, options?: any) => {
      expect(options).toEqual({ start: 1, end: 2 });
      return Readable.from([raw.subarray(1, 3)]);
    });

    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(null, makeSftp({ createReadStream }))),
      })),
    }));

    const { handleReadFile } = await import("./sftp.js");
    const result = await handleReadFile({
      path: "/data/bin",
      encoding: "base64",
      offset: 1,
      length: 2,
    });
    expect(result.content[0].text).toBe(raw.subarray(1, 3).toString("base64"));
  });

  it("rejects when target path is a directory", async () => {
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(null, makeSftp({
          stat: (_p: string, cb2: Function) => cb2(null, { isDirectory: () => true, isFile: () => false }),
        }))),
      })),
    }));
    const { handleReadFile } = await import("./sftp.js");
    await expect(handleReadFile({ path: "/etc" })).rejects.toThrow("is a directory");
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

  it("supports base64 encoding and append mode", async () => {
    const written: Buffer[] = [];
    let writeOptions: any;
    const createWriteStream = vi.fn((_path: string, options?: any) => {
      writeOptions = options;
      return new Writable({
        write(chunk, _enc, cb) {
          written.push(Buffer.from(chunk));
          cb();
        },
      });
    });

    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(null, makeSftp({ createWriteStream }))),
      })),
    }));

    const { handleWriteFile } = await import("./sftp.js");
    const b64 = Buffer.from("appended content").toString("base64");
    const result = await handleWriteFile({
      path: "/var/log/app.log",
      content: b64,
      encoding: "base64",
      append: true,
    });

    expect(writeOptions).toEqual({ flags: "a" });
    expect(Buffer.concat(written).toString("utf-8")).toBe("appended content");
    expect(result.content[0].text).toContain("appended");
  });
});

describe("handleUploadFile", () => {
  beforeEach(() => { vi.resetModules(); });

  it("streams an exact binary file to a temporary remote path before renaming", async () => {
    const localDirectory = await mkdtemp(path.join(tmpdir(), "ssh-mcp-upload-"));
    const localPath = path.join(localDirectory, "fixture.bin");
    const expected = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0d, 0x0a, 0x20]);
    await writeFile(localPath, expected);

    const received: Buffer[] = [];
    const createWriteStream = vi.fn(() => new Writable({
      write(chunk, _encoding, callback) {
        received.push(Buffer.from(chunk));
        callback();
      },
    }));
    const rename = vi.fn((_source: string, _destination: string, callback: Function) => callback(null));
    const unlink = vi.fn((_target: string, callback: Function) => callback(null));

    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: unknown, fn: (client: any) => Promise<unknown>) => fn({
        sftp: vi.fn((callback: Function) => callback(null, makeSftp({ createWriteStream, rename, unlink }))),
      })),
    }));

    try {
      const { handleUploadFile } = await import("./sftp.js");
      const result = await handleUploadFile({ localPath, path: "/opt/app/fixture.bin" }) as any;

      expect(Buffer.concat(received)).toEqual(expected);
      expect(createWriteStream.mock.calls[0][0]).toMatch(/^\/opt\/app\/fixture\.bin\.ssh-mcp-upload-[a-f0-9]+\.tmp$/);
      expect(rename).toHaveBeenCalledWith(
        createWriteStream.mock.calls[0][0],
        "/opt/app/fixture.bin",
        expect.any(Function),
      );
      expect(result.content[0].text).toContain(`Uploaded ${expected.length} bytes`);
    } finally {
      await rm(localDirectory, { recursive: true, force: true });
    }
  });

  it("rejects when destination already exists and overwrite is false", async () => {
    const localDirectory = await mkdtemp(path.join(tmpdir(), "ssh-mcp-upload-exist-"));
    const localPath = path.join(localDirectory, "fixture.bin");
    await writeFile(localPath, "data");

    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: unknown, fn: (client: any) => Promise<unknown>) => fn({
        sftp: vi.fn((callback: Function) => callback(null, makeSftp({
          stat: (targetPath: string, cb: Function) => {
            if (targetPath === "/opt/app") {
              cb(null, { isDirectory: () => true, isFile: () => false });
            } else {
              cb(null, { isDirectory: () => false, isFile: () => true });
            }
          },
        }))),
      })),
    }));

    try {
      const { handleUploadFile } = await import("./sftp.js");
      await expect(handleUploadFile({
        localPath,
        path: "/opt/app/fixture.bin",
        overwrite: false,
      })).rejects.toThrow("overwrite=true");
    } finally {
      await rm(localDirectory, { recursive: true, force: true });
    }
  });

  it("unlinks existing file and overwrites when overwrite=true", async () => {
    const localDirectory = await mkdtemp(path.join(tmpdir(), "ssh-mcp-upload-ow-"));
    const localPath = path.join(localDirectory, "fixture.bin");
    await writeFile(localPath, "new content");

    const unlink = vi.fn((_target: string, cb: Function) => cb(null));
    const rename = vi.fn((_src: string, _dst: string, cb: Function) => cb(null));
    const createWriteStream = vi.fn(() => new Writable({
      write(_c, _e, cb) { cb(); },
    }));

    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: unknown, fn: (client: any) => Promise<unknown>) => fn({
        sftp: vi.fn((callback: Function) => callback(null, makeSftp({
          stat: (targetPath: string, cb: Function) => {
            if (targetPath === "/opt/app") {
              cb(null, { isDirectory: () => true, isFile: () => false });
            } else {
              cb(null, { isDirectory: () => false, isFile: () => true });
            }
          },
          unlink,
          rename,
          createWriteStream,
        }))),
      })),
    }));

    try {
      const { handleUploadFile } = await import("./sftp.js");
      const result = await handleUploadFile({
        localPath,
        path: "/opt/app/fixture.bin",
        overwrite: true,
      }) as any;

      expect(unlink).toHaveBeenCalledWith("/opt/app/fixture.bin", expect.any(Function));
      expect(result.content[0].text).toContain("Uploaded");
    } finally {
      await rm(localDirectory, { recursive: true, force: true });
    }
  });

  it("creates parent directory when mkdir=true skipping existing segments", async () => {
    const localDirectory = await mkdtemp(path.join(tmpdir(), "ssh-mcp-upload-mkdir-"));
    const localPath = path.join(localDirectory, "fixture.bin");
    await writeFile(localPath, "data");

    const createdDirs: string[] = [];
    const mkdir = vi.fn((p: string, cb: Function) => {
      createdDirs.push(p);
      cb(null);
    });
    const rename = vi.fn((_src: string, _dst: string, cb: Function) => cb(null));
    const createWriteStream = vi.fn(() => new Writable({
      write(_c, _e, cb) { cb(); },
    }));

    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: unknown, fn: (client: any) => Promise<unknown>) => fn({
        sftp: vi.fn((callback: Function) => callback(null, makeSftp({
          stat: (targetPath: string, cb: Function) => {
            // Simulate /root exists as directory, but /root/newdir does not exist
            if (targetPath === "/root") {
              cb(null, { isDirectory: () => true, isFile: () => false });
            } else {
              cb(new Error("No such file"));
            }
          },
          mkdir,
          rename,
          createWriteStream,
        }))),
      })),
    }));

    try {
      const { handleUploadFile } = await import("./sftp.js");
      await handleUploadFile({
        localPath,
        path: "/root/newdir/fixture.bin",
        mkdir: true,
      });

      // /root was skipped, only /root/newdir was created!
      expect(createdDirs).toEqual(["/root/newdir"]);
    } finally {
      await rm(localDirectory, { recursive: true, force: true });
    }
  });
});

describe("handleDownloadFile", () => {
  beforeEach(() => { vi.resetModules(); });

  it("streams exact binary bytes to a temporary local file before installing it", async () => {
    const localDirectory = await mkdtemp(path.join(tmpdir(), "ssh-mcp-download-"));
    const localPath = path.join(localDirectory, "nested", "fixture.bin");
    const expected = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0d, 0x0a, 0x20]);
    const createReadStream = vi.fn(() => Readable.from([
      expected.subarray(0, 3),
      expected.subarray(3),
    ]));

    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_args: unknown, fn: (client: any) => Promise<unknown>) => fn({
        sftp: vi.fn((callback: Function) => callback(null, makeSftp({
          createReadStream,
          stat: (_target: string, callback: Function) => callback(null, {
            size: expected.length,
            isFile: () => true,
          }),
        }))),
      })),
    }));

    try {
      const { handleDownloadFile } = await import("./sftp.js");
      const result = await handleDownloadFile({
        path: "/var/backups/fixture.bin",
        localPath,
        mkdir: true,
      }) as any;

      expect(await readFile(localPath)).toEqual(expected);
      expect(createReadStream).toHaveBeenCalledWith("/var/backups/fixture.bin");
      expect(await readdir(path.dirname(localPath))).toEqual(["fixture.bin"]);
      expect(result.content[0].text).toContain(`Downloaded ${expected.length} bytes`);
    } finally {
      await rm(localDirectory, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing local file by default", async () => {
    const localDirectory = await mkdtemp(path.join(tmpdir(), "ssh-mcp-download-existing-"));
    const localPath = path.join(localDirectory, "fixture.bin");
    await writeFile(localPath, "keep me");
    const resolveClient = vi.fn();
    vi.doMock("../session.js", () => ({ resolveClient }));

    try {
      const { handleDownloadFile } = await import("./sftp.js");
      await expect(handleDownloadFile({
        path: "/var/backups/fixture.bin",
        localPath,
      })).rejects.toThrow("overwrite=true");
      expect(await readFile(localPath, "utf8")).toBe("keep me");
      expect(resolveClient).not.toHaveBeenCalled();
    } finally {
      await rm(localDirectory, { recursive: true, force: true });
    }
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

  it("deletes directory using rmdir when target is directory", async () => {
    const rmdir = vi.fn((_p: string, cb: Function) => cb(null));
    vi.doMock("../session.js", () => ({
      resolveClient: vi.fn((_a: any, fn: (c: any) => Promise<any>) => fn({
        sftp: vi.fn((cb: Function) => cb(null, makeSftp({
          stat: (_p: string, cb2: Function) => cb2(null, { isDirectory: () => true }),
          rmdir,
        }))),
      })),
      touchSession: vi.fn(),
    }));
    const { handleDelete } = await import("./sftp.js");
    const result = await handleDelete({ path: "/tmp/empty_dir" }) as any;
    expect(rmdir).toHaveBeenCalledWith("/tmp/empty_dir", expect.any(Function));
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
