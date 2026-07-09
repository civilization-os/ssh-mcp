import { Client } from "ssh2";
import { resolveClient, getSession } from "../session.js";
import { ToolResult, SshK8sArthasAttachArgs, Session } from "../types.js";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";

const execAsync = promisify(exec);
const isWindows = process.platform === "win32";

export interface K8sExecutor {
  session?: Session;
  type: "ssh" | "k8s";
  exec(command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  fileExists(remotePath: string): Promise<boolean>;
  getArch(): Promise<string>;
}

function execQuickCommand(
  client: Client,
  command: string,
  timeoutMs: number = 30000
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    client.exec(command, (err, channel) => {
      if (err) {
        resolve({ stdout: "", stderr: `exec error: ${err.message}`, exitCode: -1 });
        return;
      }
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let resolved = false;
      
      const channelTimer = setTimeout(() => {
        channel.close();
      }, timeoutMs);

      // Safety timeout: if close event never fires, force resolve
      const safetyTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearTimeout(channelTimer);
          resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
        }
      }, timeoutMs + 5000);

      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(channelTimer);
        clearTimeout(safetyTimer);
        resolve({ stdout, stderr, exitCode });
      };

      channel.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });
      channel.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });
      channel.on("exit", (code: number | null) => {
        exitCode = code;
      });
      channel.on("close", done);
      channel.on("error", () => done());
    });
  });
}

async function getExecutor(args: any): Promise<K8sExecutor> {
  const session = args.sessionId ? getSession(args.sessionId) : undefined;

  if (session?.type === "k8s") {
    return {
      session,
      type: "k8s",
      exec: async (command, timeoutMs) => {
        const env = { ...process.env, KUBECONFIG: session.kubeconfigPath };
        try {
          const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs, env });
          return { stdout, stderr, exitCode: 0 };
        } catch (e: any) {
          return { 
            stdout: e.stdout || "", 
            stderr: e.stderr || e.message, 
            exitCode: e.code !== undefined ? e.code : -1 
          };
        }
      },
      uploadFile: async (local, remote) => {
        // In local k8s mode, 'remote' is still the jump host (which is the local machine)
        const remoteDir = isWindows ? path.dirname(remote) : path.posix.dirname(remote);
        if (!fs.existsSync(remoteDir)) {
          fs.mkdirSync(remoteDir, { recursive: true });
        }
        fs.copyFileSync(local, remote);
      },
      fileExists: async (remotePath) => {
        return fs.existsSync(remotePath);
      },
      getArch: async () => {
        const arch = os.arch();
        if (arch === "x64") return "x86_64";
        if (arch === "arm64") return "aarch64";
        return arch;
      }
    };
  }

  // SSH Executor
  return {
    session,
    type: "ssh",
    exec: async (command, timeoutMs) => {
      return resolveClient(args, (client) => execQuickCommand(client, command, timeoutMs)) as any;
    },
    uploadFile: async (local, remote) => {
      return resolveClient(args, (client) => {
        return new Promise((resolve, reject) => {
          client.sftp((err, sftp) => {
            if (err) return reject(err);
            // Remote is always Linux in SSH mode
            const remoteDir = path.posix.dirname(remote);
            client.exec(`mkdir -p "${remoteDir}"`, (mkdirErr, channel) => {
              if (mkdirErr) { sftp.end(); return reject(mkdirErr); }
              channel.on("close", () => {
                sftp.fastPut(local, remote, (putErr) => {
                  sftp.end();
                  if (putErr) reject(putErr);
                  else resolve(undefined);
                });
              });
            });
          });
        });
      }) as Promise<void>;
    },
    fileExists: async (remotePath) => {
      return resolveClient(args, (client) => {
        return new Promise((resolve) => {
          client.exec(`[ -f "${remotePath}" ] && echo "exists"`, (err, channel) => {
            if (err) return resolve(false);
            let out = "";
            channel.on("data", (d: Buffer) => out += d.toString());
            channel.on("close", () => resolve(out.trim() === "exists"));
          });
        });
      }) as Promise<boolean>;
    },
    getArch: async () => {
      const result = await resolveClient(args, (client) => execQuickCommand(client, "uname -m")) as any;
      const arch = result.stdout.trim();
      return arch || (os.arch() === "x64" ? "x86_64" : os.arch());
    }
  };
}

