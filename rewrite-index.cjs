const fs = require('fs');
const toolsLines = fs.readFileSync('tools_extract.txt', 'utf-8');

const newIndexTs = `#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import { WebSocket } from "ws";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const DAEMON_PORT = 12222;
const DAEMON_URL = \`http://127.0.0.1:\${DAEMON_PORT}\`;

const server = new Server(
  { name: "ssh-mcp", version: "2.2.0" },
  { capabilities: { tools: {}, resources: { subscribe: true } } }
);

async function ensureDaemonRunning() {
  try {
    const res = await fetch(\`\${DAEMON_URL}/api/version\`);
    if (res.ok) return true;
  } catch {}

  console.error(\`[MCP Proxy] Daemon not running on port \${DAEMON_PORT}. Attempting to start...\`);
  
  const selfPath = process.argv[1]
    ? path.resolve(process.argv[1])
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  const daemonPath = path.join(path.dirname(selfPath), "daemon.js");
  
  if (!fs.existsSync(daemonPath)) {
    console.error(\`[MCP Proxy] Daemon script not found at \${daemonPath}\`);
    return false;
  }

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  
  child.unref();

  // Wait for it to boot
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      if ((await fetch(\`\${DAEMON_URL}/api/version\`)).ok) {
        console.error(\`[MCP Proxy] Daemon successfully started.\`);
        return true;
      }
    } catch {}
  }
  
  console.error(\`[MCP Proxy] Failed to start daemon.\`);
  return false;
}

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: [
      {
        uriTemplate: "mcp://ssh/shell/{shellId}/output",
        name: "Interactive Shell Output Stream",
        description: "Real-time incremental output and status from a PTY shell session",
        mimeType: "application/json",
      }
    ],
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const res = await fetch(\`\${DAEMON_URL}/api/mcp/resources\`);
    if (!res.ok) throw new Error("Daemon error");
    return await res.json() as any;
  } catch (err: any) {
    throw new McpError(ErrorCode.InternalError, \`Failed to list resources: \${err.message}\`);
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const res = await fetch(\`\${DAEMON_URL}/api/mcp/resource?uri=\${encodeURIComponent(request.params.uri)}\`);
    if (!res.ok) throw new Error("Daemon error");
    return await res.json() as any;
  } catch (err: any) {
    throw new McpError(ErrorCode.InternalError, \`Failed to read resource: \${err.message}\`);
  }
});

const activeSubscriptions = new Set<string>();

server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  activeSubscriptions.add(request.params.uri);
  return {};
});

server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  activeSubscriptions.delete(request.params.uri);
  return {};
});

function connectDaemonEvents() {
  const ws = new WebSocket(\`ws://127.0.0.1:\${DAEMON_PORT}/ws/mcp-events\`);
  
  ws.on("open", () => {
    // connected
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "resourceUpdated" && activeSubscriptions.has(msg.uri)) {
        server.notification({
          method: "notifications/resources/updated",
          params: { uri: msg.uri },
        });
      }
    } catch (e) {}
  });

  ws.on("close", () => {
    setTimeout(connectDaemonEvents, 2000);
  });
  
  ws.on("error", () => {
    // ignore
  });
}

const authFields = {
  host: { type: "string" as const, description: "Remote server hostname or IP address" },
  port: { type: "number" as const, description: "SSH port (default: 22)", default: 22 },
  username: { type: "string" as const, description: "SSH username (default: root)", default: "root" },
  password: { type: "string" as const, description: "SSH password (use either password or privateKey)" },
  privateKey: { type: "string" as const, description: "SSH private key content as string" },
  passphrase: { type: "string" as const, description: "Passphrase for the private key" },
  timeout: { type: "number" as const, description: "Operation timeout in milliseconds (default: 30000)", default: 30000 },
};

${toolsLines}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const res = await fetch(\`\${DAEMON_URL}/api/mcp/tool\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args })
    });
    
    const result = await res.json();
    return result as any;
  } catch (err: any) {
    return { content: [{ type: "text", text: \`Error calling daemon: \${err.message}\` }], isError: true };
  }
});

async function main() {
  await ensureDaemonRunning();
  connectDaemonEvents();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
`;

fs.writeFileSync('src/index.ts', newIndexTs);
