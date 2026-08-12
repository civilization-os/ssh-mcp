import headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const { Terminal } = headless;

export interface TerminalSnapshot {
  bufferType: "normal" | "alternate";
  cols: number;
  rows: number;
  cursor: {
    row: number;
    column: number;
  };
  historyLines: string[];
  screenLines: string[];
}

export interface SeparatedTerminalOutput {
  inputEcho: string[];
  programLines: string[];
}

export class TerminalView {
  private readonly terminal: HeadlessTerminal;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number) {
    const safeCols = Math.max(2, Math.min(500, Math.floor(cols)));
    const safeRows = Math.max(1, Math.min(200, Math.floor(rows)));
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: safeCols,
      rows: safeRows,
      scrollback: 10_000,
      logLevel: "off",
    });
  }

  write(data: Uint8Array | string): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => new Promise<void>(resolve => {
      this.terminal.write(data, resolve);
    }));
    return this.writeQueue;
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  resize(cols: number, rows: number): void {
    const safeCols = Math.max(2, Math.min(500, Math.floor(cols)));
    const safeRows = Math.max(1, Math.min(200, Math.floor(rows)));
    this.terminal.resize(safeCols, safeRows);
  }

  snapshot(): TerminalSnapshot {
    const buffer = this.terminal.buffer.active;
    const cursorBufferRow = buffer.baseY + buffer.cursorY;
    let lastContentRow = cursorBufferRow;

    for (let row = buffer.length - 1; row >= 0; row -= 1) {
      const line = buffer.getLine(row)?.translateToString(true) ?? "";
      if (line) {
        lastContentRow = Math.max(lastContentRow, row);
        break;
      }
    }

    const historyLines: string[] = [];
    for (let row = 0; row <= lastContentRow; row += 1) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && historyLines.length > 0) {
        historyLines[historyLines.length - 1] += text;
      } else {
        historyLines.push(text);
      }
    }

    const screenLines: string[] = [];
    const screenEnd = Math.min(buffer.length, buffer.viewportY + this.terminal.rows);
    for (let row = buffer.viewportY; row < screenEnd; row += 1) {
      screenLines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }

    while (
      screenLines.length > buffer.cursorY + 1 &&
      screenLines.at(-1) === ""
    ) {
      screenLines.pop();
    }

    return {
      bufferType: buffer.type,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      cursor: {
        row: buffer.cursorY,
        column: buffer.cursorX,
      },
      historyLines,
      screenLines,
    };
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

export function semanticDelta(previous: readonly string[], current: readonly string[]): string[] {
  let sharedPrefix = 0;
  const limit = Math.min(previous.length, current.length);
  while (sharedPrefix < limit && previous[sharedPrefix] === current[sharedPrefix]) {
    sharedPrefix += 1;
  }
  return current.slice(sharedPrefix);
}

export function separateInputEcho(
  lines: readonly string[],
  input: string,
  inputEchoPrefix?: string,
): SeparatedTerminalOutput {
  const programLines = [...lines];
  const inputEcho: string[] = [];
  const candidates = input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter(candidate => candidate.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(candidate));

  let searchFrom = 0;
  const searchLimit = Math.min(programLines.length, candidates.length + 2);
  for (const [candidateIndex, candidate] of candidates.entries()) {
    for (let lineIndex = searchFrom; lineIndex < searchLimit; lineIndex += 1) {
      const line = programLines[lineIndex];
      const echoStart = line.lastIndexOf(candidate);
      if (echoStart === -1 || echoStart + candidate.length !== line.length) continue;
      if (
        candidateIndex === 0 &&
        inputEchoPrefix !== undefined &&
        line.slice(0, echoStart).trimEnd() !== inputEchoPrefix.trimEnd()
      ) continue;

      inputEcho.push(candidate);
      programLines[lineIndex] = line.slice(0, echoStart).trimEnd();
      searchFrom = lineIndex + 1;
      break;
    }
  }

  return { inputEcho, programLines };
}