/** 
 * Wraps kubectl commands with custom path and KUBECONFIG if provided in session.
 * If not provided, it injects a smart auto-discovery script to handle kubeadm, k3s, microk8s, etc.
 */
function wrapKubectl(session: Session | undefined, baseCmd: string): string {
  const customKubectl = session?.kubectlPath;
  const customConfig = session?.kubeconfig;
  
  if (session?.type === "k8s") {
    // For local k8s sessions, KUBECONFIG is already set in the env
    return baseCmd;
  }

  let script = "";

  // 1. Setup KUBECONFIG
  if (customConfig) {
    script += `export KUBECONFIG="${customConfig}";\n`;
  } else {
    // Smart auto-discovery for kubeconfig
    script += `
if [ -z "$KUBECONFIG" ]; then
  if [ -f ~/.kube/config ]; then export KUBECONFIG=~/.kube/config
  elif [ -f /etc/kubernetes/admin.conf ]; then export KUBECONFIG=/etc/kubernetes/admin.conf
  elif [ -f /etc/rancher/k3s/k3s.yaml ]; then export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  elif [ -f /var/lib/microk8s/credentials/client.config ]; then export KUBECONFIG=/var/lib/microk8s/credentials/client.config
  fi
fi
`;
  }

  // 2. Setup Kubectl binary
  let cmd = baseCmd;
  if (customKubectl) {
    cmd = cmd.replace(/\bkubectl\b/g, customKubectl);
  } else {
    // Smart auto-discovery for kubectl binary
    script += `
KCMD="kubectl"
if ! command -v kubectl >/dev/null 2>&1; then
  if [ -x /usr/local/bin/kubectl ]; then KCMD="/usr/local/bin/kubectl"
  elif [ -x /snap/bin/kubectl ]; then KCMD="/snap/bin/kubectl"
  elif command -v k3s >/dev/null 2>&1; then KCMD="k3s kubectl"
  elif command -v microk8s >/dev/null 2>&1; then KCMD="microk8s kubectl"
  fi
fi
`;
    // Replace kubectl with $KCMD (no quotes to allow word splitting for "k3s kubectl")
    cmd = cmd.replace(/\bkubectl\b/g, '$KCMD');
  }

  return script + cmd;
}

// ======== Handlers ========

export async function handleK8sListPods(args: any): Promise<ToolResult> {
  const namespace = args.namespace ? `-n ${args.namespace}` : "--all-namespaces";
  const baseCmd = `kubectl get pods ${namespace} -o wide`;
  
  const executor = await getExecutor(args);
  const cmd = wrapKubectl(executor.session, baseCmd);
  const result = await executor.exec(cmd, args.timeout ?? 30000);

  const contents = [{ type: "text" as const, text: result.stdout || "(no pods found)" }];
  if (result.stderr) {
    contents.push({ type: "text" as const, text: `STDERR:\n${result.stderr}` });
  }
  return { content: contents, isError: result.exitCode !== 0 };
}

export async function handleK8sPodLogs(args: any): Promise<ToolResult> {
  const containerOpt = args.container ? `-c ${args.container}` : "";
  const tailOpt = args.tail !== undefined ? `--tail=${args.tail}` : "--tail=100";
  const baseCmd = `kubectl logs ${args.pod} -n ${args.namespace} ${containerOpt} ${tailOpt}`;
  
  const executor = await getExecutor(args);
  const cmd = wrapKubectl(executor.session, baseCmd);
  const result = await executor.exec(cmd, args.timeout ?? 60000);

  const contents = [{ type: "text" as const, text: result.stdout || "(no logs output)" }];
  if (result.stderr) {
    contents.push({ type: "text" as const, text: `STDERR:\n${result.stderr}` });
  }
  return { content: contents, isError: result.exitCode !== 0 };
}

export async function handleK8sPodExec(args: any): Promise<ToolResult> {
  const containerOpt = args.container ? `-c ${args.container}` : "";
  const baseCmd = `kubectl exec -n ${args.namespace} ${args.pod} ${containerOpt} -- ${args.command}`;
  
  const executor = await getExecutor(args);
  const cmd = wrapKubectl(executor.session, baseCmd);
  const result = await executor.exec(cmd, args.timeout ?? 60000);

  const contents = [{ type: "text" as const, text: result.stdout || "(no command output)" }];
  if (result.stderr) {
    contents.push({ type: "text" as const, text: `STDERR:\n${result.stderr}` });
  }
  return { content: contents, isError: result.exitCode !== 0 };
}

