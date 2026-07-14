const fs = require('fs');
let code = fs.readFileSync('src/index.ts', 'utf-8');

const missingHeader = `server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ======== Session Management ========
    {
      name: "ssh_connect",
      description: "Create a persistent SSH session or reconnect to an existing one. To reconnect seamlessly, simply pass ONLY the 'sessionId' (credentials will be automatically restored from the saved session). Returns a sessionId that can be reused by other tools.",
      inputSchema: {
        type: "object",
        properties: {`;

code = code.replace(`        type: "object",\n        properties: {`, missingHeader);
fs.writeFileSync('src/index.ts', code);
