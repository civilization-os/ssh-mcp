import { spawn } from 'child_process';
import path from 'path';

const serverPath = path.resolve('build/index.js');

function startInstance(id) {
  console.log(`[Test] Starting Instance ${id}...`);
  const proc = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  
  let stdoutData = '';
  let stderrData = '';
  
  proc.stdout.on('data', (d) => {
    stdoutData += d.toString();
  });
  
  proc.stderr.on('data', (d) => {
    stderrData += d.toString();
    console.log(`[Instance ${id} STDERR]: ${d.toString().trim()}`);
  });
  
  const sendRequest = (method, params = {}) => {
    const req = { jsonrpc: '2.0', id: Math.floor(Math.random() * 10000), method, params };
    proc.stdin.write(JSON.stringify(req) + '\n');
  };
  
  return { proc, sendRequest, getStdout: () => stdoutData, getStderr: () => stderrData };
}

async function runTest() {
  console.log('=== STARTING INDEPENDENT INSTANCES TEST ===');
  
  const inst1 = startInstance(1);
  const inst2 = startInstance(2);
  
  // Wait 3 seconds for servers to start and listen
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('\n[Test] Sending initialize handshakes...');
  inst1.sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client-1', version: '1.0.0' }
  });
  
  inst2.sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client-2', version: '1.0.0' }
  });
  
  // Wait for response processing
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const out1 = inst1.getStdout();
  const out2 = inst2.getStdout();
  
  console.log('\n[Test] Checking initialization responses...');
  
  let success = true;
  
  if (out1.includes('initialize') || out1.includes('capabilities') || out1.includes('protocolVersion')) {
    console.log('✅ Instance 1 initialized successfully via stdio.');
  } else {
    console.error('❌ Instance 1 failed to initialize. Output:', out1);
    success = false;
  }
  
  if (out2.includes('initialize') || out2.includes('capabilities') || out2.includes('protocolVersion')) {
    console.log('✅ Instance 2 initialized successfully via stdio.');
  } else {
    console.error('❌ Instance 2 failed to initialize. Output:', out2);
    success = false;
  }
  
  // Verify that ports are different
  const err1 = inst1.getStderr();
  const err2 = inst2.getStderr();
  
  const port1Match = err1.match(/Running at http:\/\/127\.0\.0\.1:(\d+)/);
  const port2Match = err2.match(/Running at http:\/\/127\.0\.0\.1:(\d+)/);
  
  if (port1Match && port2Match) {
    const port1 = port1Match[1];
    const port2 = port2Match[1];
    console.log(`\n[Test] Ports detected: Instance 1 = ${port1}, Instance 2 = ${port2}`);
    if (port1 !== port2) {
      console.log('✅ Success: Instances are listening on different ports.');
    } else {
      console.error('❌ Error: Both instances are listening on the same port!');
      success = false;
    }
  } else {
    console.error('❌ Error: Could not determine ports from stderr logs.');
    success = false;
  }
  
  // Cleanup processes
  console.log('\n[Test] Cleaning up processes...');
  inst1.proc.kill();
  inst2.proc.kill();
  
  if (success) {
    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } else {
    console.error('\n❌ TEST SUITE FAILED!');
    process.exit(1);
  }
}

runTest().catch(err => {
  console.error('Unhandled test error:', err);
  process.exit(1);
});
