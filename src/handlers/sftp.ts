import { Client } from "ssh2";
import { resolveClient } from "../session.js";
import {
  SshFileReadArgs,
  SshFileWriteArgs,
  SshFileListArgs,
  SshFileDeleteArgs,
  SshFileRenameArgs,
  SshFileMkdirArgs,
  SshFileChmodArgs,
  SshFileStatArgs,
} from "../types.js";

function withSftp<T>(client: Client, timeoutMs: number, fn: (sftp: import("ssh2").SFTPWrapper) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SFTP operation timeout after ${timeoutMs}ms`)), timeoutMs);
    client.sftp((err, sftp) => {
      if (err) { clearTimeout(timer); reject(err); return; }
      fn(sftp).finally(() => {
        clearTimeout(timer);
        try { sftp.end(); } catch { /* ignore */ }
      }).then(resolve, reject);
    });
  });
}

// --- Read ---

export async function handleReadFile(args: SshFileReadArgs) {
  const content = await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, (sftp) => {
      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = sftp.createReadStream(args.path);
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        stream.on("error", reject);
      });
    })
  ) as string;

  return { content: [{ type: "text" as const, text: content }] };
}

// --- Write ---

export async function handleWriteFile(args: SshFileWriteArgs) {
  await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, async (sftp) => {
      if (args.mkdir) {
        const dir = args.path.substring(0, args.path.lastIndexOf("/"));
        if (dir) {
          try {
            await sftpMkdir(sftp, dir, true);
          } catch { /* may already exist */ }
        }
      }
      return new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(args.path);
        stream.on("close", () => resolve());
        stream.on("error", reject);
        stream.end(args.content, "utf-8");
      });
    })
  );

  return {
    content: [{
      type: "text" as const,
      text: `Wrote ${args.content.length} bytes to ${args.path}`,
    }],
  };
}

// --- List ---

export async function handleListDir(args: SshFileListArgs) {
  const result = await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, async (sftp) => {
      // 1. readdir to get file list
      const list = await new Promise<any[]>((resolve, reject) => {
        sftp.readdir(args.path, (err, entries) => err ? reject(err) : resolve(entries));
      });

      // 2. For symlinks, call readlink() in parallel to get targets reliably
      const symlinkTargets = new Map<string, string>();
      await Promise.all(list.map(item => {
        if (!item.attrs.isSymbolicLink()) return Promise.resolve();
        const fullPath = args.path.replace(/\/$/, "") + "/" + item.filename;
        return new Promise<void>(resolve => {
          sftp.readlink(fullPath, (err, target) => {
            if (!err && target) symlinkTargets.set(item.filename, target);
            resolve();
          });
        });
      }));

      // 3. Build text lines
      const lines = list.map(item => {
        const type = item.attrs.isDirectory() ? "d" : item.attrs.isSymbolicLink() ? "l" : "-";
        const perms = modeToString(item.attrs.mode);
        const size = item.attrs.size.toString().padStart(10);
        const mtime = new Date(item.attrs.mtime * 1000).toISOString().replace("T", " ").substring(0, 19);
        const link = item.attrs.isSymbolicLink()
          ? ` -> ${symlinkTargets.get(item.filename) ?? ""}`
          : "";
        return `${type}${perms} ${size} ${mtime} ${item.filename}${link}`;
      });
      return lines.join("\n");
    })
  ) as string;

  return { content: [{ type: "text" as const, text: result }] };
}

// --- Delete ---

export async function handleDelete(args: SshFileDeleteArgs) {
  await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, (sftp) => {
      if (args.recursive) {
        return sftpDeleteRecursive(sftp, args.path);
      }
      return new Promise<void>((resolve, reject) => {
        sftp.unlink(args.path, (err) => err ? reject(err) : resolve());
      });
    })
  );

  return { content: [{ type: "text" as const, text: `Deleted: ${args.path}` }] };
}

function sftpDeleteRecursive(sftp: import("ssh2").SFTPWrapper, targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.stat(targetPath, (statErr, stat) => {
      if (statErr) {
        reject(statErr);
        return;
      }
      if (!stat.isDirectory()) {
        sftp.unlink(targetPath, (unlinkErr) => unlinkErr ? reject(unlinkErr) : resolve());
        return;
      }
      sftp.readdir(targetPath, async (readErr, list) => {
        if (readErr) {
          reject(readErr);
          return;
        }
        try {
          for (const item of list) {
            await sftpDeleteRecursive(sftp, `${targetPath}/${item.filename}`);
          }
          sftp.rmdir(targetPath, (rmErr) => rmErr ? reject(rmErr) : resolve());
        } catch (err) {
          reject(err as Error);
        }
      });
    });
  });
}

// --- Rename ---

export async function handleRename(args: SshFileRenameArgs) {
  await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, (sftp) => {
      return new Promise<void>((resolve, reject) => {
        sftp.rename(args.source, args.dest, (err) => err ? reject(err) : resolve());
      });
    })
  );

  return {
    content: [{ type: "text" as const, text: `Renamed: ${args.source} -> ${args.dest}` }],
  };
}

// --- Mkdir ---

function sftpMkdir(sftp: import("ssh2").SFTPWrapper, path: string, parents: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    if (parents) {
      const parts = path.replace(/\/$/, "").split("/").filter(Boolean);
      let acc = parts[0]?.startsWith("/") ? "" : "";
      const chain = parts.map((p, i) => {
        acc += (i === 0 && parts[0].startsWith("/")) ? p : `/${p}`;
        return acc;
      });
      let idx = 0;
      const next = () => {
        if (idx >= chain.length) { resolve(); return; }
        sftp.mkdir(chain[idx++], (err) => {
          if (err && (err as unknown as { code?: string }).code !== "EEXIST") {
            reject(err);
          } else {
            next();
          }
        });
      };
      next();
    } else {
      sftp.mkdir(path, (err) => err ? reject(err) : resolve());
    }
  });
}

export async function handleMkdir(args: SshFileMkdirArgs) {
  await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, (sftp) =>
      sftpMkdir(sftp, args.path, args.parents ?? false)
    )
  );

  return { content: [{ type: "text" as const, text: `Directory created: ${args.path}` }] };
}

// --- Chmod ---

export async function handleChmod(args: SshFileChmodArgs) {
  const mode = parseInt(args.mode, 8);
  if (isNaN(mode)) {
    return {
      content: [{ type: "text" as const, text: `Error: Invalid mode '${args.mode}'. Use octal like "755" or "644".` }],
      isError: true,
    };
  }

  await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, (sftp) => {
      return new Promise<void>((resolve, reject) => {
        if (args.recursive) {
          chmodRecursive(sftp, args.path, mode, resolve, reject);
        } else {
          sftp.chmod(args.path, mode, (err) => err ? reject(err) : resolve());
        }
      });
    })
  );

  return { content: [{ type: "text" as const, text: `Mode changed: ${args.path} -> ${args.mode}` }] };
}

function chmodRecursive(
  sftp: import("ssh2").SFTPWrapper,
  path: string,
  mode: number,
  resolve: () => void,
  reject: (err: Error) => void
) {
  sftp.chmod(path, mode, (err) => {
    if (err) { reject(err); return; }
    sftp.stat(path, (statErr, stat) => {
      if (statErr || !stat.isDirectory()) { resolve(); return; }
      sftp.readdir(path, (readErr, list) => {
        if (readErr) { resolve(); return; }
        let pending = list.length;
        if (pending === 0) { resolve(); return; }
        for (const item of list) {
          chmodRecursive(sftp, `${path}/${item.filename}`, mode, () => {
            pending--;
            if (pending <= 0) resolve();
          }, reject);
        }
      });
    });
  });
}

// --- Stat ---

export async function handleStat(args: SshFileStatArgs) {
  const result = await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, (sftp) => {
      return new Promise<string>((resolve, reject) => {
        sftp.stat(args.path, (err, stat) => {
          if (err) { reject(err); return; }
          const type = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file";
          const perms = modeToString(stat.mode);
          const mtime = new Date(stat.mtime * 1000).toISOString();
          const atime = new Date(stat.atime * 1000).toISOString();
          resolve([
            `  Path: ${args.path}`,
            `  Type: ${type}`,
            `  Size: ${stat.size} bytes`,
            `  Mode: ${perms} (${stat.mode.toString(8)})`,
            `  UID:  ${stat.uid}`,
            `  GID:  ${stat.gid}`,
            `  Modified: ${mtime}`,
            `  Accessed: ${atime}`,
          ].join("\n"));
        });
      });
    })
  ) as string;

  return { content: [{ type: "text" as const, text: result }] };
}

// --- Helpers ---

const MODE_R = 4, MODE_W = 2, MODE_X = 1;
const PERM_TRIPLETS = [
  [0o400, 0o200, 0o100], // owner
  [0o040, 0o020, 0o010], // group
  [0o004, 0o002, 0o001], // other
];

function modeToString(mode: number): string {
  const special = mode & 0o7000;
  return PERM_TRIPLETS.map(([r, w, x], i) => {
    const chars = [
      mode & r ? "r" : "-",
      mode & w ? "w" : "-",
      mode & x ? (special & (0o400 >> (i * 3)) ? "s" : "x") : (special & (0o400 >> (i * 3)) ? "S" : "-"),
    ];
    return chars.join("");
  }).join("");
}
