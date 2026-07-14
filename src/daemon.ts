import { startHttpServer } from "./server.js";
import { loadAndReconnectSessions } from "./session.js";

async function main() {
  const port = parseInt(process.env.PORT || "12222", 10);
  
  console.log(`[Daemon] Starting SSH-MCP daemon on port ${port}...`);
  const httpServer = await startHttpServer(port);
  
  if (httpServer.reused) {
    console.log(`[Daemon] Port ${port} is already in use by another instance. Exiting daemon.`);
    process.exit(0);
  }

  console.log(`[Daemon] SSH-MCP HTTP/WS server listening on port ${httpServer.port}`);

  // Recover any legacy sessions if applicable
  await loadAndReconnectSessions();
  
  // Keep the process running
  process.on("SIGINT", () => {
    console.log("[Daemon] Shutting down...");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[Daemon] Fatal error:", err);
  process.exit(1);
});
