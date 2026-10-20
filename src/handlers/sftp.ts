import { Client } from "ssh2";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, link, mkdir, rename, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { resolveClient } from "../session.js";
import {
  SshFileReadArgs,
  SshFileWriteArgs,
  SshFileUploadArgs,
  SshFileDownloadArgs,
  SshFileListArgs,
  SshFileDeleteArgs,
  SshFileRenameArgs,
  SshFileMkdirArgs,
  SshFileChmodArgs,
  SshFileStatArgs,
} from "../types.js";
import { globalEvents } from "../eventBus.js";

function withSftp<T>(client: Client, timeoutMs: number, fn: (sftp: import("ssh2").SFTPWrapper) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SFTP operation timeout after ${timeoutMs}ms`)), timeoutMs);

    const cachedSftp = (client as any)._sftp;
    if (cachedSftp) {
      fn(cachedSftp).finally(() => {
        clearTimeout(timer);
      }).then(resolve, reject);
      return;
    }

    client.sftp((err, sftp) => {
      if (err) { clearTimeout(timer); reject(err); return; }
      
      // Cache it to avoid ~1s channel creation overhead per request
      (client as any)._sftp = sftp;
      if (typeof (sftp as any).on === "function") {
        sftp.on("end", () => { (client as any)._sftp = undefined; });
        sftp.on("error", () => { (client as any)._sftp = undefined; });
        sftp.on("close", () => { (client as any)._sftp = undefined; });
      }

      fn(sftp).finally(() => {
        clearTimeout(timer);
      }).then(resolve, reject);
    });
  });
}

// --- Read ---

export async function handleReadFile(args: SshFileReadArgs) {
  const content = await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, async (sftp) => {
      let start: number | undefined = args.offset;
      let end: number | undefined = args.length !== undefined && start !== undefined
        ? start + args.length - 1
        : undefined;

      if (typeof sftp.stat === "function") {
        const fileStat = await new Promise<import("ssh2").Stats | null>((resolve) => {
          sftp.stat(args.path, (err, st) => resolve(err ? null : st));
        });
        if (fileStat) {
          if (typeof fileStat.isDirectory === "function" && fileStat.isDirectory()) {
            throw new Error(`Remote path is a directory, not a file: '${args.path}'`);
          }
          if (args.tail !== undefined && args.tail > 0 && fileStat.size > args.tail) {
            start = fileStat.size - args.tail;
            end = undefined;
          }
        }
      }

      const streamOptions: { start?: number; end?: number } = {};
      if (start !== undefined) streamOptions.start = start;
      if (end !== undefined) streamOptions.end = end;

      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = sftp.createReadStream(args.path, streamOptions);
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve(args.encoding === "base64" ? buf.toString("base64") : buf.toString("utf-8"));
        });
        stream.on("error", (err: any) => {
          reject(new Error(`Failed to read '${args.path}': ${err.message}`));
        });
      });
    })
  ) as string;

  return { content: [{ type: "text" as const, text: content }] };
}

// --- Write ---

export async function handleWriteFile(args: SshFileWriteArgs) {
  const buf = args.encoding === "base64"
    ? Buffer.from(args.content, "base64")
    : Buffer.from(args.content, "utf-8");

  await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, async (sftp) => {
      if (typeof sftp.stat === "function") {
        const targetStat = await new Promise<import("ssh2").Stats | null>((res) => {
          sftp.stat(args.path, (err, st) => res(err ? null : st));
        });
        if (targetStat && typeof targetStat.isDirectory === "function" && targetStat.isDirectory()) {
          throw new Error(`Remote destination is a directory, not a file: '${args.path}'`);
        }
      }

      const dir = args.path.substring(0, args.path.lastIndexOf("/"));
      if (dir) {
        if (args.mkdir) {
          await sftpMkdir(sftp, dir, true);
        } else if (typeof sftp.stat === "function") {
          const parentStat = await new Promise<import("ssh2").Stats | null>((res) => {
            sftp.stat(dir, (err, st) => res(err ? null : st));
          });
          if (!parentStat) {
            throw new Error(`Remote parent directory does not exist: '${dir}'. Pass mkdir=true to create it.`);
          }
          if (typeof parentStat.isDirectory === "function" && !parentStat.isDirectory()) {
            throw new Error(`Remote parent path is not a directory: '${dir}'`);
          }
        }
      }

      return new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(args.path, {
          flags: args.append ? "a" : "w",
        });
        stream.on("close", () => resolve());
        stream.on("error", (err: any) => reject(new Error(`Failed to write to '${args.path}': ${err.message}`)));
        stream.end(buf);
      });
    })
  );

  globalEvents.emit("sftp_changed", { sessionId: args.sessionId, path: args.path });

  return {
    content: [{
      type: "text" as const,
      text: `Wrote ${buf.length} bytes to ${args.path}${args.append ? " (appended)" : ""}`,
    }],
  };
}

// --- Upload local file ---

export async function handleUploadFile(args: SshFileUploadArgs) {
  if (!path.isAbsolute(args.localPath)) {
    throw new Error("localPath must be an absolute path on the Desktop computer");
  }

  let localStatResult;
  try {
    localStatResult = await stat(args.localPath);
  } catch (err: any) {
    throw new Error(`Local source file not found: ${args.localPath} (${err.message})`);
  }

  if (!localStatResult.isFile()) {
    throw new Error(`Local path is not a file: ${args.localPath}`);
  }

  let finalRemotePath = args.path;
  await resolveClient(args, client =>
    withSftp(client, args.timeout ?? 300000, async sftp => {
      // 1. Auto-append source filename if remote path ends with / or is an existing directory
      if (finalRemotePath.endsWith("/")) {
        finalRemotePath = path.posix.join(finalRemotePath, path.basename(args.localPath));
      } else if (typeof sftp.stat === "function") {
        const remoteStat = await new Promise<import("ssh2").Stats | null>(resolve => {
          sftp.stat(finalRemotePath, (err, stats) => resolve(err ? null : stats));
        });
        if (remoteStat && typeof remoteStat.isDirectory === "function" && remoteStat.isDirectory()) {
          finalRemotePath = path.posix.join(finalRemotePath, path.basename(args.localPath));
        }
      }

      // 2. Parent directory verification and creation
      const dir = finalRemotePath.substring(0, finalRemotePath.lastIndexOf("/"));
      if (dir) {
        if (args.mkdir) {
          await sftpMkdir(sftp, dir, true);
        } else if (typeof sftp.stat === "function") {
          const parentStat = await new Promise<import("ssh2").Stats | null>(resolve => {
            sftp.stat(dir, (err, stats) => resolve(err ? null : stats));
          });
          if (!parentStat) {
            throw new Error(`Remote parent directory does not exist: '${dir}'. Pass mkdir=true to create it.`);
          }
          if (typeof parentStat.isDirectory === "function" && !parentStat.isDirectory()) {
            throw new Error(`Remote parent path is not a directory: '${dir}'`);
          }
        }
      }

      // 3. Check if target remote file already exists (overwrite check)
      let targetExists = false;
      if (typeof sftp.stat === "function") {
        const targetStat = await new Promise<import("ssh2").Stats | null>(resolve => {
          sftp.stat(finalRemotePath, (err, stats) => resolve(err ? null : stats));
        });
        if (targetStat) {
          if (typeof targetStat.isDirectory === "function" && targetStat.isDirectory()) {
            throw new Error(`Remote destination is a directory: '${finalRemotePath}'`);
          }
          if (!args.overwrite) {
            throw new Error(`Remote destination already exists: '${finalRemotePath}'. Pass overwrite=true to replace it.`);
          }
          targetExists = true;
        }
      }

      // 4. Stream to temporary file first (atomicity & safety)
      const temporaryPath = `${finalRemotePath}.ssh-mcp-upload-${randomBytes(8).toString("hex")}.tmp`;
      let writeStarted = false;
      try {
        writeStarted = true;
        await pipeline(
          createReadStream(args.localPath),
          sftp.createWriteStream(temporaryPath),
        );

        // 5. If target exists and overwrite=true, unlink existing file before renaming
        // Because SFTP v3 (OpenSSH) rename fails with SSH_FX_FAILURE if destination exists!
        if (targetExists) {
          await new Promise<void>((resolve, reject) => {
            sftp.unlink(finalRemotePath, (unlinkErr) => {
              if (unlinkErr) {
                reject(new Error(`Failed to remove existing remote file for overwrite '${finalRemotePath}': ${unlinkErr.message}`));
              } else {
                resolve();
              }
            });
          });
        }

        // 6. Rename temporary file to destination
        await new Promise<void>((resolve, reject) => {
          sftp.rename(temporaryPath, finalRemotePath, (renameErr) => {
            if (renameErr) {
              reject(new Error(`Failed to rename temporary upload file to '${finalRemotePath}': ${renameErr.message}`));
            } else {
              resolve();
            }
          });
        });
      } catch (error: any) {
        if (writeStarted) {
          await new Promise<void>(resolve => {
            sftp.unlink(temporaryPath, () => resolve());
          });
        }
        throw error;
      }
    })
  );

  globalEvents.emit("sftp_changed", { sessionId: args.sessionId, path: finalRemotePath });
  return {
    content: [{
      type: "text" as const,
      text: `Uploaded ${localStatResult.size} bytes from ${args.localPath} to ${finalRemotePath}`,
    }],
  };
}

// --- Download remote file ---

async function localStat(filePath: string) {
  try {
    return await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function safeMoveFile(source: string, destination: string) {
  try {
    await rename(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EXDEV" || code === "EPERM") {
      await copyFile(source, destination);
      await rm(source, { force: true }).catch(() => {});
    } else {
      throw error;
    }
  }
}

async function installDownloadedFile(temporaryPath: string, destinationPath: string, overwrite: boolean) {
  const destinationStat = await localStat(destinationPath);
  if (destinationStat) {
    if (!destinationStat.isFile()) {
      throw new Error(`Local destination is not a file: ${destinationPath}`);
    }
    if (!overwrite) {
      throw new Error(`Local destination already exists: ${destinationPath}. Pass overwrite=true to replace it.`);
    }

    const backupPath = `${destinationPath}.ssh-mcp-backup-${randomBytes(8).toString("hex")}.tmp`;
    await safeMoveFile(destinationPath, backupPath);
    try {
      await safeMoveFile(temporaryPath, destinationPath);
    } catch (error) {
      try {
        await safeMoveFile(backupPath, destinationPath);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Failed to install the downloaded file and restore the original destination: ${destinationPath}`,
        );
      }
      throw error;
    }
    await rm(backupPath, { force: true }).catch(() => {});
  } else {
    await safeMoveFile(temporaryPath, destinationPath);
  }
}

