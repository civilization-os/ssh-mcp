import { spawn } from "child_process";

const server = spawn("node", ["build/index.js"], { stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
server.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      } else if (msg.id === 2) {
        const tools = msg.result?.tools || [];
        console.log(`Total tools: ${tools.length}`);
        tools.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}`));
        server.kill();
        process.exit(0);
      }
    } catch {}
  }
});

function send(msg) { server.stdin.write(JSON.stringify(msg) + "\n"); }

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } });

setTimeout(() => { server.kill(); process.exit(1); }, 5000);
