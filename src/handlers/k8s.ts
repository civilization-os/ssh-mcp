import { Client } from "ssh2";
import { resolveClient, getSession } from "../session.js";
import { ToolResult, SshK8sArthasAttachArgs, Session } from "../types.js";
import fs from "fs";
import path from "path";

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
      
      const timer = setTimeout(() => {
        channel.close();
      }, timeoutMs);

      channel.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });
      channel.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });
      channel.on("exit", (code: number | null) => {
        exitCode = code;
      });
      channel.on("close", () => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode });
      });
    });
  });
}

function remoteFileExists(client: Client, remotePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    client.exec(`[ -f "${remotePath}" ] && echo "exists"`, (err, channel) => {
      if (err) return resolve(false);
      let out = "";
      channel.on("data", (d: Buffer) => out += d.toString());
      channel.on("close", () => resolve(out.trim() === "exists"));
    });
  });
}

function uploadFile(client: Client, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      
      const remoteDir = path.dirname(remotePath);
      client.exec(`mkdir -p "${remoteDir}"`, (mkdirErr, channel) => {
        if (mkdirErr) { sftp.end(); return reject(mkdirErr); }
        channel.on("close", () => {
          sftp.fastPut(localPath, remotePath, (putErr) => {
            sftp.end();
            if (putErr) reject(putErr);
            else resolve();
          });
        });
      });
    });
  });
}

/** 
 * Wraps kubectl commands with custom path and KUBECONFIG if provided in session.
 * If not provided, it injects a smart auto-discovery script to handle kubeadm, k3s, microk8s, etc.
 */
function wrapKubectl(session: Session | undefined, baseCmd: string): string {
  const customKubectl = session?.kubectlPath;
  const customConfig = session?.kubeconfig;
  
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
  
  const session = args.sessionId ? getSession(args.sessionId) : undefined;
  const cmd = wrapKubectl(session, baseCmd);
  
  const result = await resolveClient(args, (client) => {
    return execQuickCommand(client, cmd, args.timeout ?? 30000);
  }) as { stdout: string; stderr: string; exitCode: number | null };

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
  
  const session = args.sessionId ? getSession(args.sessionId) : undefined;
  const cmd = wrapKubectl(session, baseCmd);

  const result = await resolveClient(args, (client) => {
    return execQuickCommand(client, cmd, args.timeout ?? 60000);
  }) as { stdout: string; stderr: string; exitCode: number | null };

  const contents = [{ type: "text" as const, text: result.stdout || "(no logs output)" }];
  if (result.stderr) {
    contents.push({ type: "text" as const, text: `STDERR:\n${result.stderr}` });
  }
  return { content: contents, isError: result.exitCode !== 0 };
}

