/**
 * Tests for PR Review Types — URL parsing and type validation
 */

import { describe, it, expect } from 'vitest';
import { parsePRUrl, DEFAULT_REVIEW_CONFIG } from '../../v3/@claude-flow/cli/src/services/review-types.js';
import type { PRIdentifier } from '../../v3/@claude-flow/cli/src/services/review-types.js';

describe('parsePRUrl', () => {
  it('parses a full GitHub PR URL', () => {
    const result = parsePRUrl('https://github.com/ruvnet/ruflo/pull/1354');
    expect(result).toEqual<PRIdentifier>({
      owner: 'ruvnet',
      repo: 'ruflo',
      number: 1354,
      url: 'https://github.com/ruvnet/ruflo/pull/1354',
    });
  });

  it('parses a full URL with trailing whitespace', () => {
    const result = parsePRUrl('  https://github.com/org/repo/pull/42  ');
    expect(result.owner).toBe('org');
    expect(result.repo).toBe('repo');
    expect(result.number).toBe(42);
  });

  it('parses owner/repo#number shorthand', () => {
    const result = parsePRUrl('myorg/myrepo#99');
    expect(result).toEqual<PRIdentifier>({
      owner: 'myorg',
      repo: 'myrepo',
      number: 99,
      url: 'https://github.com/myorg/myrepo/pull/99',
    });
  });

  it('parses owner/repo/number shorthand', () => {
    const result = parsePRUrl('acme/widget/7');
    expect(result).toEqual<PRIdentifier>({
      owner: 'acme',
      repo: 'widget',
      number: 7,
      url: 'https://github.com/acme/widget/pull/7',
    });
  });

  it('handles repo names with dots and hyphens', () => {
    const result = parsePRUrl('my-org/my.repo-name/123');
    expect(result.owner).toBe('my-org');
    expect(result.repo).toBe('my.repo-name');
    expect(result.number).toBe(123);
  });

  it('handles GitHub URL with www prefix', () => {
    const result = parsePRUrl('https://www.github.com/owner/repo/pull/5');
    // The regex matches github.com anywhere in the string
    expect(result.owner).toBe('owner');
    expect(result.repo).toBe('repo');
    expect(result.number).toBe(5);
  });

  it('throws on invalid input', () => {
    expect(() => parsePRUrl('not-a-url')).toThrow('Invalid PR identifier');
  });

  it('throws on empty string', () => {
    expect(() => parsePRUrl('')).toThrow('Invalid PR identifier');
  });

  it('throws on partial URL without PR number', () => {
    expect(() => parsePRUrl('https://github.com/owner/repo')).toThrow('Invalid PR identifier');
  });

  it('throws on owner/repo without number', () => {
    expect(() => parsePRUrl('owner/repo')).toThrow('Invalid PR identifier');
  });
});

describe('DEFAULT_REVIEW_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_REVIEW_CONFIG.maxDebateRounds).toBe(3);
    expect(DEFAULT_REVIEW_CONFIG.consensusThreshold).toBeCloseTo(2 / 3);
  });

  it('has all four provider specs', () => {
    const { providers } = DEFAULT_REVIEW_CONFIG;
    expect(providers.securityAuditor).toBeDefined();
    expect(providers.logicChecker).toBeDefined();
    expect(providers.integrationSpecialist).toBeDefined();
    expect(providers.queen).toBeDefined();
  });

  it('uses opus for security auditor', () => {
    expect(DEFAULT_REVIEW_CONFIG.providers.securityAuditor.model).toBe('opus');
  });
});
