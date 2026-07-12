import { describe, it, expect } from "vitest";
import {
  validateSshConnectArgs,
  validateSshDisconnectArgs,
  validateSshFileReadArgs,
  validateSshFileWriteArgs,
  validateSshFileListArgs,
  validateSshFileDeleteArgs,
  validateSshFileRenameArgs,
  validateSshFileMkdirArgs,
  validateSshFileChmodArgs,
  validateSshFileStatArgs,
  validateSshSysinfoArgs,
  validateSshProcessesArgs,
  validateSshDiskUsageArgs,
  validateSshShellArgs,
  validateSshShellWriteArgs,
  validateSshShellReadArgs,
  validateSshShellResizeArgs,
  validateSshShellCloseArgs,
  extractCredentials,
  extractSessionId,
} from "./types.js";

describe("validateSshConnectArgs", () => {
  it("accepts valid args with host", () => {
    expect(validateSshConnectArgs({ host: "example.com" })).toBe(true);
  });

  it("accepts valid args with host and port", () => {
    expect(validateSshConnectArgs({ host: "10.0.0.1", port: 2222 })).toBe(true);
  });

  it("rejects null/undefined", () => {
    expect(validateSshConnectArgs(null)).toBe(false);
    expect(validateSshConnectArgs(undefined)).toBe(false);
  });

  it("rejects missing host", () => {
    expect(validateSshConnectArgs({})).toBe(false);
    expect(validateSshConnectArgs({ port: 22 })).toBe(false);
  });

  it("rejects non-string host", () => {
    expect(validateSshConnectArgs({ host: 123 })).toBe(false);
  });
});

describe("validateSshDisconnectArgs", () => {
  it("accepts valid sessionId", () => {
    expect(validateSshDisconnectArgs({ sessionId: "sess_123" })).toBe(true);
  });

  it("rejects missing sessionId", () => {
    expect(validateSshDisconnectArgs({})).toBe(false);
  });
});

describe("validateSshFileReadArgs", () => {
  it("accepts valid path", () => {
    expect(validateSshFileReadArgs({ path: "/etc/hosts" })).toBe(true);
  });

  it("accepts path with sessionId", () => {
    expect(validateSshFileReadArgs({ sessionId: "s1", path: "/tmp/test" })).toBe(true);
  });

  it("rejects missing path", () => {
    expect(validateSshFileReadArgs({})).toBe(false);
    expect(validateSshFileReadArgs({ sessionId: "s1" })).toBe(false);
  });
});

describe("validateSshFileWriteArgs", () => {
  it("accepts valid path and content", () => {
    expect(validateSshFileWriteArgs({ path: "/tmp/f", content: "hello" })).toBe(true);
  });

  it("rejects missing content", () => {
    expect(validateSshFileWriteArgs({ path: "/tmp/f" })).toBe(false);
  });

  it("rejects missing path", () => {
    expect(validateSshFileWriteArgs({ content: "hello" })).toBe(false);
  });

  it("rejects null args", () => {
    expect(validateSshFileWriteArgs(null)).toBe(false);
  });
});

describe("validateSshFileListArgs", () => {
  it("accepts path", () => {
    expect(validateSshFileListArgs({ path: "/tmp" })).toBe(true);
  });

  it("rejects no path", () => {
    expect(validateSshFileListArgs({})).toBe(false);
  });
});

describe("validateSshFileDeleteArgs", () => {
  it("accepts path", () => {
    expect(validateSshFileDeleteArgs({ path: "/tmp/a" })).toBe(true);
  });

  it("accepts path + recursive", () => {
    expect(validateSshFileDeleteArgs({ path: "/tmp/dir", recursive: true })).toBe(true);
  });
});

describe("validateSshFileRenameArgs", () => {
  it("accepts source and dest", () => {
    expect(validateSshFileRenameArgs({ source: "/a", dest: "/b" })).toBe(true);
  });

  it("rejects missing dest", () => {
    expect(validateSshFileRenameArgs({ source: "/a" })).toBe(false);
  });

  it("rejects missing source", () => {
    expect(validateSshFileRenameArgs({ dest: "/b" })).toBe(false);
  });
});

describe("validateSshFileMkdirArgs", () => {
  it("accepts path", () => {
    expect(validateSshFileMkdirArgs({ path: "/new/dir" })).toBe(true);
  });
});

describe("validateSshFileChmodArgs", () => {
  it("accepts path and mode", () => {
    expect(validateSshFileChmodArgs({ path: "/f", mode: "755" })).toBe(true);
  });

  it("rejects missing mode", () => {
    expect(validateSshFileChmodArgs({ path: "/f" })).toBe(false);
  });
});

