/**
 * Coder Agent Test Suite
 * Tests for validating coder agent functionality
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { CoderAgent } from '../agents/coder-agent';
import { SwarmOrchestrator } from '../orchestration/swarm';
import { TaskQueue } from '../utils/task-queue';

describe('Coder Agent Test Suite', () => {
  let swarm: SwarmOrchestrator;
  let coderAgent: CoderAgent;
  let taskQueue: TaskQueue;

  beforeAll(async () => {
    // Initialize swarm with mesh topology
    swarm = new SwarmOrchestrator({
      topology: 'mesh',
      maxAgents: 5,
      strategy: 'adaptive'
    });

    // Spawn coder agent
    coderAgent = await swarm.spawnAgent({
      type: 'coder',
      name: 'test-coder',
      capabilities: ['implementation', 'testing', 'debugging']
    });

    taskQueue = new TaskQueue();
  });

  afterAll(async () => {
    await swarm.destroy();
  });

  describe('Core Functionality', () => {
    test('should initialize coder agent correctly', () => {
      expect(coderAgent).toBeDefined();
      expect(coderAgent.type).toBe('coder');
      expect(coderAgent.status).toBe('idle');
      expect(coderAgent.capabilities).toContain('implementation');
    });

    test('should execute simple code generation task', async () => {
      const task = {
        id: 'task-001',
        type: 'code-generation',
        description: 'Generate a fibonacci function',
        language: 'typescript'
      };

      const result = await coderAgent.execute(task);
      
      expect(result.success).toBe(true);
      expect(result.code).toContain('function fibonacci');
      expect(result.code).toContain('return');
      expect(result.metrics.executionTime).toBeLessThan(5000);
    });

    test('should handle complex implementation task', async () => {
      const task = {
        id: 'task-002',
        type: 'complex-implementation',
        description: 'Implement a REST API endpoint with validation',
        requirements: [
          'Express.js framework',
          'Input validation',
          'Error handling',
          'TypeScript types'
        ]
      };

      const result = await coderAgent.execute(task);
      
      expect(result.success).toBe(true);
      expect(result.code).toMatch(/app\.(get|post|put|delete)/);
      expect(result.code).toContain('interface');
      expect(result.code).toContain('try');
      expect(result.code).toContain('catch');
    });
  });

  describe('Parallel Execution', () => {
    test('should handle multiple tasks in parallel', async () => {
      const tasks = [
        { id: 't1', type: 'function', description: 'Create add function' },
        { id: 't2', type: 'function', description: 'Create subtract function' },
        { id: 't3', type: 'function', description: 'Create multiply function' }
      ];

      const results = await Promise.all(
        tasks.map(task => coderAgent.execute(task))
      );

      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
      });
    });

    test('should manage task queue efficiently', async () => {
      const startTime = Date.now();
      
      for (let i = 0; i < 10; i++) {
        taskQueue.add({
          id: `queue-task-${i}`,
          type: 'code',
          priority: i % 3 === 0 ? 'high' : 'normal'
        });
      }

      await coderAgent.processTasks(taskQueue);
      const duration = Date.now() - startTime;

      expect(taskQueue.completed).toBe(10);
      expect(duration).toBeLessThan(10000); // Should complete within 10s
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid task gracefully', async () => {
      const invalidTask = {
        id: 'invalid-001',
        type: 'unknown-type',
        description: null
      };

      const result = await coderAgent.execute(invalidTask);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Invalid task');
    });

    test('should timeout on long-running tasks', async () => {
      const longTask = {
        id: 'timeout-001',
        type: 'infinite-loop',
        timeout: 1000
      };

      const result = await coderAgent.execute(longTask);
      
      expect(result.success).toBe(false);
      expect(result.error.type).toBe('timeout');
      expect(result.metrics.executionTime).toBeGreaterThanOrEqual(1000);
    });

    test('should recover from agent crash', async () => {
      // Simulate agent crash
      await coderAgent.crash();
      expect(coderAgent.status).toBe('crashed');

      // Attempt recovery
      await coderAgent.recover();
      expect(coderAgent.status).toBe('idle');

      // Verify agent can still execute tasks
      const task = { id: 'recovery-test', type: 'simple' };
      const result = await coderAgent.execute(task);
      expect(result.success).toBe(true);
    });
  });

  describe('Performance Benchmarks', () => {
    test('should maintain performance under load', async () => {
      const metrics = {
        totalTasks: 100,
        successRate: 0,
        avgExecutionTime: 0,
        maxMemoryUsage: 0
      };

      const tasks = Array.from({ length: metrics.totalTasks }, (_, i) => ({
        id: `perf-${i}`,
        type: 'code-generation',
        complexity: i % 3 === 0 ? 'high' : 'normal'
      }));

      const startMemory = process.memoryUsage().heapUsed;
      const results = await coderAgent.executeBatch(tasks);
      const endMemory = process.memoryUsage().heapUsed;

      metrics.successRate = results.filter(r => r.success).length / metrics.totalTasks;
      metrics.avgExecutionTime = results.reduce((sum, r) => sum + r.metrics.executionTime, 0) / metrics.totalTasks;
      metrics.maxMemoryUsage = endMemory - startMemory;

      expect(metrics.successRate).toBeGreaterThan(0.95); // 95% success rate
      expect(metrics.avgExecutionTime).toBeLessThan(500); // Avg < 500ms
      expect(metrics.maxMemoryUsage).toBeLessThan(100 * 1024 * 1024); // < 100MB
    });

    test('should optimize code generation speed', async () => {
      const iterations = 50;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await coderAgent.execute({
          id: `speed-${i}`,
          type: 'optimize',
          code: 'function test() { return 1 + 1; }'
        });
        times.push(performance.now() - start);
      }

      // Calculate optimization trend
      const firstHalf = times.slice(0, 25).reduce((a, b) => a + b) / 25;
      const secondHalf = times.slice(25).reduce((a, b) => a + b) / 25;

      expect(secondHalf).toBeLessThan(firstHalf); // Should get faster over time
    });
  });

  describe('Integration Tests', () => {
    test('should integrate with swarm coordinator', async () => {
      const coordinator = await swarm.spawnAgent({ type: 'coordinator' });
      
      const task = {
        id: 'integration-001',
        type: 'coordinated-implementation',
        requiresCoordination: true
      };

      const result = await swarm.orchestrate(task, [coderAgent, coordinator]);
      
      expect(result.agents).toContain('test-coder');
      expect(result.agents).toContain('coordinator');
      expect(result.success).toBe(true);
    });

    test('should share memory with other agents', async () => {
      const memoryKey = 'shared-code-context';
      const sharedData = { 
        functions: ['add', 'subtract'],
        types: ['User', 'Product']
      };

      await coderAgent.storeMemory(memoryKey, sharedData);
      
      const analyzerAgent = await swarm.spawnAgent({ type: 'code-analyzer' });
      const retrievedData = await analyzerAgent.retrieveMemory(memoryKey);

      expect(retrievedData).toEqual(sharedData);
    });

    test('should participate in consensus decisions', async () => {
      const agents = await Promise.all([
        swarm.spawnAgent({ type: 'coder', name: 'coder-1' }),
        swarm.spawnAgent({ type: 'coder', name: 'coder-2' }),
        swarm.spawnAgent({ type: 'coder', name: 'coder-3' })
      ]);

      const proposal = {
        type: 'implementation-approach',
        options: ['functional', 'object-oriented', 'procedural']
      };

      const consensus = await swarm.buildConsensus(proposal, agents);
      
      expect(consensus.decision).toBeDefined();
      expect(consensus.votes).toBeGreaterThanOrEqual(2); // Majority
      expect(consensus.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('Advanced Features', () => {
    test('should support code refactoring', async () => {
      const messyCode = `
        function calc(x,y,z) {
          var result = x + y;
          result = result * z;
          if(result > 100) { return result; }
          else { return 0; }
        }
      `;

      const result = await coderAgent.refactor(messyCode);
      
      expect(result.code).toContain('const');
      expect(result.code).not.toContain('var');
      expect(result.improvements).toContain('arrow-function');
      expect(result.improvements).toContain('ternary-operator');
    });

    test('should generate test cases for code', async () => {
      const code = `
        export function validateEmail(email: string): boolean {
          const regex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
          return regex.test(email);
        }
      `;

      const tests = await coderAgent.generateTests(code);
      
      expect(tests.testCases).toHaveLength(5); // At least 5 test cases
      expect(tests.coverage).toContain('valid-email');
      expect(tests.coverage).toContain('invalid-email');
      expect(tests.coverage).toContain('edge-cases');
    });

    test('should detect and fix code smells', async () => {
      const smelly = {
        duplicateCode: true,
        longMethod: true,
        largeClass: false,
        godObject: false
      };

      const fixes = await coderAgent.fixCodeSmells(smelly);
      
      expect(fixes.duplicateCode).toBe('extracted-to-function');
      expect(fixes.longMethod).toBe('split-into-smaller-methods');
      expect(fixes.applied).toBe(2);
    });
  });
});

// Export test utilities
export { CoderAgent, SwarmOrchestrator, TaskQueue };
export const runAllTests = async () => {
  console.log('🧪 Running Coder Agent Test Suite...');
  // Jest will handle the actual test execution
};