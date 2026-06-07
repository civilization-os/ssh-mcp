import { Client } from "ssh2";
import { resolveClient } from "../session.js";
import { ToolResult } from "../types.js";

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

// ======== Handlers ========

export async function handleK8sListPods(args: any): Promise<ToolResult> {
  const namespace = args.namespace ? `-n ${args.namespace}` : "--all-namespaces";
  const cmd = `kubectl get pods ${namespace} -o wide`;
  
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
  const cmd = `kubectl logs ${args.pod} -n ${args.namespace} ${containerOpt} ${tailOpt}`;
  
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
  const cmd = `kubectl exec -n ${args.namespace} ${args.pod} ${containerOpt} -- ${args.command}`;
  
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
  let cmd = "";
  if (args.direction === "to_pod") {
    cmd = `kubectl cp ${args.hostPath} ${args.namespace}/${args.pod}:${args.podPath} ${containerOpt}`;
  } else {
    cmd = `kubectl cp ${args.namespace}/${args.pod}:${args.podPath} ${args.hostPath} ${containerOpt}`;
  }

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

export async function handleK8sArthasAttach(args: any): Promise<ToolResult> {
  const { command, namespace, pod, container, pid } = args;

  // Automate Arthas attach in Pod or Host
  // 1. Download arthas-boot.jar on jump host if not exists
  // 2. If it is a pod:
  //    - Copy arthas-boot.jar to /tmp/arthas-boot.jar inside Pod
  //    - Auto detect java PID in Pod if not specified
  //    - Execute arthas command and return output
  // 3. If it is host:
  //    - Auto detect java PID on host if not specified
  //    - Execute arthas command and return output

  let script = "";
  
  if (pod && namespace) {
    const containerOpt = container ? `-c ${container}` : "";
    script = `
# 1. Download arthas-boot.jar on host if not exists
if [ ! -f /tmp/arthas-boot.jar ]; then
  echo "Downloading arthas-boot.jar on host..."
  curl -sL https://arthas.aliyun.com/arthas-boot.jar -o /tmp/arthas-boot.jar || wget -q https://arthas.aliyun.com/arthas-boot.jar -O /tmp/arthas-boot.jar
fi

# 2. Copy to Pod
echo "Copying arthas-boot.jar to Pod..."
kubectl cp /tmp/arthas-boot.jar ${namespace}/${pod}:/tmp/arthas-boot.jar ${containerOpt}

# 3. Resolve target PID in Pod
TARGET_PID="${pid || ""}"
if [ -z "$TARGET_PID" ]; then
  echo "Auto detecting Java PID in Pod..."
  TARGET_PID=$(kubectl exec -n ${namespace} ${pod} ${containerOpt} -- sh -c "jps | grep -v Jps | awk '{print \\$1}' | head -1")
fi

if [ -z "$TARGET_PID" ]; then
  echo "Error: No Java process found in Pod."
  exit 1
fi

echo "Running Arthas command: \\"${command}\\" against PID: $TARGET_PID in Pod..."
kubectl exec -n ${namespace} ${pod} ${containerOpt} -- java -jar /tmp/arthas-boot.jar $TARGET_PID --exec "${command}"
`;
  } else {
    // Run on host
    script = `
# 1. Download arthas-boot.jar on host if not exists
if [ ! -f /tmp/arthas-boot.jar ]; then
  echo "Downloading arthas-boot.jar..."
  curl -sL https://arthas.aliyun.com/arthas-boot.jar -o /tmp/arthas-boot.jar || wget -q https://arthas.aliyun.com/arthas-boot.jar -O /tmp/arthas-boot.jar
fi

# 2. Resolve target PID on host
TARGET_PID="${pid || ""}"
if [ -z "$TARGET_PID" ]; then
  echo "Auto detecting Java PID on host..."
  TARGET_PID=$(jps | grep -v Jps | awk '{print $1}' | head -1)
fi

if [ -z "$TARGET_PID" ]; then
  echo "Error: No Java process found on host."
  exit 1
fi

echo "Running Arthas command: \\"${command}\\" against PID: $TARGET_PID on host..."
java -jar /tmp/arthas-boot.jar $TARGET_PID --exec "${command}"
`;
  }

  // Execute the shell helper script
  const scriptName = `/tmp/.mcp_arthas_${Date.now()}.sh`;
  const runCmd = `cat > ${scriptName} << 'MCP_SCRIPT_EOF'\n${script}\nMCP_SCRIPT_EOF\nchmod +x ${scriptName} && ${scriptName}; rm -f ${scriptName}`;

  const result = await resolveClient(args, (client) => {
    return execQuickCommand(client, runCmd, args.timeout ?? 180000); // Arthas attach can take time
  }) as { stdout: string; stderr: string; exitCode: number | null };

  const contents = [{ type: "text" as const, text: result.stdout || "(no arthas output)" }];
  if (result.stderr) {
    contents.push({ type: "text" as const, text: `STDERR:\n${result.stderr}` });
  }
  return { content: contents, isError: result.exitCode !== 0 };
}