describe("validateSshFileStatArgs", () => {
  it("accepts path", () => {
    expect(validateSshFileStatArgs({ path: "/f" })).toBe(true);
  });
});

describe("validateSshSysinfoArgs", () => {
  it("accepts any object", () => {
    expect(validateSshSysinfoArgs({})).toBe(true);
  });

  it("accepts sessionId only", () => {
    expect(validateSshSysinfoArgs({ sessionId: "s1" })).toBe(true);
  });
});

describe("validateSshProcessesArgs", () => {
  it("accepts any object", () => {
    expect(validateSshProcessesArgs({})).toBe(true);
  });

  it("accepts sort + limit", () => {
    expect(validateSshProcessesArgs({ sort: "memory", limit: 10 })).toBe(true);
  });
});

describe("validateSshDiskUsageArgs", () => {
  it("accepts any object", () => {
    expect(validateSshDiskUsageArgs({})).toBe(true);
  });

  it("accepts path", () => {
    expect(validateSshDiskUsageArgs({ path: "/var" })).toBe(true);
  });
});

describe("validateSshShellArgs", () => {
  it("accepts sessionId", () => {
    expect(validateSshShellArgs({ sessionId: "s1" })).toBe(true);
  });

  it("accepts with term options", () => {
    expect(validateSshShellArgs({ sessionId: "s1", cols: 80, rows: 24 })).toBe(true);
  });

  it("rejects missing sessionId", () => {
    expect(validateSshShellArgs({})).toBe(false);
  });
});

describe("validateSshShellWriteArgs", () => {
  it("accepts shellId and input", () => {
    expect(validateSshShellWriteArgs({ shellId: "sh_1", input: "ls -la" })).toBe(true);
  });

  it("accepts raw flag", () => {
    expect(validateSshShellWriteArgs({ shellId: "sh_1", input: "\x03", raw: true })).toBe(true);
  });

  it("rejects missing input", () => {
    expect(validateSshShellWriteArgs({ shellId: "sh_1" })).toBe(false);
  });

  it("rejects missing shellId", () => {
    expect(validateSshShellWriteArgs({ input: "ls" })).toBe(false);
  });
});

describe("validateSshShellReadArgs", () => {
  it("accepts shellId", () => {
    expect(validateSshShellReadArgs({ shellId: "sh_1" })).toBe(true);
  });

  it("accepts optional params", () => {
    expect(validateSshShellReadArgs({ shellId: "sh_1", waitMs: 500, expect: "root@", stripAnsi: true })).toBe(true);
  });
});

describe("validateSshShellResizeArgs", () => {
  it("accepts shellId", () => {
    expect(validateSshShellResizeArgs({ shellId: "sh_1" })).toBe(true);
  });
});

describe("validateSshShellCloseArgs", () => {
  it("accepts shellId", () => {
    expect(validateSshShellCloseArgs({ shellId: "sh_1" })).toBe(true);
  });
});



// ======== extract helpers ========

describe("extractCredentials", () => {
  it("extracts all credential fields", () => {
    const result = extractCredentials({
      host: "10.0.0.1",
      port: 2222,
      username: "admin",
      password: "secret",
      privateKey: "key-content",
      passphrase: "pass",
      timeout: 30000,
    });
    expect(result.host).toBe("10.0.0.1");
    expect(result.port).toBe(2222);
    expect(result.username).toBe("admin");
    expect(result.password).toBe("secret");
    expect(result.privateKey).toBe("key-content");
    expect(result.passphrase).toBe("pass");
    expect(result.timeout).toBe(30000);
  });

  it("returns undefined for missing fields", () => {
    const result = extractCredentials({});
    expect(result.host).toBeUndefined();
    expect(result.port).toBeUndefined();
    expect(result.username).toBeUndefined();
  });

  it("skips non-string/non-number fields", () => {
    const result = extractCredentials({ host: 123, port: "not-a-number", username: true });
    expect(result.host).toBeUndefined();
    expect(result.port).toBeUndefined();
    expect(result.username).toBeUndefined();
  });
});

describe("extractSessionId", () => {
  it("extracts sessionId string", () => {
    expect(extractSessionId({ sessionId: "sess_123" })).toBe("sess_123");
  });

  it("returns undefined for missing sessionId", () => {
    expect(extractSessionId({})).toBeUndefined();
  });

  it("returns undefined for non-string sessionId", () => {
    expect(extractSessionId({ sessionId: 123 })).toBeUndefined();
  });
});