export async function handleDownloadFile(args: SshFileDownloadArgs) {
  let targetLocalPath = args.localPath;
  if (!path.isAbsolute(targetLocalPath)) {
    throw new Error("localPath must be an absolute path on the Desktop computer");
  }

  // Auto-append remote filename if local destination ends with slash or is a directory
  if (targetLocalPath.endsWith("/") || targetLocalPath.endsWith("\\")) {
    targetLocalPath = path.join(targetLocalPath, path.posix.basename(args.path));
  } else {
    const existing = await localStat(targetLocalPath);
    if (existing && existing.isDirectory()) {
      targetLocalPath = path.join(targetLocalPath, path.posix.basename(args.path));
    }
  }

  const parentDirectory = path.dirname(targetLocalPath);
  if (args.mkdir) {
    await mkdir(parentDirectory, { recursive: true });
  }

  const existingDestination = await localStat(targetLocalPath);
  if (existingDestination && !existingDestination.isFile()) {
    throw new Error(`Local destination is not a file: ${targetLocalPath}`);
  }
  if (existingDestination && !args.overwrite) {
    throw new Error(`Local destination already exists: ${targetLocalPath}. Pass overwrite=true to replace it.`);
  }

  const temporaryPath = path.join(
    parentDirectory,
    `.${path.basename(targetLocalPath)}.ssh-mcp-download-${randomBytes(8).toString("hex")}.tmp`,
  );

  try {
    const downloadedBytes = await resolveClient(args, client =>
      withSftp(client, args.timeout ?? 300000, async sftp => {
        const remoteStat = await new Promise<import("ssh2").Stats>((resolve, reject) => {
          sftp.stat(args.path, (error, value) => error ? reject(new Error(`Remote source file not found or inaccessible: '${args.path}' (${error.message})`)) : resolve(value));
        });
        if (!remoteStat.isFile()) {
          throw new Error(`Remote path is not a file: ${args.path}`);
        }

        await pipeline(
          sftp.createReadStream(args.path),
          createWriteStream(temporaryPath, { flags: "wx" }),
        );

        const downloadedStat = await stat(temporaryPath);
        if (downloadedStat.size !== remoteStat.size) {
          throw new Error(
            `Downloaded size mismatch for ${args.path}: expected ${remoteStat.size} bytes, received ${downloadedStat.size}`,
          );
        }
        return downloadedStat.size;
      })
    ) as number;

    await installDownloadedFile(temporaryPath, targetLocalPath, args.overwrite ?? false);
    return {
      content: [{
        type: "text" as const,
        text: `Downloaded ${downloadedBytes} bytes from ${args.path} to ${targetLocalPath}`,
      }],
    };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

// --- List ---

export async function handleListDir(args: SshFileListArgs) {
  const result = await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, async (sftp) => {
      // 1. readdir to get file list
      console.time('readdir');
      const list = await new Promise<any[]>((resolve, reject) => {
        sftp.readdir(args.path, (err, entries) => err ? reject(err) : resolve(entries));
      });
      console.timeEnd('readdir');

      // 2. Build text lines directly (extract symlink targets from longname to avoid RTT)
      const lines = list.map(item => {
        const type = item.attrs.isDirectory() ? "d" : item.attrs.isSymbolicLink() ? "l" : "-";
        const perms = modeToString(item.attrs.mode);
        const size = item.attrs.size.toString().padStart(10);
        const mtime = new Date(item.attrs.mtime * 1000).toISOString().replace("T", " ").substring(0, 19);
        
        let link = "";
        if (item.attrs.isSymbolicLink()) {
          const arrowIdx = item.longname?.indexOf(" -> ");
          if (arrowIdx !== -1 && item.longname) {
            link = ` -> ${item.longname.substring(arrowIdx + 4)}`;
          }
        }
        
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
    withSftp(client, args.timeout ?? 30000, async (sftp) => {
      if (args.recursive) {
        return sftpDeleteRecursive(sftp, args.path);
      }

      // Check whether target is a directory or file
      if (typeof sftp.stat === "function") {
        const stats = await new Promise<import("ssh2").Stats | null>((res) => {
          sftp.stat(args.path, (err, st) => res(err ? null : st));
        });
        if (stats && typeof stats.isDirectory === "function" && stats.isDirectory()) {
          return new Promise<void>((resolve, reject) => {
            sftp.rmdir(args.path, (err) => {
              if (err) {
                reject(new Error(`Cannot delete directory '${args.path}' (${err.message}). If it contains files, pass recursive=true to delete.`));
              } else {
                resolve();
              }
            });
          });
        }
      }

      return new Promise<void>((resolve, reject) => {
        sftp.unlink(args.path, (err) => {
          if (err) {
            reject(new Error(`Failed to delete '${args.path}': ${err.message}`));
          } else {
            resolve();
          }
        });
      });
    })
  );

  globalEvents.emit("sftp_changed", { sessionId: args.sessionId, path: args.path });

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

  globalEvents.emit("sftp_changed", { sessionId: args.sessionId, path: args.dest });

  return {
    content: [{ type: "text" as const, text: `Renamed: ${args.source} -> ${args.dest}` }],
  };
}

// --- Mkdir ---

function sftpMkdir(sftp: import("ssh2").SFTPWrapper, path: string, parents: boolean): Promise<void> {
  if (!parents) {
    return new Promise((resolve, reject) => {
      sftp.mkdir(path, (err) => {
        if (err) {
          reject(new Error(`Failed to create remote directory '${path}': ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  const parts = path.replace(/\/$/, "").split("/").filter(Boolean);
  let current = path.startsWith("/") ? "" : "";

  return new Promise((resolve, reject) => {
    let idx = 0;
    const processNext = async () => {
      if (idx >= parts.length) {
        return resolve();
      }
      current += `/${parts[idx++]}`;

      // 1. If sftp.stat is available, check if directory exists
      if (typeof sftp.stat === "function") {
        try {
          const stats = await new Promise<import("ssh2").Stats | null>((res) => {
            sftp.stat(current, (err, st) => res(err ? null : st));
          });
          if (stats) {
            if (typeof stats.isDirectory === "function" && !stats.isDirectory()) {
              return reject(new Error(`Path already exists and is not a directory: '${current}'`));
            }
            // Directory exists, proceed to next component
            return processNext();
          }
        } catch {
          // Ignore stat check error and attempt mkdir
        }
      }

      // 2. Directory does not exist, attempt to create it
      sftp.mkdir(current, (err) => {
        if (!err) {
          return processNext();
        }
        // If error occurred, check if directory actually exists
        if (typeof sftp.stat === "function") {
          sftp.stat(current, (statErr, st) => {
            if (!statErr && st && typeof st.isDirectory === "function" && st.isDirectory()) {
              return processNext();
            }
            reject(new Error(`Failed to create remote directory '${current}': ${err.message}`));
          });
        } else {
          if ((err as any)?.code === "EEXIST") {
            return processNext();
          }
          reject(new Error(`Failed to create remote directory '${current}': ${err.message}`));
        }
      });
    };

    processNext();
  });
}

export async function handleMkdir(args: SshFileMkdirArgs) {
  await resolveClient(args, (client) =>
    withSftp(client, args.timeout ?? 30000, (sftp) =>
      sftpMkdir(sftp, args.path, args.parents ?? true)
    )
  );

  globalEvents.emit("sftp_changed", { sessionId: args.sessionId, path: args.path });

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
