import { describe, expect, it } from "vitest";
import { semanticDelta, separateInputEcho, TerminalView } from "./terminalView.js";

describe("TerminalView", () => {
  it("applies carriage return and backspace semantics", async () => {
    const view = new TerminalView(20, 4);
    await view.write("Downloading 10%\r\x1b[2KDownloading 90%\r\x1b[2KDone\r\nabc\b!");

    const snapshot = view.snapshot();
    expect(snapshot.historyLines.slice(0, 2)).toEqual(["Done", "ab!"]);
    expect(snapshot.cursor).toEqual({ row: 1, column: 3 });
    view.dispose();
  });

  it("preserves the characters that a bare carriage return does not erase", async () => {
    const view = new TerminalView(20, 3);
    await view.write("progress 90%\roky");
    expect(view.snapshot().historyLines[0]).toBe("okygress 90%");
    view.dispose();
  });

  it("applies ANSI cursor movement, clear-line, and wide-character semantics", async () => {
    const view = new TerminalView(12, 4);
    await view.write("first\r\nsecond\x1b[1A\r\x1b[2K中文");

    const snapshot = view.snapshot();
    expect(snapshot.historyLines[0]).toBe("中文");
    expect(snapshot.historyLines[1]).toBe("second");
    expect(snapshot.cursor).toEqual({ row: 0, column: 4 });
    view.dispose();
  });

  it("tracks the alternate screen as the user-visible screen", async () => {
    const view = new TerminalView(10, 3);
    await view.write("normal\x1b[?1049h\x1b[HALT\x1b[2;3HXY");

    const active = view.snapshot();
    expect(active.bufferType).toBe("alternate");
    expect(active.screenLines.slice(0, 2)).toEqual(["ALT", "  XY"]);

    await view.write("\x1b[?1049l");
    expect(view.snapshot().historyLines[0]).toBe("normal");
    view.dispose();
  });
});

describe("semanticDelta", () => {
  it("returns the visible tail starting at the first changed terminal line", () => {
    expect(semanticDelta(["prompt$", ""], ["prompt$ command", "result", "prompt$"]))
      .toEqual(["prompt$ command", "result", "prompt$"]);
  });
});

describe("separateInputEcho", () => {
  it("removes a completion marker from the echoed command but keeps real output", () => {
    const separated = separateInputEcho(
      ["root@host:~# printf '__MCP_DONE__\\n'", "__MCP_DONE__", "root@host:~#"],
      "printf '__MCP_DONE__\\n'\n",
      "root@host:~#",
    );

    expect(separated.inputEcho).toEqual(["printf '__MCP_DONE__\\n'"]);
    expect(separated.programLines).toEqual(["__MCP_DONE__", "root@host:~#"]);
  });

  it("removes a Bash prompt plus command echo even when the prompt was redrawn", () => {
    const command = "sleep 3; echo EXPECT_REAL_OUTPUT";
    const separated = separateInputEcho(
      [
        `(base) [root@server current]# ${command}`,
        "EXPECT_REAL_OUTPUT",
        "(base) [root@server current]#",
      ],
      `${command}\n`,
      "(base) [root@server previous]#",
    );

    expect(separated.inputEcho).toEqual([command]);
    expect(separated.programLines).toEqual([
      "EXPECT_REAL_OUTPUT",
      "(base) [root@server current]#",
    ]);
  });

  it("does not remove output when the terminal did not echo the input", () => {
    expect(separateInputEcho(["secret-password"], "secret-password\n", "Password:")).toEqual({
      inputEcho: [],
      programLines: ["secret-password"],
    });
  });
});
