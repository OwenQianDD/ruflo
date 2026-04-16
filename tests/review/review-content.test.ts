import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchReviewContent } from '../../v3/@claude-flow/cli/src/services/review-content.js';

describe('fetchReviewContent', () => {
  it('loads a local design doc file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-content-'));
    const filePath = path.join(dir, 'design.md');
    fs.writeFileSync(filePath, '# Checkout Design\n\nAdd staged rollouts.');

    try {
      const result = fetchReviewContent({
        source: 'local-file',
        input: filePath,
      });

      expect(result.target.kind).toBe('design-doc');
      expect(result.content.source).toBe('local-file');
      expect(result.content.documents).toHaveLength(1);
      expect(result.content.title).toBe('Checkout Design');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads slack messages from a JSON export', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-slack-'));
    const filePath = path.join(dir, 'thread.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        { user: 'alice', text: 'We should validate writes before rollout.' },
        { user: 'bob', text: 'Need better observability for the migration.' },
      ]),
    );

    try {
      const result = fetchReviewContent({
        source: 'slack',
        input: filePath,
      });

      expect(result.target.kind).toBe('design-doc');
      expect(result.content.source).toBe('slack');
      expect(result.content.body).toContain('alice');
      expect(result.content.body).toContain('observability');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
