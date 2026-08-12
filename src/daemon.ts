import { startHttpServer } from "./server.js";
import { loadAndReconnectSessions, shutdownAllSessions } from "./session.js";

interface ElectronParentPort {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
}

type UtilityProcess = NodeJS.Process & { parentPort?: ElectronParentPort | null };

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

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Daemon] Shutting down (${reason})...`);
    await shutdownAllSessions();
    await httpServer.close?.().catch(error => {
      console.error("[Daemon] Failed to close HTTP server cleanly:", error);
    });
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  const parentPort = (process as UtilityProcess).parentPort;
  parentPort?.on("message", event => {
    const payload = event.data as { type?: unknown } | undefined;
    if (payload?.type === "shutdown") void shutdown("desktop");
  });
}

main().catch((err) => {
  console.error("[Daemon] Fatal error:", err);
  process.exit(1);
});
