import { describe, it, expect, vi, beforeEach } from "vitest";

describe("handleShellCreate", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error for unknown session", async () => {
    vi.doMock("../session.js", () => ({
      getSession: vi.fn(() => undefined),
    }));

    const { handleShellCreate } = await import("./shell.js");
    const result = await handleShellCreate({ sessionId: "bad_session" }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error for k8s-type session", async () => {
    vi.doMock("../session.js", () => ({
      getSession: vi.fn(() => ({
        id: "k8s_1",
        type: "k8s",
        client: undefined,
      })),
    }));

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
