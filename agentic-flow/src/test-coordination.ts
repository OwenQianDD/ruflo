/**
 * Simple test script to validate coordination system functionality
 */

import { AutonomousAgent } from './autonomous/autonomous-agent';
import { TeamCoordinator } from './coordination/team-coordinator';
import { MessageBus } from './communication/message-bus';
import {
  Goal,
  GoalType,
  GoalPriority,
  GoalStatus,
  TeamFormation,
  MessageType,
  MessagePriority
} from './types';
import { v4 as uuidv4 } from 'uuid';

async function testCoordination() {
  console.log('🚀 Starting Coordination System Test');
  
  try {
    // Initialize coordination components
    const messageBus = MessageBus.getInstance();
    const teamCoordinator = new TeamCoordinator();
    
    // Create test agents
    const coordinatorAgent = new AutonomousAgent(
      'coord-1',
      'Test Coordinator',
      'coordinator',
      [
        { 
          name: 'coordination', 
          description: 'Team coordination', 
          proficiency: 0.9, 
          requirements: [], 
          examples: ['team management'] 
        }
      ]
    );
    
    const workerAgent = new AutonomousAgent(
      'worker-1',
      'Test Worker',
      'worker',
      [
        { 
          name: 'work', 
          description: 'General work tasks', 
          proficiency: 0.8, 
          requirements: [], 
          examples: ['task execution'] 
        }
      ]
    );
    
    console.log('✅ Agents created successfully');
    
    // Wait for agent initialization
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Create team
    const testGoal: Goal = {
      id: uuidv4(),
      description: 'Complete a simple coordination test',
      type: GoalType.ACHIEVE,
      priority: GoalPriority.HIGH,
      status: GoalStatus.PENDING,
      dependencies: [],
      constraints: []
    };
    
    const team = await teamCoordinator.createTeam(
      'Test Team',
      coordinatorAgent.agentId,
      [testGoal],
      TeamFormation.FLAT
    );
    
    console.log('✅ Team created:', team.id);
    
    // Add worker to team
    await teamCoordinator.addMember(team.id, workerAgent.agentId);
    console.log('✅ Team member added');
    
    // Test direct communication
    await coordinatorAgent.sendMessage({
      to: workerAgent.agentId,
      type: MessageType.INFORM,
      content: {
        topic: 'test:communication',
        body: { message: 'Hello from coordinator!' }
      },
      priority: MessagePriority.NORMAL
    });
    
    console.log('✅ Message sent successfully');
    
    // Wait for message processing
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check coordination metrics
    const metrics = messageBus.getCoordinationMetrics();
    console.log('📊 Coordination Metrics:');
    console.log('   Active agents:', metrics.activeAgents);
    console.log('   Messages processed:', metrics.messageCount);
    
    // Test goal assignment
    await teamCoordinator.assignGoal(team.id, testGoal);
    console.log('✅ Goal assigned to team');
    
    // Wait for coordination to process
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('🎉 Coordination test completed successfully!');
    
    // Cleanup
    await coordinatorAgent.stop();
    await workerAgent.stop();
    await teamCoordinator.disbandTeam(team.id);
    
    console.log('🧹 Cleanup completed');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run test
testCoordination().then(() => {
  console.log('✅ All tests passed!');
  process.exit(0);
}).catch(error => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});