export async function handleK8sPodExec(args: any): Promise<ToolResult> {
  const containerOpt = args.container ? `-c ${args.container}` : "";
  const baseCmd = `kubectl exec -n ${args.namespace} ${args.pod} ${containerOpt} -- ${args.command}`;
  
  const session = args.sessionId ? getSession(args.sessionId) : undefined;
  const cmd = wrapKubectl(session, baseCmd);

  const result = await resolveClient(args, (client) => {
    return execQuickCommand(client, cmd, args.timeout ?? 60000);
  }) as { stdout: string; stderr: string; exitCode: number | null };

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

  const session = args.sessionId ? getSession(args.sessionId) : undefined;
  const cmd = wrapKubectl(session, baseCmd);

  const result = await resolveClient(args, (client) => {
    return execQuickCommand(client, cmd, args.timeout ?? 120000); // Copy can be slow
  }) as { stdout: string; stderr: string; exitCode: number | null };

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
  const session = args.sessionId ? getSession(args.sessionId) : undefined;

  // Built-in Assets Strategy (Offline)
  // 1. Check local assets/ directory for arthas-boot.jar and optional JDK
  // 2. Upload to jump host if missing
  // 3. For Pods: kubectl cp to target
  // 4. Execution: Use bundled JDK if provided

  const assetsDir = path.join(process.cwd(), "assets");
  const localArthasJar = path.join(assetsDir, "arthas", arthasVersion || "", "arthas-boot.jar");
  const useBuiltinArthas = fs.existsSync(localArthasJar);
  
  const result = await resolveClient(args, async (client) => {
    // Detect remote architecture
    const archInfo = await execQuickCommand(client, "uname -m");
    const arch = archInfo.stdout.trim() || "x86_64";
    
    const jdkName = jdkVersion ? `jdk-${jdkVersion}-${arch}` : `jdk-8-${arch}`;
    const localJdkTar = path.join(assetsDir, "jdk", `${jdkName}.tar.gz`);
    const useBuiltinJdk = fs.existsSync(localJdkTar);

    const remoteBase = "/tmp/mcp_assets";
    const remoteArthasJar = useBuiltinArthas 
      ? `${remoteBase}/arthas/${arthasVersion || "default"}/arthas-boot.jar`
      : "/tmp/arthas-boot.jar";
    const remoteJdkTar = `${remoteBase}/jdk/${jdkName}.tar.gz`;
    const remoteJdkDir = `${remoteBase}/jdk/${jdkName}`;

    // 1. Ensure remote environment
    await execQuickCommand(client, `mkdir -p ${remoteBase}/arthas ${remoteBase}/jdk`);

    // 2. Upload assets if missing
    if (useBuiltinArthas && !(await remoteFileExists(client, remoteArthasJar))) {
      await uploadFile(client, localArthasJar, remoteArthasJar);
    }
    
    if (useBuiltinJdk && !(await remoteFileExists(client, remoteJdkTar))) {
      await uploadFile(client, localJdkTar, remoteJdkTar);
      // Unpack JDK on jump host
      await execQuickCommand(client, `mkdir -p ${remoteJdkDir} && tar -xzf ${remoteJdkTar} -C ${remoteJdkDir} --strip-components=1`);
    }

    let script = "";
    const javaCmd = useBuiltinJdk ? `${remoteJdkDir}/bin/java` : "java";

    if (pod && namespace) {
      const containerOpt = container ? `-c ${container}` : "";
      
      // Use wrapKubectl to transform the CP and EXEC commands
      const cpArthasCmd = wrapKubectl(session, `kubectl cp ${remoteArthasJar} ${namespace}/${pod}:/tmp/arthas-boot.jar ${containerOpt}`);
      const cpFallbackCmd = wrapKubectl(session, `kubectl cp /tmp/arthas-boot.jar ${namespace}/${pod}:/tmp/arthas-boot.jar ${containerOpt}`);
      const cpJdkCmd = wrapKubectl(session, `kubectl cp ${remoteJdkTar} ${namespace}/${pod}:/tmp/jdk.tar.gz ${containerOpt}`);
      const execTarCmd = wrapKubectl(session, `kubectl exec -n ${namespace} ${pod} ${containerOpt} -- sh -c "mkdir -p /tmp/jdk && tar -xzf /tmp/jdk.tar.gz -C /tmp/jdk --strip-components=1"`);
      const execJpsCmd = wrapKubectl(session, `kubectl exec -n ${namespace} ${pod} ${containerOpt} -- sh -c "jps 2>/dev/null | grep -v Jps | awk '{print \\$1}' | head -1"`);
      const execPsCmd = wrapKubectl(session, `kubectl exec -n ${namespace} ${pod} ${containerOpt} -- sh -c "ps -ef | grep java | grep -v grep | awk '{print \\$2}' | head -1"`);
      const execArthasCmd = wrapKubectl(session, `kubectl exec -n ${namespace} ${pod} ${containerOpt} -- \$JAVA_EXEC -jar /tmp/arthas-boot.jar \$TARGET_PID --exec "${command.replace(/"/g, '\\"')}"`);

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
      // Run on host
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
    
    return execQuickCommand(client, runCmd, args.timeout ?? 300000);
  }) as { stdout: string; stderr: string; exitCode: number | null };

  const contents = [{ type: "text" as const, text: result.stdout || "(no arthas output)" }];
  if (result.stderr) {
    contents.push({ type: "text" as const, text: `STDERR:\n${result.stderr}` });
  }
  return { content: contents, isError: result.exitCode !== 0 };
}
