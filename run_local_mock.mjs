import ssh2 from "ssh2";
const { Server } = ssh2;
import { spawn } from "child_process";
import crypto from "crypto";
import http from "http";

const hostKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" }
}).privateKey;

const PORT = 22222;

// 1. Start Mock SSH Server
const sshServer = new Server({
  hostKeys: [hostKey]
}, (client) => {
  client.on("authentication", (ctx) => {
    if (ctx.username === "test" && ctx.password === "test") ctx.accept();
    else ctx.reject();
  }).on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (accept, reject, info) => {
        const stream = accept();
        const cmd = info.command;
        console.log(`[Mock SSH Server Exec]: ${cmd}`);
        
        if (cmd.includes("uname -s")) {
          stream.write("Linux\n");
        } else if (cmd.includes("uname -r")) {
          stream.write("5.15.0-mock-k8s\n");
        } else if (cmd.includes("uname -m")) {
          stream.write("x86_64\n");
        } else if (cmd.includes("uname -a")) {
          stream.write("Linux mock-server 5.15.0-mock x86_64 GNU/Linux\n");
        } else if (cmd.includes("nproc")) {
          stream.write("4\n");
        } else if (cmd.includes("cpuinfo") || cmd.includes("lscpu")) {
          stream.write("Model name:          AMD EPYC Mock Processor @ 2.50GHz\nCPU(s):              4\n");
        } else if (cmd.includes("free -h") && cmd.includes("Mem:")) {
          stream.write("Mem:          7.7Gi       3.2Gi       2.1Gi       0.1Gi       2.4Gi       4.1Gi\n");
        } else if (cmd.includes("free -h") && cmd.includes("Swap:")) {
          stream.write("Swap:         2.0Gi       0.2Gi       1.8Gi\n");
        } else if (cmd.includes("loadavg")) {
          stream.write("0.15 0.08 0.05 1/240 28405\n");
        } else if (cmd.includes("uptime")) {
          stream.write("up 12 days,  4:32,  2 users,  load average: 0.15, 0.08, 0.05\n");
        } else if (cmd.includes("df -h /") || cmd.includes("df -h")) {
          stream.write("/dev/sda1        50G   15G   35G  30% /\n");
        } else if (cmd.includes("ps -eo")) {
          stream.write("  PID %CPU %MEM COMMAND\n  8421 12.5 15.4 java -jar app.jar\n  2841  1.5  4.5 node build/index.js\n  1205  0.8  1.2 nginx: worker process\n   840  0.2  0.8 containerd\n");
        } else if (cmd.includes("kubectl get pods")) {
          stream.write("NAMESPACE     NAME                               READY   STATUS    RESTARTS   AGE\ndefault       java-service-86fbfb45-abcde        1/1     Running   0          5d\ndefault       frontend-nginx-68f766c6b-12345     1/1     Running   2          12d\nkube-system   kube-dns-5c6c646b-fghij            1/1     Running   0          30d\n");
        } else if (cmd.includes("kubectl logs")) {
          stream.write("[INFO] 2026-06-08 00:00:01 - Started Spring Boot Application...\n[INFO] 2026-06-08 00:00:03 - Connected to database pool.\n[WARN] 2026-06-08 00:05:12 - High database latency detected (120ms)\n[INFO] 2026-06-08 00:10:45 - Health check OK.\n");
        } else if (cmd.includes("arthas")) {
          stream.write("[Arthas Console Response]\n- Target JVM Attached (PID 8421)\n- Running command: \"thread -n 3\"\n\nPID: 14 | NAME: http-nio-8080-exec-1 | CPU%: 85.2 | STATE: RUNNABLE\n  at java.util.HashMap.get(HashMap.java:557)\n  at com.example.service.LeakService.loop(LeakService.java:42)\n");
        } else {
          stream.write(`Executed: ${cmd}\n`);
        }
        stream.exit(0);
        stream.end();
      });

      session.on("sftp", (accept, reject) => {
        const sftp = accept();
        sftp.on("REALPATH", (id, path) => {
          sftp.name(id, [{ filename: path, longname: path, attrs: {} }]);
        });

        let mockDirHandle = Buffer.from("mock-dir-handle");
        let mockDirState = 0;

        sftp.on("OPENDIR", (id, path) => {
          console.log(`[Mock SFTP OPENDIR]: ${path}`);
          sftp.handle(id, mockDirHandle);
          mockDirState = 0;
        });

        sftp.on("READDIR", (id, handle) => {
          if (mockDirState === 0) {
            mockDirState = 1;
            const nowSeconds = Math.floor(Date.now() / 1000);
            sftp.name(id, [
              {
                filename: "my_mock_folder",
                longname: "drwxr-xr-x 1 root root 4096 Jun 7 12:00 my_mock_folder",
                attrs: {
                  mode: 0o40755,
                  size: 4096,
                  mtime: nowSeconds,
                  atime: nowSeconds,
                  isDirectory() { return true; },
                  isSymbolicLink() { return false; }
                }
              },
              {
                filename: "k8s_logs_archive.tar.gz",
                longname: "-rw-r--r-- 1 root root 1048576 Jun 7 12:00 k8s_logs_archive.tar.gz",
                attrs: {
                  mode: 0o100644,
                  size: 1048576,
                  mtime: nowSeconds,
                  atime: nowSeconds,
                  isDirectory() { return false; },
                  isSymbolicLink() { return false; }
                }
              }
            ]);
          } else {
            sftp.status(id, 1); // SSH_FX_EOF
          }
        });

        sftp.on("CLOSE", (id, handle) => {
          sftp.status(id, 0);
        });
      });


      session.on("pty", (accept, reject, info) => {
        console.log("Mock Server: PTY allocation requested");
        accept();
      });

      session.on("shell", (accept, reject) => {
        console.log("Mock Server: Interactive shell PTY requested");
        const channel = accept();
        
        channel.on("data", (data) => {
          const str = data.toString();
          // Echo input back to client (necessary for terminals to display typed text)
          if (str === "\r" || str === "\n") {
            channel.write("\r\n[mock-user@local-mock ~]$ ");
          } else {
            // Simple command execution simulation if they press enter
            channel.write(str);
          }
        });

        // Write welcome banner and prompt
        channel.write("\r\n*** Welcome to SSH-MCP Mock Server Terminal ***\r\n");
        channel.write("[mock-user@local-mock ~]$ ");
      });

    });
  });
});

sshServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[Mock SSH Server] listening on 127.0.0.1:${PORT}`);
  
  // 2. Start MCP Server (which starts HTTP server on 12222)
  console.log("Starting MCP Server...");
  const mcpServer = spawn("node", ["build/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
  
  // 3. Wait for MCP Server to boot, then seed the SSH connection
  setTimeout(() => {
    console.log("Seeding SSH Session in connection pool...");
    const postData = JSON.stringify({
      host: "127.0.0.1",
      port: PORT,
      username: "test",
      password: "test",
      name: "Mock-Server-Local"
    });

    const req = http.request({
      hostname: "127.0.0.1",
      port: 12222,
      path: "/api/sessions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    }, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => responseBody += chunk);
      res.on("end", () => {
        console.log(`[Seeding Response] Status: ${res.statusCode}`, responseBody);
        console.log("\n==================================================");
        console.log("🎉 Local Mock Environment is FULLY READY!");
        console.log("👉 Go to your browser: http://localhost:5174/");
        console.log("👉 You will see 'Mock-Server-Local' session active.");
        console.log("👉 Click '+ NEW' in the sidebar to open a real PTY!");
        console.log("==================================================\n");
      });
    });

    req.on("error", (e) => {
      console.error(`Problem with seeding request: ${e.message}`);
    });

    req.write(postData);
    req.end();
  }, 2500);

  process.on("SIGINT", () => {
    mcpServer.kill();
    sshServer.close(() => {
      console.log("Stopped local mock environment.");
      process.exit(0);
    });
  });
});
