import { describe, it, expect, vi, beforeEach } from "vitest";

// Strategy: make getSession() return undefined so we fall into SSH executor.
// Then make resolveClient resolve with an error-like result (not reject).
const errResult = { stdout: "", stderr: "connection failed", exitCode: -1 } as any;

describe("handleK8sListPods", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error when command fails", async () => {
    vi.doMock("../session.js", () => ({
      getSession: vi.fn(() => undefined),
      resolveClient: vi.fn().mockResolvedValue(errResult),
    }));

    const { handleK8sListPods } = await import("./k8s.js");
    const result = await handleK8sListPods({}) as any;
    expect(result.isError).toBeTruthy();
  });

  it("uses namespace when provided", async () => {
    vi.doMock("../session.js", () => ({
      getSession: vi.fn(() => undefined),
      resolveClient: vi.fn().mockResolvedValue(errResult),
    }));

    const { handleK8sListPods } = await import("./k8s.js");
    const result = await handleK8sListPods({ namespace: "default" }) as any;
    expect(result.isError).toBeTruthy();
  });
});

describe("handleK8sPodLogs", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error when command fails", async () => {
    vi.doMock("../session.js", () => ({
      getSession: vi.fn(() => undefined),
      resolveClient: vi.fn().mockResolvedValue(errResult),
    }));

    const { handleK8sPodLogs } = await import("./k8s.js");
    const result = await handleK8sPodLogs({ namespace: "default", pod: "my-pod" }) as any;
    expect(result.isError).toBeTruthy();
  });
});

describe("handleK8sPodExec", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error when command fails", async () => {
    vi.doMock("../session.js", () => ({
      getSession: vi.fn(() => undefined),
      resolveClient: vi.fn().mockResolvedValue(errResult),
    }));

    const { handleK8sPodExec } = await import("./k8s.js");
    const result = await handleK8sPodExec({
      namespace: "default",
      pod: "my-pod",
      command: "ls",
    }) as any;
    expect(result.isError).toBeTruthy();
  });
});

describe("handleK8sPodCp", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error when copy fails", async () => {
    vi.doMock("../session.js", () => ({
      getSession: vi.fn(() => undefined),
      resolveClient: vi.fn().mockResolvedValue(errResult),
    }));

    const { handleK8sPodCp } = await import("./k8s.js");
    const result = await handleK8sPodCp({
      namespace: "default",
      pod: "my-pod",
      direction: "to_pod",
      hostPath: "/local/file",
      podPath: "/pod/file",
    }) as any;
    expect(result.isError).toBeTruthy();
  });
});

describe("handleK8sArthasAttach", () => {
  beforeEach(() => { vi.resetModules(); });

  it("returns error when command fails", async () => {
    vi.doMock("../session.js", () => ({
      getSession: vi.fn(() => undefined),
      resolveClient: vi.fn().mockResolvedValue(errResult),
    }));

    const { handleK8sArthasAttach } = await import("./k8s.js");
    const result = await handleK8sArthasAttach({ command: "thread -n 3" }) as any;
    expect(result.isError).toBeTruthy();
  });
});