export async function handleK8sPodCp(args: any): Promise<ToolResult> {
  const containerOpt = args.container ? `-c ${args.container}` : "";
  let baseCmd = "";
  if (args.direction === "to_pod") {
    baseCmd = `kubectl cp ${args.hostPath} ${args.namespace}/${args.pod}:${args.podPath} ${containerOpt}`;
  } else {
    baseCmd = `kubectl cp ${args.namespace}/${args.pod}:${args.podPath} ${args.hostPath} ${containerOpt}`;
  }

  const executor = await getExecutor(args);
  const cmd = wrapKubectl(executor.session, baseCmd);
  const result = await executor.exec(cmd, args.timeout ?? 120000); // Copy can be slow

  const contents = [{ 
    type: "text" as const, 
    text: result.exitCode === 0 ? "File copy completed successfully." : `File copy failed. Exit code: ${result.exitCode}` 
  }];
  if (result.stdout) {
    contents.push({ type: "text" as const, text: `STDOUT:\n${result.stdout}` });
  }
  if (result.stderr) {
    contents.push({ type: "text" as const, text: `STDERR:\n${result.stderr}` });
  }
  return { content: contents, isError: result.exitCode !== 0 };
}

export async function handleK8sArthasAttach(args: SshK8sArthasAttachArgs): Promise<ToolResult> {
  const { command, namespace, pod, container, pid, arthasVersion, jdkVersion } = args;
  const executor = await getExecutor(args);
  const session = executor.session;

  // Built-in Assets Strategy (Offline)
  const assetsDir = path.join(process.cwd(), "assets");
  const localArthasJar = path.join(assetsDir, "arthas", arthasVersion || "", "arthas-boot.jar");
  const useBuiltinArthas = fs.existsSync(localArthasJar);
  
  // Detect target architecture (Pod or Host)
  const arch = await executor.getArch();
  
  const jdkName = jdkVersion ? `jdk-${jdkVersion}-${arch}` : `jdk-8-${arch}`;
  const localJdkTar = path.join(assetsDir, "jdk", `${jdkName}.tar.gz`);
  const useBuiltinJdk = fs.existsSync(localJdkTar);

  const remoteBase = (executor.type === "k8s" && isWindows) 
    ? path.join(os.tmpdir(), "mcp_assets")
    : "/tmp/mcp_assets";
    
  const remoteArthasJar = useBuiltinArthas 
    ? (executor.type === "k8s" && isWindows ? path.join(remoteBase, "arthas", arthasVersion || "default", "arthas-boot.jar") : `${remoteBase}/arthas/${arthasVersion || "default"}/arthas-boot.jar`)
    : (executor.type === "k8s" && isWindows ? path.join(os.tmpdir(), "arthas-boot.jar") : "/tmp/arthas-boot.jar");
  
  const remoteJdkTar = (executor.type === "k8s" && isWindows)
    ? path.join(remoteBase, "jdk", `${jdkName}.tar.gz`)
    : `${remoteBase}/jdk/${jdkName}.tar.gz`;
    
  const remoteJdkDir = (executor.type === "k8s" && isWindows)
    ? path.join(remoteBase, "jdk", jdkName)
    : `${remoteBase}/jdk/${jdkName}`;

  // 1. Ensure jump host environment
  if (executor.type === "k8s" && isWindows) {
    fs.mkdirSync(path.join(remoteBase, "arthas"), { recursive: true });
    fs.mkdirSync(path.join(remoteBase, "jdk"), { recursive: true });
  } else {
    await executor.exec(`mkdir -p ${remoteBase}/arthas ${remoteBase}/jdk`);
  }

  // 2. Upload assets to jump host if missing
  if (useBuiltinArthas && !(await executor.fileExists(remoteArthasJar))) {
    await executor.uploadFile(localArthasJar, remoteArthasJar);
  }
  
  if (useBuiltinJdk && !(await executor.fileExists(remoteJdkTar))) {
    await executor.uploadFile(localJdkTar, remoteJdkTar);
    // Unpack JDK on jump host
    if (executor.type === "k8s" && isWindows) {
      // We don't necessarily need to unpack JDK on Windows if we're just copying it to a Pod
      // But if we need it for host execution, we'd need a Windows tar or similar
    } else {
      await executor.exec(`mkdir -p ${remoteJdkDir} && tar -xzf ${remoteJdkTar} -C ${remoteJdkDir} --strip-components=1`);
    }
  }

  let script = "";
  const javaCmd = useBuiltinJdk ? `${remoteJdkDir}/bin/java` : "java";

  if (pod && namespace) {
    const containerOpt = container ? `-c ${container}` : "";
    
    // Use wrapKubectl to transform the CP and EXEC commands
    // Note: kubectl cp on Windows might need careful path handling, but usually works with forward slashes or escaped backslashes
    const cpArthasCmd = wrapKubectl(session, `kubectl cp "${remoteArthasJar}" ${namespace}/${pod}:/tmp/arthas-boot.jar ${containerOpt}`);
    const cpFallbackCmd = wrapKubectl(session, `kubectl cp /tmp/arthas-boot.jar ${namespace}/${pod}:/tmp/arthas-boot.jar ${containerOpt}`);
    const cpJdkCmd = wrapKubectl(session, `kubectl cp "${remoteJdkTar}" ${namespace}/${pod}:/tmp/jdk.tar.gz ${containerOpt}`);
    const execTarCmd = wrapKubectl(session, `kubectl exec -n ${namespace} ${pod} ${containerOpt} -- sh -c "mkdir -p /tmp/jdk && tar -xzf /tmp/jdk.tar.gz -C /tmp/jdk --strip-components=1"`);
    const execJpsCmd = wrapKubectl(session, `kubectl exec -n ${namespace} ${pod} ${containerOpt} -- sh -c "jps 2>/dev/null | grep -v Jps | awk '{print \\$1}' | head -1"`);
    const execPsCmd = wrapKubectl(session, `kubectl exec -n ${namespace} ${pod} ${containerOpt} -- sh -c "ps -ef | grep java | grep -v grep | awk '{print \\$2}' | head -1"`);
    const execArthasCmd = wrapKubectl(session, `kubectl exec -n ${namespace} ${pod} ${containerOpt} -- \$JAVA_EXEC -jar /tmp/arthas-boot.jar \$TARGET_PID --exec "${command.replace(/"/g, '\\"')}"`);

    // If local executor is Windows, we can't run a .sh script on the host.
    // Instead, we'll execute these steps one-by-one or use a more clever approach.
    if (executor.type === "k8s" && isWindows) {
      const steps = [];
      if (useBuiltinArthas) {
        steps.push(cpArthasCmd);
      } else {
        steps.push(wrapKubectl(session, `kubectl exec -n ${namespace} ${pod} ${containerOpt} -- sh -c "curl -sL https://arthas.aliyun.com/arthas-boot.jar -o /tmp/arthas-boot.jar || wget -q https://arthas.aliyun.com/arthas-boot.jar -O /tmp/arthas-boot.jar"`));
      }
      if (useBuiltinJdk) {
        steps.push(cpJdkCmd);
        steps.push(execTarCmd);
      }
      
      let finalStdout = "";
      let finalStderr = "";
      
      for (const step of steps) {
        const r = await executor.exec(step);
        finalStdout += r.stdout;
        finalStderr += r.stderr;
        if (r.exitCode !== 0) return { content: [{ type: "text", text: `Step failed: ${step}\n${r.stderr}` }], isError: true };
      }
      
      // Resolve PID
      let targetPid = pid ? String(pid) : "";
      if (!targetPid) {
        const jpsRes = await executor.exec(execJpsCmd);
        targetPid = jpsRes.stdout.trim();
        if (!targetPid) {
          const psRes = await executor.exec(execPsCmd);
          targetPid = psRes.stdout.trim();
        }
      }
      
      if (!targetPid) return { content: [{ type: "text", text: "Error: No Java process found in Pod." }], isError: true };
      
      // Run Arthas
      const javaExec = useBuiltinJdk ? "/tmp/jdk/bin/java" : "java";
      const finalArthasCmd = execArthasCmd.replace(/\$JAVA_EXEC/g, javaExec).replace(/\$TARGET_PID/g, targetPid);
      const arthasRes = await executor.exec(finalArthasCmd, args.timeout ?? 300000);
      
      const contents = [{ type: "text" as const, text: (finalStdout + arthasRes.stdout) || "(no arthas output)" }];
      if (finalStderr || arthasRes.stderr) {
        contents.push({ type: "text" as const, text: `STDERR:\n${finalStderr}${arthasRes.stderr}` });
      }
      return { content: contents, isError: arthasRes.exitCode !== 0 };
    }

    // Default Linux sh script logic (for SSH or Linux-hosted MCP)
    script = `
# 1. Prepare Arthas in Pod
if [ "${useBuiltinArthas}" = "true" ]; then
  echo "Uploading builtin Arthas to Pod..."
  ${cpArthasCmd}
else
  if [ ! -f /tmp/arthas-boot.jar ]; then
    echo "Downloading arthas-boot.jar on host..."
    curl -sL https://arthas.aliyun.com/arthas-boot.jar -o /tmp/arthas-boot.jar || wget -q https://arthas.aliyun.com/arthas-boot.jar -O /tmp/arthas-boot.jar
  fi
  ${cpFallbackCmd}
fi

# 2. Prepare JDK in Pod if needed
if [ "${useBuiltinJdk}" = "true" ]; then
  echo "Uploading full JDK to Pod..."
  ${cpJdkCmd}
  ${execTarCmd}
fi

# 3. Resolve target PID in Pod
TARGET_PID="${pid || ""}"
if [ -z "$TARGET_PID" ]; then
  echo "Auto detecting Java PID in Pod..."
  TARGET_PID=$(${execJpsCmd})
  if [ -z "$TARGET_PID" ]; then
    TARGET_PID=$(${execPsCmd})
  fi
fi

if [ -z "$TARGET_PID" ]; then
  echo "Error: No Java process found in Pod."
  exit 1
fi

echo "Running Arthas command against PID: $TARGET_PID in Pod..."
JAVA_EXEC="java"
if [ "${useBuiltinJdk}" = "true" ]; then JAVA_EXEC="/tmp/jdk/bin/java"; fi
${execArthasCmd}
`;
  } else {
    // Run on host (Not supported for Windows local host yet, usually meant for remote Linux host)
    if (executor.type === "k8s" && isWindows) {
      return { content: [{ type: "text", text: "Error: Arthas attach on a Windows host is not yet supported in local mode." }], isError: true };
    }

    script = `
# 1. Prepare Arthas
if [ "${useBuiltinArthas}" = "false" ] && [ ! -f /tmp/arthas-boot.jar ]; then
  echo "Downloading arthas-boot.jar..."
  curl -sL https://arthas.aliyun.com/arthas-boot.jar -o /tmp/arthas-boot.jar || wget -q https://arthas.aliyun.com/arthas-boot.jar -O /tmp/arthas-boot.jar
fi

# 2. Resolve target PID on host
TARGET_PID="${pid || ""}"
if [ -z "$TARGET_PID" ]; then
  echo "Auto detecting Java PID on host..."
  TARGET_PID=$(jps 2>/dev/null | grep -v Jps | awk '{print $1}' | head -1)
  if [ -z "$TARGET_PID" ]; then
    TARGET_PID=$(ps -ef | grep java | grep -v grep | awk '{print $2}' | head -1)
  fi
fi

if [ -z "$TARGET_PID" ]; then
  echo "Error: No Java process found on host."
  exit 1
fi

echo "Running Arthas command against PID: $TARGET_PID on host..."
${javaCmd} -jar ${useBuiltinArthas ? remoteArthasJar : "/tmp/arthas-boot.jar"} $TARGET_PID --exec "${command.replace(/"/g, '\\"')}"
`;
  }

  const scriptName = `/tmp/.mcp_arthas_${Date.now()}.sh`;
  const runCmd = `cat > ${scriptName} << 'MCP_SCRIPT_EOF'\n${script}\nMCP_SCRIPT_EOF\nchmod +x ${scriptName} && ${scriptName}; rm -f ${scriptName}`;
  
  const result = await executor.exec(runCmd, args.timeout ?? 300000);

  const contents = [{ type: "text" as const, text: result.stdout || "(no arthas output)" }];
  if (result.stderr) {
    contents.push({ type: "text" as const, text: `STDERR:\n${result.stderr}` });
  }
  return { content: contents, isError: result.exitCode !== 0 };
}
