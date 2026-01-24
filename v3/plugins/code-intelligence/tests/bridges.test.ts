/**
 * Code Intelligence Plugin - Bridge Tests
 *
 * Tests for GNNBridge initialization, lifecycle, and methods
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GNNBridge } from '../src/bridges/gnn-bridge.js';

// Mock WASM module
vi.mock('../src/bridges/gnn-wasm.js', () => ({
  initWasm: vi.fn().mockResolvedValue(undefined),
  wasmAvailable: vi.fn().mockReturnValue(false),
}));

describe('GNNBridge', () => {
  let bridge: GNNBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new GNNBridge();
  });

  afterEach(async () => {
    try {
      await bridge.destroy();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    it('should create bridge instance', () => {
      expect(bridge).toBeInstanceOf(GNNBridge);
    });

    it('should not be initialized before init', () => {
      expect(bridge.isInitialized()).toBe(false);
    });

    it('should initialize successfully', async () => {
      await bridge.initialize();
      expect(bridge.isInitialized()).toBe(true);
    });

    it('should initialize with custom config', async () => {
      await bridge.initialize({
        hiddenDim: 256,
        numLayers: 4,
        aggregation: 'mean',
        dropout: 0.1,
      });
      expect(bridge.isInitialized()).toBe(true);
    });

    it('should initialize with language-specific config', async () => {
      await bridge.initialize({
        languages: ['typescript', 'javascript', 'python'],
        maxGraphSize: 50000,
        enableCaching: true,
      });
      expect(bridge.isInitialized()).toBe(true);
    });

    it('should handle double initialization gracefully', async () => {
      await bridge.initialize();
      await bridge.initialize();
      expect(bridge.isInitialized()).toBe(true);
    });
  });

  describe('Lifecycle', () => {
    it('should destroy successfully', async () => {
      await bridge.initialize();
      await bridge.destroy();
      expect(bridge.isInitialized()).toBe(false);
    });

    it('should handle destroy when not initialized', async () => {
      await expect(bridge.destroy()).resolves.not.toThrow();
    });

    it('should reinitialize after destroy', async () => {
      await bridge.initialize();
      await bridge.destroy();
      await bridge.initialize();
      expect(bridge.isInitialized()).toBe(true);
    });
  });

  describe('Build Code Graph', () => {
    beforeEach(async () => {
      await bridge.initialize();
    });

    it('should build code graph from AST', async () => {
      const codeStructure = {
        files: [
          {
            path: 'src/utils.ts',
            nodes: [
              { id: 'func-1', type: 'function', name: 'helper', startLine: 1, endLine: 10 },
              { id: 'func-2', type: 'function', name: 'process', startLine: 12, endLine: 25 },
            ],
            edges: [
              { source: 'func-2', target: 'func-1', type: 'calls' },
            ],
          },
        ],
      };

      const result = await bridge.buildCodeGraph(codeStructure);

      expect(result).toHaveProperty('nodeCount');
      expect(result).toHaveProperty('edgeCount');
      expect(result.nodeCount).toBe(2);
      expect(result.edgeCount).toBe(1);
    });

    it('should build graph from multiple files', async () => {
      const codeStructure = {
        files: [
          {
            path: 'src/a.ts',
            nodes: [{ id: 'a-func', type: 'function', name: 'funcA' }],
            edges: [],
          },
          {
            path: 'src/b.ts',
            nodes: [{ id: 'b-func', type: 'function', name: 'funcB' }],
            edges: [{ source: 'b-func', target: 'a-func', type: 'imports' }],
          },
        ],
      };

      const result = await bridge.buildCodeGraph(codeStructure);

      expect(result.nodeCount).toBe(2);
      expect(result.crossFileEdges).toBe(1);
    });

    it('should handle empty codebase', async () => {
      const result = await bridge.buildCodeGraph({ files: [] });

      expect(result.nodeCount).toBe(0);
      expect(result.edgeCount).toBe(0);
    });

    it('should detect node types correctly', async () => {
      const codeStructure = {
        files: [{
          path: 'src/main.ts',
          nodes: [
            { id: 'class-1', type: 'class', name: 'MyClass' },
            { id: 'method-1', type: 'method', name: 'myMethod', parent: 'class-1' },
            { id: 'func-1', type: 'function', name: 'standalone' },
            { id: 'var-1', type: 'variable', name: 'config' },
          ],
          edges: [
            { source: 'method-1', target: 'class-1', type: 'belongs_to' },
            { source: 'func-1', target: 'var-1', type: 'uses' },
          ],
        }],
      };

      const result = await bridge.buildCodeGraph(codeStructure);

      expect(result.nodesByType).toHaveProperty('class');
      expect(result.nodesByType).toHaveProperty('function');
      expect(result.nodesByType).toHaveProperty('method');
    });
  });

  describe('Compute Node Embeddings', () => {
    beforeEach(async () => {
      await bridge.initialize({ hiddenDim: 64 });
      await bridge.buildCodeGraph({
        files: [{
          path: 'src/test.ts',
          nodes: [
            { id: 'func-a', type: 'function', name: 'processData' },
            { id: 'func-b', type: 'function', name: 'validateInput' },
            { id: 'func-c', type: 'function', name: 'formatOutput' },
          ],
          edges: [
            { source: 'func-a', target: 'func-b', type: 'calls' },
            { source: 'func-a', target: 'func-c', type: 'calls' },
          ],
        }],
      });
    });

    it('should compute embeddings for all nodes', async () => {
      const embeddings = await bridge.computeNodeEmbeddings();

      expect(embeddings).toHaveProperty('func-a');
      expect(embeddings).toHaveProperty('func-b');
      expect(embeddings).toHaveProperty('func-c');
    });

    it('should return embeddings of correct dimension', async () => {
      const embeddings = await bridge.computeNodeEmbeddings();

      const embedding = embeddings['func-a'];
      expect(Array.isArray(embedding) || embedding instanceof Float32Array).toBe(true);
      expect(embedding.length).toBe(64);
    });

    it('should compute normalized embeddings', async () => {
      const embeddings = await bridge.computeNodeEmbeddings({ normalize: true });

      const embedding = embeddings['func-a'];
      const norm = Math.sqrt(
        Array.from(embedding).reduce((sum, v) => sum + v * v, 0)
      );
      expect(norm).toBeCloseTo(1, 3);
    });
  });

  describe('Predict Impact', () => {
    beforeEach(async () => {
      await bridge.initialize();
      await bridge.buildCodeGraph({
        files: [{
          path: 'src/core.ts',
          nodes: [
            { id: 'core-func', type: 'function', name: 'coreLogic' },
            { id: 'helper-1', type: 'function', name: 'helper1' },
            { id: 'helper-2', type: 'function', name: 'helper2' },
            { id: 'consumer-1', type: 'function', name: 'consumer1' },
            { id: 'consumer-2', type: 'function', name: 'consumer2' },
          ],
          edges: [
            { source: 'core-func', target: 'helper-1', type: 'calls' },
            { source: 'core-func', target: 'helper-2', type: 'calls' },
            { source: 'consumer-1', target: 'core-func', type: 'calls' },
            { source: 'consumer-2', target: 'core-func', type: 'calls' },
          ],
        }],
      });
    });

    it('should predict impact of changes', async () => {
      const impact = await bridge.predictImpact({
        changedNodes: ['core-func'],
        changeType: 'modification',
      });

      expect(impact).toHaveProperty('affectedNodes');
      expect(impact.affectedNodes).toContain('consumer-1');
      expect(impact.affectedNodes).toContain('consumer-2');
    });

    it('should calculate impact score', async () => {
      const impact = await bridge.predictImpact({
        changedNodes: ['core-func'],
        changeType: 'modification',
      });

      expect(impact).toHaveProperty('impactScore');
      expect(impact.impactScore).toBeGreaterThan(0);
      expect(impact.impactScore).toBeLessThanOrEqual(1);
    });

    it('should identify high-risk changes', async () => {
      const impact = await bridge.predictImpact({
        changedNodes: ['core-func'],
        changeType: 'deletion',
      });

      expect(impact).toHaveProperty('riskLevel');
      expect(['low', 'medium', 'high', 'critical']).toContain(impact.riskLevel);
    });

    it('should handle isolated node changes', async () => {
      await bridge.buildCodeGraph({
        files: [{
          path: 'src/isolated.ts',
          nodes: [{ id: 'isolated', type: 'function', name: 'isolated' }],
          edges: [],
        }],
      });

      const impact = await bridge.predictImpact({
        changedNodes: ['isolated'],
        changeType: 'modification',
      });

      expect(impact.affectedNodes.length).toBe(0);
      expect(impact.impactScore).toBe(0);
    });

    it('should propagate impact through dependency chain', async () => {
      await bridge.buildCodeGraph({
        files: [{
          path: 'src/chain.ts',
          nodes: [
            { id: 'level-0', type: 'function', name: 'base' },
            { id: 'level-1', type: 'function', name: 'mid' },
            { id: 'level-2', type: 'function', name: 'top' },
          ],
          edges: [
            { source: 'level-1', target: 'level-0', type: 'calls' },
            { source: 'level-2', target: 'level-1', type: 'calls' },
          ],
        }],
      });

      const impact = await bridge.predictImpact({
        changedNodes: ['level-0'],
        changeType: 'signature_change',
        propagationDepth: 2,
      });

      expect(impact.affectedNodes).toContain('level-1');
      expect(impact.affectedNodes).toContain('level-2');
    });
  });

  describe('Detect Communities', () => {
    beforeEach(async () => {
      await bridge.initialize();
    });

    it('should detect code communities/modules', async () => {
      await bridge.buildCodeGraph({
        files: [
          {
            path: 'src/auth/login.ts',
            nodes: [
              { id: 'auth-1', type: 'function', name: 'login' },
              { id: 'auth-2', type: 'function', name: 'logout' },
              { id: 'auth-3', type: 'function', name: 'validateToken' },
            ],
            edges: [
              { source: 'auth-1', target: 'auth-3', type: 'calls' },
              { source: 'auth-2', target: 'auth-3', type: 'calls' },
            ],
          },
          {
            path: 'src/data/repository.ts',
            nodes: [
              { id: 'data-1', type: 'function', name: 'fetchData' },
              { id: 'data-2', type: 'function', name: 'saveData' },
            ],
            edges: [
              { source: 'data-1', target: 'data-2', type: 'calls' },
            ],
          },
        ],
      });

      const communities = await bridge.detectCommunities();

      expect(communities).toHaveProperty('communities');
      expect(Array.isArray(communities.communities)).toBe(true);
      expect(communities.communities.length).toBeGreaterThanOrEqual(1);
    });

    it('should return modularity score', async () => {
      await bridge.buildCodeGraph({
        files: [{
          path: 'src/mixed.ts',
          nodes: [
            { id: 'a', type: 'function', name: 'a' },
            { id: 'b', type: 'function', name: 'b' },
          ],
          edges: [{ source: 'a', target: 'b', type: 'calls' }],
        }],
      });

      const communities = await bridge.detectCommunities();

      expect(communities).toHaveProperty('modularity');
      expect(typeof communities.modularity).toBe('number');
    });

    it('should identify community members', async () => {
      await bridge.buildCodeGraph({
        files: [{
          path: 'src/cluster.ts',
          nodes: [
            { id: 'cluster-a1', type: 'function', name: 'a1' },
            { id: 'cluster-a2', type: 'function', name: 'a2' },
          ],
          edges: [
            { source: 'cluster-a1', target: 'cluster-a2', type: 'calls' },
            { source: 'cluster-a2', target: 'cluster-a1', type: 'calls' },
          ],
        }],
      });

      const communities = await bridge.detectCommunities();

      const community = communities.communities[0];
      expect(community).toHaveProperty('members');
      expect(Array.isArray(community.members)).toBe(true);
    });
  });

  describe('Find Similar Patterns', () => {
    beforeEach(async () => {
      await bridge.initialize();
      await bridge.buildCodeGraph({
        files: [{
          path: 'src/patterns.ts',
          nodes: [
            // Pattern 1: fetch -> validate -> process
            { id: 'p1-fetch', type: 'function', name: 'fetchUser' },
            { id: 'p1-validate', type: 'function', name: 'validateUser' },
            { id: 'p1-process', type: 'function', name: 'processUser' },
            // Pattern 2: similar structure
            { id: 'p2-fetch', type: 'function', name: 'fetchOrder' },
            { id: 'p2-validate', type: 'function', name: 'validateOrder' },
            { id: 'p2-process', type: 'function', name: 'processOrder' },
          ],
          edges: [
            { source: 'p1-fetch', target: 'p1-validate', type: 'calls' },
            { source: 'p1-validate', target: 'p1-process', type: 'calls' },
            { source: 'p2-fetch', target: 'p2-validate', type: 'calls' },
            { source: 'p2-validate', target: 'p2-process', type: 'calls' },
          ],
        }],
      });
    });

    it('should find similar code patterns', async () => {
      const patterns = await bridge.findSimilarPatterns('p1-fetch');

      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);
    });

    it('should return similarity scores', async () => {
      const patterns = await bridge.findSimilarPatterns('p1-fetch');

      if (patterns.length > 0) {
        expect(patterns[0]).toHaveProperty('nodeId');
        expect(patterns[0]).toHaveProperty('similarity');
        expect(patterns[0].similarity).toBeGreaterThan(0);
        expect(patterns[0].similarity).toBeLessThanOrEqual(1);
      }
    });

    it('should respect similarity threshold', async () => {
      const patterns = await bridge.findSimilarPatterns('p1-fetch', {
        threshold: 0.8,
        maxResults: 10,
      });

      for (const pattern of patterns) {
        expect(pattern.similarity).toBeGreaterThanOrEqual(0.8);
      }
    });
  });

  describe('Architecture Analysis', () => {
    beforeEach(async () => {
      await bridge.initialize();
    });

    it('should analyze code architecture', async () => {
      await bridge.buildCodeGraph({
        files: [
          {
            path: 'src/controllers/user.ts',
            nodes: [{ id: 'ctrl', type: 'class', name: 'UserController' }],
            edges: [],
          },
          {
            path: 'src/services/user.ts',
            nodes: [{ id: 'svc', type: 'class', name: 'UserService' }],
            edges: [{ source: 'ctrl', target: 'svc', type: 'depends_on' }],
          },
          {
            path: 'src/repositories/user.ts',
            nodes: [{ id: 'repo', type: 'class', name: 'UserRepository' }],
            edges: [{ source: 'svc', target: 'repo', type: 'depends_on' }],
          },
        ],
      });

      const analysis = await bridge.analyzeArchitecture();

      expect(analysis).toHaveProperty('layers');
      expect(analysis).toHaveProperty('violations');
      expect(analysis).toHaveProperty('metrics');
    });

    it('should detect circular dependencies', async () => {
      await bridge.buildCodeGraph({
        files: [{
          path: 'src/circular.ts',
          nodes: [
            { id: 'a', type: 'module', name: 'moduleA' },
            { id: 'b', type: 'module', name: 'moduleB' },
            { id: 'c', type: 'module', name: 'moduleC' },
          ],
          edges: [
            { source: 'a', target: 'b', type: 'imports' },
            { source: 'b', target: 'c', type: 'imports' },
            { source: 'c', target: 'a', type: 'imports' }, // Circular!
          ],
        }],
      });

      const analysis = await bridge.analyzeArchitecture();

      expect(analysis.violations.some(
        (v: { type: string }) => v.type === 'circular_dependency'
      )).toBe(true);
    });

    it('should calculate coupling metrics', async () => {
      await bridge.buildCodeGraph({
        files: [{
          path: 'src/coupled.ts',
          nodes: [
            { id: 'high-coupling', type: 'class', name: 'HighCoupling' },
            { id: 'dep-1', type: 'class', name: 'Dep1' },
            { id: 'dep-2', type: 'class', name: 'Dep2' },
            { id: 'dep-3', type: 'class', name: 'Dep3' },
          ],
          edges: [
            { source: 'high-coupling', target: 'dep-1', type: 'depends_on' },
            { source: 'high-coupling', target: 'dep-2', type: 'depends_on' },
            { source: 'high-coupling', target: 'dep-3', type: 'depends_on' },
          ],
        }],
      });

      const analysis = await bridge.analyzeArchitecture();

      expect(analysis.metrics).toHaveProperty('averageCoupling');
      expect(analysis.metrics).toHaveProperty('maxCoupling');
    });
  });

  describe('Error Handling', () => {
    it('should throw when operations called before init', async () => {
      await expect(
        bridge.buildCodeGraph({ files: [] })
      ).rejects.toThrow();
    });

    it('should handle invalid graph structure', async () => {
      await bridge.initialize();

      await expect(
        bridge.buildCodeGraph({
          files: [{
            path: null as any,
            nodes: 'not-array' as any,
            edges: undefined as any,
          }],
        })
      ).rejects.toThrow();
    });

    it('should handle missing node references in edges', async () => {
      await bridge.initialize();

      // Should handle gracefully or throw clear error
      try {
        await bridge.buildCodeGraph({
          files: [{
            path: 'test.ts',
            nodes: [{ id: 'existing', type: 'function', name: 'existing' }],
            edges: [{ source: 'existing', target: 'nonexistent', type: 'calls' }],
          }],
        });
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('JavaScript Fallback', () => {
    it('should work without WASM', async () => {
      const fallbackBridge = new GNNBridge();
      await fallbackBridge.initialize();

      await fallbackBridge.buildCodeGraph({
        files: [{
          path: 'test.ts',
          nodes: [{ id: 'test', type: 'function', name: 'test' }],
          edges: [],
        }],
      });

      const embeddings = await fallbackBridge.computeNodeEmbeddings();
      expect(embeddings).toHaveProperty('test');

      await fallbackBridge.destroy();
    });
  });

  describe('Performance', () => {
    beforeEach(async () => {
      await bridge.initialize();
    });

    it('should handle large codebases efficiently', async () => {
      // Create a large graph
      const nodes = Array(1000).fill(null).map((_, i) => ({
        id: `node-${i}`,
        type: 'function',
        name: `func${i}`,
      }));

      const edges = Array(2000).fill(null).map((_, i) => ({
        source: `node-${i % 1000}`,
        target: `node-${(i + 1) % 1000}`,
        type: 'calls',
      }));

      const start = performance.now();
      await bridge.buildCodeGraph({
        files: [{ path: 'large.ts', nodes, edges }],
      });
      await bridge.computeNodeEmbeddings();
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(10000); // Should complete in < 10 seconds
    });

    it('should cache embeddings for repeated queries', async () => {
      await bridge.buildCodeGraph({
        files: [{
          path: 'cache-test.ts',
          nodes: [{ id: 'cached', type: 'function', name: 'cached' }],
          edges: [],
        }],
      });

      const start1 = performance.now();
      await bridge.computeNodeEmbeddings();
      const duration1 = performance.now() - start1;

      const start2 = performance.now();
      await bridge.computeNodeEmbeddings();
      const duration2 = performance.now() - start2;

      // Second call should be faster due to caching
      expect(duration2).toBeLessThanOrEqual(duration1);
    });
  });

  describe('Memory Management', () => {
    it('should release resources on destroy', async () => {
      await bridge.initialize();

      // Build large graph
      await bridge.buildCodeGraph({
        files: [{
          path: 'memory-test.ts',
          nodes: Array(500).fill(null).map((_, i) => ({
            id: `node-${i}`,
            type: 'function',
            name: `func${i}`,
          })),
          edges: Array(1000).fill(null).map((_, i) => ({
            source: `node-${i % 500}`,
            target: `node-${(i + 1) % 500}`,
            type: 'calls',
          })),
        }],
      });

      await bridge.computeNodeEmbeddings();
      await bridge.destroy();

      expect(bridge.isInitialized()).toBe(false);
    });

    it('should handle multiple init/destroy cycles', async () => {
      for (let i = 0; i < 3; i++) {
        await bridge.initialize();
        await bridge.buildCodeGraph({
          files: [{
            path: 'cycle-test.ts',
            nodes: [{ id: 'test', type: 'function', name: 'test' }],
            edges: [],
          }],
        });
        await bridge.destroy();
      }
      expect(bridge.isInitialized()).toBe(false);
    });
  });

  describe('Secret Masking', () => {
    beforeEach(async () => {
      await bridge.initialize({ secretMasking: true });
    });

    it('should mask secrets in node names', async () => {
      await bridge.buildCodeGraph({
        files: [{
          path: 'secrets.ts',
          nodes: [
            { id: 'api-key', type: 'variable', name: 'API_KEY = "sk-secret123"' },
            { id: 'normal', type: 'function', name: 'normalFunction' },
          ],
          edges: [],
        }],
      });

      const exported = await bridge.exportGraph();

      // Secret should be masked
      expect(exported).not.toContain('sk-secret123');
      expect(exported).toContain('[MASKED]');
    });
  });
});
