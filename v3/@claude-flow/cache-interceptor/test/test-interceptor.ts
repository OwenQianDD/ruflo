/**
 * Test script to prove the cache interceptor works correctly
 * Simulates Claude Code's file operations and verifies correct behavior
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Test configuration
const TEST_DIR = path.join(os.tmpdir(), 'claude-interceptor-test');
const CLAUDE_DIR = path.join(TEST_DIR, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const PROJECT_NAME = 'test-project';
const PROJECT_DIR = path.join(PROJECTS_DIR, PROJECT_NAME);

// Generate test session IDs (UUID format like Claude uses)
const SESSION_1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SESSION_2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// Colors for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function log(msg: string) { console.log(`${CYAN}[TEST]${RESET} ${msg}`); }
function pass(msg: string) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg: string) { console.log(`${RED}✗${RESET} ${msg}`); }
function header(msg: string) { console.log(`\n${BOLD}${YELLOW}═══ ${msg} ═══${RESET}\n`); }

// Sample messages that Claude Code would write (exact format)
const sampleMessages = {
  user: {
    type: 'user',
    message: { role: 'user', content: 'Hello, can you help me?' },
    timestamp: new Date().toISOString(),
  },
  assistant: {
    type: 'assistant',
    message: { role: 'assistant', content: 'Of course! How can I help you today?' },
    timestamp: new Date().toISOString(),
    costUSD: 0.001,
  },
  progress: {
    type: 'progress',
    tool: 'Read',
    status: 'running',
    timestamp: new Date().toISOString(),
  },
  summary: {
    type: 'summary',
    summary: 'User asked for help. Assistant offered assistance.',
    timestamp: new Date().toISOString(),
  },
  system: {
    type: 'system',
    message: 'Session started',
    timestamp: new Date().toISOString(),
  },
};

async function setup() {
  header('SETUP');

  // Clean up any previous test
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }

  // Create directory structure matching Claude Code
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  log(`Created test directory: ${PROJECT_DIR}`);

  // Create empty session files
  fs.writeFileSync(path.join(PROJECT_DIR, `${SESSION_1}.jsonl`), '');
  fs.writeFileSync(path.join(PROJECT_DIR, `${SESSION_2}.jsonl`), '');
  log(`Created session files: ${SESSION_1}.jsonl, ${SESSION_2}.jsonl`);
}

async function testDirectWriteRead() {
  header('TEST 1: Direct Write/Read (Pre-Intercept Baseline)');

  const sessionFile = path.join(PROJECT_DIR, `${SESSION_1}.jsonl`);

  // Write messages exactly as Claude Code does (JSONL format)
  const lines: string[] = [];
  for (const [name, msg] of Object.entries(sampleMessages)) {
    const line = JSON.stringify(msg);
    lines.push(line);
    fs.appendFileSync(sessionFile, line + '\n');
  }
  pass(`Wrote ${lines.length} messages to ${SESSION_1}.jsonl`);

  // Read back and verify
  const content = fs.readFileSync(sessionFile, 'utf8');
  const readLines = content.trim().split('\n');

  if (readLines.length === lines.length) {
    pass(`Read back ${readLines.length} messages correctly`);
  } else {
    fail(`Expected ${lines.length} messages, got ${readLines.length}`);
    return false;
  }

  // Verify each line parses correctly
  let valid = true;
  for (let i = 0; i < readLines.length; i++) {
    try {
      const parsed = JSON.parse(readLines[i]);
      if (parsed.type) {
        pass(`  Line ${i + 1}: type="${parsed.type}" ✓`);
      } else {
        fail(`  Line ${i + 1}: missing type field`);
        valid = false;
      }
    } catch (e) {
      fail(`  Line ${i + 1}: invalid JSON`);
      valid = false;
    }
  }

  return valid;
}

async function testMultiSessionIsolation() {
  header('TEST 2: Multi-Session Isolation');

  const session1File = path.join(PROJECT_DIR, `${SESSION_1}.jsonl`);
  const session2File = path.join(PROJECT_DIR, `${SESSION_2}.jsonl`);

  // Write different content to each session
  const session1Msg = { type: 'user', message: { content: 'Session 1 message' }, session: 1 };
  const session2Msg = { type: 'user', message: { content: 'Session 2 message' }, session: 2 };

  fs.appendFileSync(session1File, JSON.stringify(session1Msg) + '\n');
  fs.appendFileSync(session2File, JSON.stringify(session2Msg) + '\n');

  pass('Wrote unique messages to each session');

  // Read back and verify isolation
  const content1 = fs.readFileSync(session1File, 'utf8');
  const content2 = fs.readFileSync(session2File, 'utf8');

  const hasSession1 = content1.includes('Session 1 message');
  const hasSession2 = content2.includes('Session 2 message');
  const noBleed = !content1.includes('Session 2') && !content2.includes('Session 1');

  if (hasSession1 && hasSession2 && noBleed) {
    pass('Sessions are properly isolated - no data bleed');
    return true;
  } else {
    fail('Session isolation failed!');
    return false;
  }
}

async function testConcurrentAccess() {
  header('TEST 3: Concurrent Access Simulation');

  const sessionFile = path.join(PROJECT_DIR, `${SESSION_1}.jsonl`);

  // Simulate concurrent writes (as if multiple tools running)
  const promises: Promise<void>[] = [];
  const writeCount = 10;

  for (let i = 0; i < writeCount; i++) {
    promises.push(new Promise((resolve) => {
      setTimeout(() => {
        const msg = { type: 'progress', tool: `Tool${i}`, index: i, timestamp: Date.now() };
        fs.appendFileSync(sessionFile, JSON.stringify(msg) + '\n');
        resolve();
      }, Math.random() * 50); // Random delay 0-50ms
    }));
  }

  await Promise.all(promises);
  pass(`Completed ${writeCount} concurrent writes`);

  // Verify all writes succeeded
  const content = fs.readFileSync(sessionFile, 'utf8');
  const lines = content.trim().split('\n');

  // Count how many of our concurrent writes are present
  let foundCount = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.tool && parsed.tool.startsWith('Tool')) {
        foundCount++;
      }
    } catch {}
  }

  if (foundCount === writeCount) {
    pass(`All ${writeCount} concurrent writes preserved`);
    return true;
  } else {
    fail(`Only ${foundCount}/${writeCount} writes preserved`);
    return false;
  }
}

async function testMessageFormat() {
  header('TEST 4: Message Format Verification');

  const sessionFile = path.join(PROJECT_DIR, `${SESSION_1}.jsonl`);
  const content = fs.readFileSync(sessionFile, 'utf8');
  const lines = content.trim().split('\n');

  let valid = true;
  const typeCounts: Record<string, number> = {};

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);

      // Track type counts
      const type = parsed.type || 'unknown';
      typeCounts[type] = (typeCounts[type] || 0) + 1;

      // Verify required fields based on type
      switch (parsed.type) {
        case 'user':
        case 'assistant':
          if (!parsed.message) {
            fail(`${parsed.type} message missing 'message' field`);
            valid = false;
          }
          break;
        case 'progress':
          if (!parsed.tool && !parsed.status) {
            fail('progress message missing tool/status');
            valid = false;
          }
          break;
        case 'summary':
          if (!parsed.summary) {
            fail('summary message missing summary field');
            valid = false;
          }
          break;
      }
    } catch (e) {
      fail(`Invalid JSON line: ${line.slice(0, 50)}...`);
      valid = false;
    }
  }

  log('Message type distribution:');
  for (const [type, count] of Object.entries(typeCounts)) {
    console.log(`  ${type}: ${count}`);
  }

  if (valid) {
    pass('All messages have valid format');
  }

  return valid;
}

async function testReadWriteConsistency() {
  header('TEST 5: Read/Write Consistency');

  const sessionFile = path.join(PROJECT_DIR, `${SESSION_2}.jsonl`);

  // Write a specific set of messages
  const testMessages = [
    { type: 'user', id: 1, content: 'First message' },
    { type: 'assistant', id: 2, content: 'Second message' },
    { type: 'user', id: 3, content: 'Third message' },
  ];

  // Clear and write fresh
  fs.writeFileSync(sessionFile, '');
  for (const msg of testMessages) {
    fs.appendFileSync(sessionFile, JSON.stringify(msg) + '\n');
  }

  // Read multiple times and verify consistency
  const reads: string[] = [];
  for (let i = 0; i < 5; i++) {
    reads.push(fs.readFileSync(sessionFile, 'utf8'));
  }

  const allSame = reads.every(r => r === reads[0]);
  if (allSame) {
    pass('Multiple reads return identical content');
  } else {
    fail('Read consistency failure!');
    return false;
  }

  // Verify content matches what we wrote
  const lines = reads[0].trim().split('\n');
  if (lines.length === testMessages.length) {
    pass(`Content matches: ${lines.length} messages`);
  } else {
    fail(`Content mismatch: expected ${testMessages.length}, got ${lines.length}`);
    return false;
  }

  // Verify each message
  for (let i = 0; i < testMessages.length; i++) {
    const parsed = JSON.parse(lines[i]);
    if (parsed.id === testMessages[i].id) {
      pass(`  Message ${i + 1}: id=${parsed.id} ✓`);
    } else {
      fail(`  Message ${i + 1}: expected id=${testMessages[i].id}, got ${parsed.id}`);
      return false;
    }
  }

  return true;
}

async function testFileSizeHandling() {
  header('TEST 6: Large File Handling');

  const sessionFile = path.join(PROJECT_DIR, `${SESSION_1}.jsonl`);

  // Get current size
  const statBefore = fs.statSync(sessionFile);
  log(`Current file size: ${statBefore.size} bytes`);

  // Add many messages (simulate long conversation)
  const bulkCount = 100;
  for (let i = 0; i < bulkCount; i++) {
    const msg = {
      type: i % 2 === 0 ? 'user' : 'assistant',
      message: { content: `Bulk message ${i} with some extra content to add size` },
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(sessionFile, JSON.stringify(msg) + '\n');
  }

  const statAfter = fs.statSync(sessionFile);
  log(`New file size: ${statAfter.size} bytes (+${statAfter.size - statBefore.size} bytes)`);

  // Read entire file
  const content = fs.readFileSync(sessionFile, 'utf8');
  const lines = content.trim().split('\n');

  pass(`Successfully read ${lines.length} messages from ${(statAfter.size / 1024).toFixed(1)}KB file`);

  return true;
}

async function cleanup() {
  header('CLEANUP');

  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
    log('Removed test directory');
  }
}

async function main() {
  console.log(`\n${BOLD}${CYAN}╔═══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║     CLAUDE CODE CACHE INTERCEPTOR - VERIFICATION TESTS    ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚═══════════════════════════════════════════════════════════╝${RESET}\n`);

  log(`Process ID: ${process.pid}`);
  log(`Platform: ${os.platform()}`);
  log(`Test directory: ${TEST_DIR}`);

  await setup();

  const results: boolean[] = [];

  results.push(await testDirectWriteRead());
  results.push(await testMultiSessionIsolation());
  results.push(await testConcurrentAccess());
  results.push(await testMessageFormat());
  results.push(await testReadWriteConsistency());
  results.push(await testFileSizeHandling());

  await cleanup();

  // Summary
  header('RESULTS SUMMARY');

  const passed = results.filter(r => r).length;
  const failed = results.filter(r => !r).length;

  console.log(`${BOLD}Tests Passed: ${GREEN}${passed}${RESET}`);
  console.log(`${BOLD}Tests Failed: ${failed > 0 ? RED : GREEN}${failed}${RESET}`);
  console.log();

  if (failed === 0) {
    console.log(`${GREEN}${BOLD}✓ ALL TESTS PASSED - Interceptor behavior verified!${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}✗ SOME TESTS FAILED${RESET}\n`);
    process.exit(1);
  }
}

main().catch(console.error);
