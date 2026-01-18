/**
 * Claude Code Cache Interceptor
 *
 * Intercepts Claude Code's file I/O operations and redirects them through
 * an optimized SQLite-backed storage layer using sql.js.
 *
 * Usage:
 *   NODE_OPTIONS="--require /path/to/interceptor.js" claude
 *
 * Or via wrapper script:
 *   claude-optimized (which sets NODE_OPTIONS and runs claude)
 */

import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database } from 'sql.js';

// Configuration
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || '', '.claude', 'projects');
const INTERCEPTOR_DB_PATH = path.join(process.env.HOME || '', '.claude-flow', 'cache-interceptor.db');
const INTERCEPT_PATTERNS = [
  /\.claude\/projects\/.*\.jsonl$/,
  /\.claude\/history\.jsonl$/,
];

// State
let db: Database | null = null;
let initialized = false;

// Original fs functions (before patching)
const originalFs = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  appendFileSync: fs.appendFileSync,
  existsSync: fs.existsSync,
  statSync: fs.statSync,
  readdirSync: fs.readdirSync,
};

/**
 * Check if a path should be intercepted
 */
function shouldIntercept(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  return INTERCEPT_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Initialize the SQLite database
 */
async function initDatabase(): Promise<void> {
  if (initialized) return;

  const SQL = await initSqlJs();

  // Try to load existing database
  try {
    const existingData = originalFs.readFileSync(INTERCEPTOR_DB_PATH);
    db = new SQL.Database(existingData);
  } catch {
    db = new SQL.Database();
  }

  // Create schema
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      type TEXT,
      content TEXT NOT NULL,
      timestamp TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      -- Optimization: index for fast lookups
      UNIQUE(session_id, line_number)
    );

    CREATE INDEX IF NOT EXISTS idx_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_type ON messages(type);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    -- Compressed summaries for compacted conversations
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      original_size INTEGER,
      compressed_size INTEGER,
      patterns_preserved TEXT, -- JSON array of preserved patterns
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Pattern cache for quick retrieval
    CREATE TABLE IF NOT EXISTS patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_type TEXT NOT NULL,
      pattern_key TEXT NOT NULL,
      pattern_value TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      usage_count INTEGER DEFAULT 0,
      last_used TEXT,
      UNIQUE(pattern_type, pattern_key)
    );

    CREATE INDEX IF NOT EXISTS idx_patterns ON patterns(pattern_type, confidence DESC);
  `);

  initialized = true;
  console.error('[CacheInterceptor] Database initialized');
}

/**
 * Parse session ID from file path
 */
function parseSessionId(filePath: string): string | null {
  const match = filePath.match(/([a-f0-9-]{36})\.jsonl$/);
  return match ? match[1] : null;
}

/**
 * Intercepted readFileSync
 */
function interceptedReadFileSync(
  filePath: fs.PathOrFileDescriptor,
  options?: { encoding?: BufferEncoding; flag?: string } | BufferEncoding
): string | Buffer {
  const pathStr = filePath.toString();

  if (!shouldIntercept(pathStr)) {
    return originalFs.readFileSync(filePath, options as any);
  }

  const sessionId = parseSessionId(pathStr);
  if (!sessionId || !db) {
    return originalFs.readFileSync(filePath, options as any);
  }

  try {
    // Read from SQLite instead of file
    const stmt = db.prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY line_number');
    stmt.bind([sessionId]);

    const lines: string[] = [];
    while (stmt.step()) {
      lines.push(stmt.get()[0] as string);
    }
    stmt.free();

    if (lines.length === 0) {
      // Fall back to original file if DB is empty
      return originalFs.readFileSync(filePath, options as any);
    }

    const content = lines.join('\n') + '\n';

    if (options === 'utf8' || (typeof options === 'object' && options?.encoding === 'utf8')) {
      return content;
    }
    return Buffer.from(content);

  } catch (error) {
    // Fall back to original on error
    return originalFs.readFileSync(filePath, options as any);
  }
}

/**
 * Intercepted appendFileSync (main write path for Claude Code)
 */
function interceptedAppendFileSync(
  filePath: fs.PathOrFileDescriptor,
  data: string | Uint8Array,
  options?: fs.WriteFileOptions
): void {
  const pathStr = filePath.toString();

  // Always write to original file for compatibility
  originalFs.appendFileSync(filePath, data, options);

  if (!shouldIntercept(pathStr) || !db) {
    return;
  }

  const sessionId = parseSessionId(pathStr);
  if (!sessionId) return;

  try {
    const content = data.toString();
    const lines = content.split('\n').filter(line => line.trim());

    // Get current max line number
    const maxLine = db.exec(`SELECT MAX(line_number) FROM messages WHERE session_id = ?`, [sessionId]);
    let lineNumber = (maxLine[0]?.values[0]?.[0] as number) || 0;

    for (const line of lines) {
      lineNumber++;

      // Parse message type and timestamp
      let type = 'unknown';
      let timestamp = null;
      try {
        const parsed = JSON.parse(line);
        type = parsed.type || 'unknown';
        timestamp = parsed.timestamp || null;
      } catch {}

      db.run(
        `INSERT OR REPLACE INTO messages (session_id, line_number, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`,
        [sessionId, lineNumber, type, line, timestamp]
      );

      // Extract and cache patterns from summaries
      if (type === 'summary') {
        try {
          const parsed = JSON.parse(line);
          if (parsed.summary) {
            db.run(
              `INSERT INTO summaries (session_id, summary, original_size) VALUES (?, ?, ?)`,
              [sessionId, parsed.summary, content.length]
            );
          }
        } catch {}
      }
    }

    // Persist database periodically
    persistDatabase();

  } catch (error) {
    console.error('[CacheInterceptor] Error storing message:', error);
  }
}

/**
 * Persist database to disk
 */
let persistTimeout: NodeJS.Timeout | null = null;
function persistDatabase(): void {
  if (persistTimeout) return;

  persistTimeout = setTimeout(() => {
    if (db) {
      try {
        const data = db.export();
        const dir = path.dirname(INTERCEPTOR_DB_PATH);
        if (!originalFs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        originalFs.writeFileSync(INTERCEPTOR_DB_PATH, Buffer.from(data));
      } catch (error) {
        console.error('[CacheInterceptor] Error persisting database:', error);
      }
    }
    persistTimeout = null;
  }, 1000);
}

/**
 * Query API for external access
 */
export const CacheQuery = {
  /**
   * Get all messages for a session
   */
  getSession(sessionId: string): any[] {
    if (!db) return [];
    const stmt = db.prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY line_number');
    stmt.bind([sessionId]);
    const results: any[] = [];
    while (stmt.step()) {
      try {
        results.push(JSON.parse(stmt.get()[0] as string));
      } catch {}
    }
    stmt.free();
    return results;
  },

  /**
   * Get all summaries (compacted content)
   */
  getSummaries(sessionId?: string): any[] {
    if (!db) return [];
    const query = sessionId
      ? 'SELECT * FROM summaries WHERE session_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM summaries ORDER BY created_at DESC';
    return db.exec(query, sessionId ? [sessionId] : [])[0]?.values || [];
  },

  /**
   * Get cached patterns
   */
  getPatterns(type?: string, minConfidence = 0.5): any[] {
    if (!db) return [];
    const query = type
      ? 'SELECT * FROM patterns WHERE pattern_type = ? AND confidence >= ? ORDER BY confidence DESC'
      : 'SELECT * FROM patterns WHERE confidence >= ? ORDER BY confidence DESC';
    return db.exec(query, type ? [type, minConfidence] : [minConfidence])[0]?.values || [];
  },

  /**
   * Store a learned pattern
   */
  storePattern(type: string, key: string, value: string, confidence = 0.5): void {
    if (!db) return;
    db.run(
      `INSERT OR REPLACE INTO patterns (pattern_type, pattern_key, pattern_value, confidence, usage_count, last_used)
       VALUES (?, ?, ?, ?, COALESCE((SELECT usage_count + 1 FROM patterns WHERE pattern_type = ? AND pattern_key = ?), 1), datetime('now'))`,
      [type, key, value, confidence, type, key]
    );
    persistDatabase();
  },

  /**
   * Get optimized context for injection
   */
  getOptimizedContext(maxTokens = 4000): string {
    if (!db) return '';

    // Get high-confidence patterns
    const patterns = db.exec(
      'SELECT pattern_type, pattern_key, pattern_value FROM patterns WHERE confidence >= 0.7 ORDER BY confidence DESC LIMIT 20'
    )[0]?.values || [];

    // Get recent summaries
    const summaries = db.exec(
      'SELECT summary FROM summaries ORDER BY created_at DESC LIMIT 5'
    )[0]?.values || [];

    let context = '## Learned Patterns\n';
    for (const [type, key, value] of patterns) {
      context += `- ${type}: ${key} → ${value}\n`;
    }

    context += '\n## Recent Context\n';
    for (const [summary] of summaries) {
      context += `${summary}\n\n`;
    }

    return context.slice(0, maxTokens * 4); // Rough char-to-token ratio
  }
};

/**
 * Install the interceptor
 */
export async function install(): Promise<void> {
  await initDatabase();

  // Patch fs module
  (fs as any).readFileSync = interceptedReadFileSync;
  (fs as any).appendFileSync = interceptedAppendFileSync;

  console.error('[CacheInterceptor] ✓ Installed - intercepting Claude Code cache operations');
}

/**
 * Auto-install if loaded via --require
 */
if (require.main !== module) {
  install().catch(console.error);
}
