import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { MessageBus } from '../communication/message-bus';
import { TeamCoordinator } from '../coordination/team-coordinator';
import {
  AgentId,
  Message,
  MessageType,
  MessagePriority,
  AgentState as AgentStateEnum,
  Task,
  TaskStatus
} from '../types';

export interface Goal {
  id: string;
  description: string;
  priority: number;
  deadline?: Date;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  subGoals: Goal[];
  requirements: string[];
  context: Record<string, any>;
}

export interface Experience {
  id: string;
  action: string;
  context: Record<string, any>;
  outcome: 'success' | 'failure' | 'partial';
  reward: number;
  timestamp: Date;
  lessons: string[];
}

export interface Capability {
  name: string;
  description: string;
  proficiency: number; // 0-1
  requirements: string[];
  examples: string[];
}

export interface AgentState {
  energy: number; // 0-100
  focus: string; // current focus area
  mood: 'confident' | 'uncertain' | 'frustrated' | 'excited';
  workload: number; // 0-100
  stress: number; // 0-100
}

export interface Decision {
  id: string;
  situation: string;
  options: DecisionOption[];
  selectedOption?: string;
  reasoning: string;
  confidence: number;
  timestamp: Date;
}

export interface DecisionOption {
  id: string;
  action: string;
  expectedOutcome: string;
  risk: number; // 0-1
  cost: number;
  probability: number; // 0-1
}

export class AutonomousAgent extends EventEmitter {
  public readonly agentId: AgentId;
  public readonly name: string;
  public readonly type: string;
  
  private goals: Map<string, Goal> = new Map();
  private experiences: Experience[] = [];
  private capabilities: Map<string, Capability> = new Map();
  private state: AgentState;
  private memory: Map<string, any> = new Map();
  private learningRate: number = 0.1;
  private explorationRate: number = 0.2;
  private qTable: Map<string, Map<string, number>> = new Map();
  
  // Coordination components
  private messageBus: MessageBus;
  private teamCoordinator: TeamCoordinator;
  private currentTasks: Map<string, Task> = new Map();
  private coordinationContext: Map<string, any> = new Map();
  private isRegistered: boolean = false;
  
  // Get ID for backward compatibility
  public get id(): string {
    return this.agentId.id;
  }
  
  constructor(id: string, name: string, type: string, initialCapabilities: Capability[] = []) {
    super();
    
    this.agentId = { id, namespace: 'autonomous' };
    this.name = name;
    this.type = type;
    
    // Initialize coordination components
    this.messageBus = MessageBus.getInstance();
    this.teamCoordinator = new TeamCoordinator();
    
    // Initialize capabilities
    initialCapabilities.forEach(cap => {
      this.capabilities.set(cap.name, cap);
    });
    
    // Initialize state
    this.state = {
      energy: 100,
      focus: 'general',
      mood: 'confident',
      workload: 0,
      stress: 0
    };
    
    // Register with coordination system
    this.initializeCoordination();
    
    // Start autonomous behavior loop
    this.startAutonomousBehavior();
  }

  // Goal Management
  async setGoal(description: string, priority: number = 1, deadline?: Date): Promise<string> {
    const goal: Goal = {
      id: uuidv4(),
      description,
      priority,
      deadline,
      status: 'pending',
      subGoals: [],
      requirements: [],
      context: {}
    };
    
    // Decompose goal into sub-goals
    const subGoals = await this.decomposeGoal(goal);
    goal.subGoals = subGoals;
    
    this.goals.set(goal.id, goal);
    this.emit('goal:set', { agentId: this.id, goal });
    
    // Re-prioritize goals
    await this.prioritizeGoals();
    
    return goal.id;
  }

  private async decomposeGoal(goal: Goal): Promise<Goal[]> {
    // Intelligent goal decomposition based on agent's experience and capabilities
    const subGoals: Goal[] = [];
    
    // Analyze goal complexity
    const complexity = this.analyzeGoalComplexity(goal.description);
    
    if (complexity > 0.7) {
      // Complex goal - break down into phases
      const phases = this.identifyPhases(goal.description);
      
      phases.forEach((phase, index) => {
        const subGoal: Goal = {
          id: uuidv4(),
          description: phase,
          priority: goal.priority + (index * 0.1),
          status: 'pending',
          subGoals: [],
          requirements: this.identifyRequirements(phase),
          context: { parent: goal.id, phase: index }
        };
        subGoals.push(subGoal);
      });
    }
    
    return subGoals;
  }

  private analyzeGoalComplexity(description: string): number {
    // Simple heuristic - could be enhanced with NLP
    const complexityIndicators = [
      'analyze', 'research', 'implement', 'design', 'create',
      'multiple', 'various', 'comprehensive', 'detailed'
    ];
    
    const words = description.toLowerCase().split(' ');
    const matches = words.filter(word => 
      complexityIndicators.some(indicator => word.includes(indicator))
    ).length;
    
    return Math.min(matches / 10, 1);
  }

  private identifyPhases(description: string): string[] {
    // Basic phase identification - could be enhanced with ML
    const phases = [];
    
    if (description.includes('research') || description.includes('analyze')) {
      phases.push('Research and analysis phase');
    }
    
    if (description.includes('design') || description.includes('plan')) {
      phases.push('Design and planning phase');
    }
    
    if (description.includes('implement') || description.includes('build')) {
      phases.push('Implementation phase');
    }
    
    if (description.includes('test') || description.includes('verify')) {
      phases.push('Testing and verification phase');
    }
    
    return phases.length > 0 ? phases : [description];
  }

  private identifyRequirements(description: string): string[] {
    const requirements = [];
    
    // Pattern matching for common requirements
    if (description.includes('data') || description.includes('information')) {
      requirements.push('data_access');
    }
    
    if (description.includes('code') || description.includes('program')) {
      requirements.push('coding_capability');
    }
    
    if (description.includes('write') || description.includes('document')) {
      requirements.push('writing_capability');
    }
    
    return requirements;
  }

  // Decision Making
  async makeDecision(situation: string, options: DecisionOption[]): Promise<string> {
    const decision: Decision = {
      id: uuidv4(),
      situation,
      options,
      reasoning: '',
      confidence: 0,
      timestamp: new Date()
    };
    
    // Multi-strategy decision making
    const strategies = [
      this.utilityBasedDecision.bind(this),
      this.experienceBasedDecision.bind(this),
      this.riskAverseDecision.bind(this),
      this.explorationDecision.bind(this)
    ];
    
    const decisions = await Promise.all(
      strategies.map(strategy => strategy(situation, options))
    );
    
    // Combine strategies based on current state
    const selectedOption = this.combineDecisions(decisions, options);
    decision.selectedOption = selectedOption.id;
    decision.reasoning = this.generateReasoning(selectedOption, decisions);
    decision.confidence = this.calculateConfidence(decisions);
    
    this.emit('decision:made', { agentId: this.id, decision });
    
    return selectedOption.id;
  }

  private async utilityBasedDecision(situation: string, options: DecisionOption[]): Promise<DecisionOption> {
    // Calculate utility for each option
    const utilities = options.map(option => {
      const expectedValue = option.probability * (1 - option.risk) * 100 - option.cost;
      return { option, utility: expectedValue };
    });
    
    // Select option with highest utility
    return utilities.sort((a, b) => b.utility - a.utility)[0].option;
  }

  private async experienceBasedDecision(situation: string, options: DecisionOption[]): Promise<DecisionOption> {
    // Use Q-learning to select based on past experiences
    const stateKey = this.getStateKey(situation);
    const qValues = this.qTable.get(stateKey) || new Map();
    
    let bestOption = options[0];
    let bestValue = -Infinity;
    
    for (const option of options) {
      const qValue = qValues.get(option.action) || 0;
      if (qValue > bestValue) {
        bestValue = qValue;
        bestOption = option;
      }
    }
    
    return bestOption;
  }

  private async riskAverseDecision(situation: string, options: DecisionOption[]): Promise<DecisionOption> {
    // Select option with lowest risk
    return options.sort((a, b) => a.risk - b.risk)[0];
  }

  private async explorationDecision(situation: string, options: DecisionOption[]): Promise<DecisionOption> {
    // Random selection for exploration
    return options[Math.floor(Math.random() * options.length)];
  }

  private combineDecisions(decisions: DecisionOption[], options: DecisionOption[]): DecisionOption {
    const scores = new Map<string, number>();
    
    // Weight strategies based on current state
    const weights = {
      utility: this.state.energy / 100,
      experience: this.experiences.length / 100,
      riskAverse: this.state.stress / 100,
      exploration: this.explorationRate
    };
    
    decisions.forEach((decision, index) => {
      const weightKey = ['utility', 'experience', 'riskAverse', 'exploration'][index];
      const weight = weights[weightKey as keyof typeof weights];
      
      const currentScore = scores.get(decision.id) || 0;
      scores.set(decision.id, currentScore + weight);
    });
    
    // Select option with highest combined score
    let bestOption = options[0];
    let bestScore = -Infinity;
    
    for (const [optionId, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestOption = options.find(o => o.id === optionId) || bestOption;
      }
    }
    
    return bestOption;
  }

  // Learning and Adaptation
  async learnFromExperience(action: string, context: Record<string, any>, outcome: 'success' | 'failure' | 'partial', reward: number): Promise<void> {
    const experience: Experience = {
      id: uuidv4(),
      action,
      context,
      outcome,
      reward,
      timestamp: new Date(),
      lessons: []
    };
    
    // Extract lessons from experience
    experience.lessons = this.extractLessons(experience);
    
    // Update Q-table (reinforcement learning)
    this.updateQTable(action, context, reward);
    
    // Update capabilities based on experience
    this.updateCapabilities(experience);
    
    // Store experience
    this.experiences.push(experience);
    
    // Maintain experience history (keep last 1000)
    if (this.experiences.length > 1000) {
      this.experiences.shift();
    }
    
    this.emit('learning:experience', { agentId: this.id, experience });
  }

  private extractLessons(experience: Experience): string[] {
    const lessons = [];
    
    if (experience.outcome === 'success' && experience.reward > 0.8) {
      lessons.push(`Action '${experience.action}' is highly effective in this context`);
    }
    
    if (experience.outcome === 'failure') {
      lessons.push(`Avoid '${experience.action}' in similar situations`);
    }
    
    if (experience.outcome === 'partial') {
      lessons.push(`Action '${experience.action}' needs refinement`);
    }
    
    return lessons;
  }

  private updateQTable(action: string, context: Record<string, any>, reward: number): void {
    const stateKey = this.getStateKey(JSON.stringify(context));
    
    if (!this.qTable.has(stateKey)) {
      this.qTable.set(stateKey, new Map());
    }
    
    const stateActions = this.qTable.get(stateKey)!;
    const currentQ = stateActions.get(action) || 0;
    
    // Q-learning update rule
    const newQ = currentQ + this.learningRate * (reward - currentQ);
    stateActions.set(action, newQ);
  }

  private updateCapabilities(experience: Experience): void {
    // Update capability proficiency based on experience
    const relatedCapabilities = this.findRelatedCapabilities(experience.action);
    
    relatedCapabilities.forEach(capName => {
      const capability = this.capabilities.get(capName);
      if (capability) {
        const adjustment = experience.outcome === 'success' ? 0.01 : -0.005;
        capability.proficiency = Math.max(0, Math.min(1, capability.proficiency + adjustment));
      }
    });
  }

  private findRelatedCapabilities(action: string): string[] {
    const related = [];
    
    for (const [name, capability] of this.capabilities) {
      if (capability.examples.some(example => 
        action.toLowerCase().includes(example.toLowerCase()) ||
        example.toLowerCase().includes(action.toLowerCase())
      )) {
        related.push(name);
      }
    }
    
    return related;
  }

  // Team Formation and Negotiation
  async proposeTeam(goal: Goal): Promise<string[]> {
    const requiredCapabilities = this.analyzeRequiredCapabilities(goal);
    const teamMembers = [];
    
    // Assess own capabilities
    const ownFit = this.assessCapabilityFit(requiredCapabilities);
    if (ownFit > 0.5) {
      teamMembers.push(this.id);
    }
    
    // This would typically query available agents
    // For now, return placeholder team
    return teamMembers;
  }

  private analyzeRequiredCapabilities(goal: Goal): string[] {
    // Analyze goal to determine required capabilities
    const capabilities = [];
    const description = goal.description.toLowerCase();
    
    if (description.includes('research') || description.includes('analyze')) {
      capabilities.push('research');
    }
    
    if (description.includes('code') || description.includes('implement')) {
      capabilities.push('programming');
    }
    
    if (description.includes('write') || description.includes('document')) {
      capabilities.push('writing');
    }
    
    return capabilities;
  }

  private assessCapabilityFit(requiredCapabilities: string[]): number {
    if (requiredCapabilities.length === 0) return 1;
    
    const matches = requiredCapabilities.filter(req => 
      this.capabilities.has(req) && this.capabilities.get(req)!.proficiency > 0.5
    ).length;
    
    return matches / requiredCapabilities.length;
  }

  // Autonomous Behavior Loop
  private startAutonomousBehavior(): void {
    setInterval(() => {
      this.autonomousThink();
    }, 5000); // Think every 5 seconds
  }

  private async autonomousThink(): Promise<void> {
    // Update state based on current situation
    this.updateState();
    
    // Check if any goals need attention
    const activeGoals = Array.from(this.goals.values())
      .filter(g => g.status === 'pending' || g.status === 'in-progress');
    
    if (activeGoals.length > 0) {
      // Work on highest priority goal
      const priorityGoal = activeGoals.sort((a, b) => b.priority - a.priority)[0];
      await this.workOnGoal(priorityGoal);
    } else {
      // No active goals - enter idle state or self-improve
      await this.selfImprove();
    }
  }

  private updateState(): void {
    // Update agent state based on various factors
    const goalCount = this.goals.size;
    const recentFailures = this.experiences.slice(-10)
      .filter(e => e.outcome === 'failure').length;
    
    // Update workload
    this.state.workload = Math.min(100, goalCount * 20);
    
    // Update stress based on recent failures
    this.state.stress = Math.min(100, recentFailures * 10);
    
    // Update mood
    if (this.state.stress > 70) {
      this.state.mood = 'frustrated';
    } else if (this.state.workload > 80) {
      this.state.mood = 'uncertain';
    } else {
      this.state.mood = 'confident';
    }
    
    // Energy decreases with workload and stress
    this.state.energy = Math.max(0, 100 - (this.state.workload + this.state.stress) / 2);
  }

  private async workOnGoal(goal: Goal): Promise<void> {
    goal.status = 'in-progress';
    
    // Simulate goal work
    const actions = this.planActions(goal);
    
    for (const action of actions) {
      const success = Math.random() > 0.2; // 80% success rate
      const reward = success ? 0.8 : 0.2;
      
      await this.learnFromExperience(
        action,
        { goalId: goal.id },
        success ? 'success' : 'failure',
        reward
      );
      
      if (success) {
        goal.status = 'completed';
        this.emit('goal:completed', { agentId: this.id, goalId: goal.id });
        break;
      }
    }
  }

  private planActions(goal: Goal): string[] {
    // Simple action planning based on goal
    const actions = [];
    
    if (goal.description.includes('research')) {
      actions.push('gather_information', 'analyze_data', 'synthesize_findings');
    } else if (goal.description.includes('implement')) {
      actions.push('design_solution', 'write_code', 'test_implementation');
    } else {
      actions.push('analyze_goal', 'create_plan', 'execute_plan');
    }
    
    return actions;
  }

  private async selfImprove(): Promise<void> {
    // Self-improvement activities when idle
    const activities = [
      'review_experiences',
      'update_capabilities',
      'optimize_strategies',
      'learn_new_skills'
    ];
    
    const activity = activities[Math.floor(Math.random() * activities.length)];
    
    await this.learnFromExperience(
      activity,
      { type: 'self_improvement' },
      'success',
      0.1
    );
  }

  private async prioritizeGoals(): Promise<void> {
    const goals = Array.from(this.goals.values());
    
    // Re-prioritize based on deadlines, complexity, and current state
    goals.forEach(goal => {
      let priority = goal.priority;
      
      // Increase priority if deadline is approaching
      if (goal.deadline) {
        const timeLeft = goal.deadline.getTime() - Date.now();
        const daysLeft = timeLeft / (24 * 60 * 60 * 1000);
        if (daysLeft < 7) {
          priority += 0.5;
        }
      }
      
      // Adjust priority based on current state
      if (this.state.energy < 50) {
        // Prefer simpler goals when energy is low
        const complexity = this.analyzeGoalComplexity(goal.description);
        priority -= complexity * 0.3;
      }
      
      goal.priority = priority;
    });
  }

  private getStateKey(context: string): string {
    // Create a simplified state key for Q-learning
    return context.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '');
  }

  private generateReasoning(option: DecisionOption, decisions: DecisionOption[]): string {
    return `Selected option '${option.action}' based on multiple decision strategies. Expected probability: ${option.probability}, Risk: ${option.risk}, Cost: ${option.cost}`;
  }

  private calculateConfidence(decisions: DecisionOption[]): number {
    // Calculate confidence based on agreement between strategies
    const actions = new Set(decisions.map(d => d.action));
    return 1 - (actions.size - 1) / decisions.length;
  }
  
  // ========================
  // COORDINATION METHODS
  // ========================
  
  /**
   * Initialize coordination capabilities
   */
  private async initializeCoordination(): Promise<void> {
    try {
      // Register with message bus
      await this.messageBus.registerAgent(this.agentId);
      
      // Subscribe to messages
      this.messageBus.subscribe(this.agentId, this.handleMessage.bind(this));
      
      this.isRegistered = true;
      this.emit('coordination:initialized', { agentId: this.agentId });
    } catch (error) {
      console.error('Failed to initialize coordination:', error);
      this.emit('coordination:error', { error, agentId: this.agentId });
    }
  }
  
  /**
   * Handle incoming messages
   */
  private async handleMessage(message: Message): Promise<void> {
    try {
      this.updateState();
      
      switch (message.type) {
        case MessageType.COMMAND:
          await this.handleCommand(message);
          break;
        case MessageType.REQUEST:
          await this.handleRequest(message);
          break;
        case MessageType.INFORM:
          await this.handleInform(message);
          break;
        case MessageType.QUERY:
          await this.handleQuery(message);
          break;
        case MessageType.NEGOTIATE:
          await this.handleNegotiation(message);
          break;
        default:
          console.warn(`Unhandled message type: ${message.type}`);
      }
      
      // Send acknowledgment for high priority messages
      if (message.priority === MessagePriority.URGENT || message.priority === MessagePriority.HIGH) {
        await this.sendAcknowledgment(message);
      }
      
    } catch (error) {
      console.error('Error handling message:', error);
      await this.sendErrorResponse(message, error);
    }
  }
  
  /**
   * Handle command messages
   */
  private async handleCommand(message: Message): Promise<void> {
    const { topic, body } = message.content;
    
    switch (topic) {
      case 'task:assignment':
        await this.handleTaskAssignment(body, message);
        break;
      case 'goal:assign':
        await this.handleGoalAssignment(body, message);
        break;
      case 'coordination:join_team':
        await this.handleJoinTeam(body, message);
        break;
      case 'coordination:leave_team':
        await this.handleLeaveTeam(body, message);
        break;
      default:
        console.warn(`Unhandled command topic: ${topic}`);
    }
  }
  
  /**
   * Handle task assignment from coordinator
   */
  private async handleTaskAssignment(taskData: any, originalMessage: Message): Promise<void> {
    const { tasks, goal, strategy } = taskData;
    
    for (const taskInfo of tasks) {
      const task: Task = {
        id: uuidv4(),
        goalId: taskInfo.goalId,
        assignedTo: this.agentId,
        description: taskInfo.description,
        status: TaskStatus.ASSIGNED,
        startedAt: new Date()
      };
      
      this.currentTasks.set(task.id, task);
      
      // Start working on the task
      this.executeTask(task);
    }
    
    // Send acknowledgment
    await this.sendMessage({
      to: originalMessage.from,
      type: MessageType.ACKNOWLEDGE,
      content: {
        topic: 'task:accepted',
        body: { 
          taskCount: tasks.length,
          strategy,
          agentState: this.getCoordinationState()
        }
      },
      priority: MessagePriority.HIGH
    });
  }
  
  /**
   * Execute a task with coordination awareness
   */
  private async executeTask(task: Task): Promise<void> {
    try {
      task.status = TaskStatus.IN_PROGRESS;
      this.emit('task:started', { task, agentId: this.agentId });
      
      // Simulate task execution with real coordination
      const actions = this.planActions({ 
        id: task.goalId, 
        description: task.description,
        priority: 1,
        status: 'in-progress',
        subGoals: [],
        requirements: [],
        context: {}
      });
      
      let taskResult = null;
      for (const action of actions) {
        // Check if we need coordination for this action
        if (await this.requiresCoordination(action, task)) {
          taskResult = await this.coordinateAction(action, task);
        } else {
          taskResult = await this.executeAction(action, task);
        }
        
        if (!taskResult.success) {
          throw new Error(taskResult.error || 'Action failed');
        }
      }
      
      task.status = TaskStatus.COMPLETED;
      task.completedAt = new Date();
      task.result = taskResult;
      
      // Report completion to team
      await this.reportTaskCompletion(task);
      
      this.emit('task:completed', { task, agentId: this.agentId });
      
    } catch (error) {
      task.status = TaskStatus.FAILED;
      task.error = error as Error;
      task.completedAt = new Date();
      
      await this.reportTaskFailure(task, error as Error);
      this.emit('task:failed', { task, error, agentId: this.agentId });
    }
  }
  
  /**
   * Check if an action requires coordination
   */
  private async requiresCoordination(action: string, task: Task): Promise<boolean> {
    // Actions that typically require coordination
    const coordinationActions = [
      'gather_information',
      'design_solution', 
      'analyze_data',
      'synthesize_findings'
    ];
    
    return coordinationActions.includes(action) || 
           this.coordinationContext.has('requires_coordination');
  }
  
  /**
   * Coordinate an action with other agents
   */
  private async coordinateAction(action: string, task: Task): Promise<{ success: boolean; result?: any; error?: string }> {
    try {
      // Request coordination from team
      const coordinationRequest = {
        action,
        task: task.id,
        requiredCapabilities: this.identifyRequiredCapabilities(action),
        priority: MessagePriority.HIGH
      };
      
      const team = this.teamCoordinator.getAgentTeam(this.agentId);
      if (!team) {
        // No team - execute independently
        return await this.executeAction(action, task);
      }
      
      // Send coordination request to team leader
      await this.sendMessage({
        to: team.leader,
        type: MessageType.REQUEST,
        content: {
          topic: 'coordination:request',
          body: coordinationRequest
        },
        priority: MessagePriority.HIGH
      });
      
      // Wait for coordination response (simplified - would use promises/callbacks in real implementation)
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Execute coordinated action
      const result = await this.executeAction(action, task);
      
      // Share results with team
      await this.shareActionResult(action, task, result);
      
      return result;
      
    } catch (error) {
      console.error('Coordination failed:', error);
      // Fallback to independent execution
      return await this.executeAction(action, task);
    }
  }
  
  /**
   * Execute an action independently
   */
  private async executeAction(action: string, task: Task): Promise<{ success: boolean; result?: any; error?: string }> {
    try {
      // Simulate action execution
      const success = Math.random() > 0.2; // 80% success rate
      const reward = success ? 0.8 : 0.2;
      
      await this.learnFromExperience(
        action,
        { taskId: task.id, goalId: task.goalId },
        success ? 'success' : 'failure',
        reward
      );
      
      return {
        success,
        result: success ? { action, outcome: 'completed', reward } : undefined,
        error: success ? undefined : 'Action execution failed'
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }
  
  /**
   * Share action results with team
   */
  private async shareActionResult(action: string, task: Task, result: any): Promise<void> {
    const team = this.teamCoordinator.getAgentTeam(this.agentId);
    if (!team) return;
    
    await this.sendMessage({
      to: team.members.filter(m => m.id !== this.agentId.id),
      type: MessageType.INFORM,
      content: {
        topic: 'action:result',
        body: {
          action,
          taskId: task.id,
          result,
          timestamp: new Date(),
          agentId: this.agentId
        }
      },
      priority: MessagePriority.NORMAL
    });
  }
  
  /**
   * Report task completion to coordinator
   */
  private async reportTaskCompletion(task: Task): Promise<void> {
    const team = this.teamCoordinator.getAgentTeam(this.agentId);
    if (!team) return;
    
    await this.sendMessage({
      to: team.leader,
      type: MessageType.INFORM,
      content: {
        topic: 'task:completed',
        body: {
          taskId: task.id,
          goalId: task.goalId,
          result: task.result,
          duration: task.completedAt!.getTime() - task.startedAt!.getTime(),
          agentId: this.agentId
        }
      },
      priority: MessagePriority.HIGH
    });
  }
  
  /**
   * Report task failure to coordinator
   */
  private async reportTaskFailure(task: Task, error: Error): Promise<void> {
    const team = this.teamCoordinator.getAgentTeam(this.agentId);
    if (!team) return;
    
    await this.sendMessage({
      to: team.leader,
      type: MessageType.INFORM,
      content: {
        topic: 'task:failed',
        body: {
          taskId: task.id,
          goalId: task.goalId,
          error: error.message,
          agentId: this.agentId,
          needsHelp: true
        }
      },
      priority: MessagePriority.URGENT
    });
  }
  
  /**
   * Send a message to other agents
   */
  public async sendMessage(params: {
    to: AgentId | AgentId[];
    type: MessageType;
    content: { topic: string; body: any };
    priority?: MessagePriority;
  }): Promise<void> {
    if (!this.isRegistered) {
      throw new Error('Agent not registered with coordination system');
    }
    
    const message: Message = {
      id: uuidv4(),
      from: this.agentId,
      to: params.to,
      type: params.type,
      content: params.content,
      timestamp: new Date(),
      priority: params.priority || MessagePriority.NORMAL
    };
    
    await this.messageBus.send(message);
  }
  
  /**
   * Handle other message types
   */
  private async handleRequest(message: Message): Promise<void> {
    const { topic, body } = message.content;
    
    switch (topic) {
      case 'capability:query':
        await this.respondWithCapabilities(message);
        break;
      case 'state:query':
        await this.respondWithState(message);
        break;
      case 'coordination:request':
        await this.handleCoordinationRequest(body, message);
        break;
    }
  }
  
  private async handleInform(message: Message): Promise<void> {
    const { topic, body } = message.content;
    
    switch (topic) {
      case 'team:created':
      case 'member:added':
      case 'member:removed':
        this.updateCoordinationContext(topic, body);
        break;
      case 'action:result':
        this.processSharedResult(body);
        break;
    }
  }
  
  private async handleQuery(message: Message): Promise<void> {
    // Handle queries about agent status, capabilities, etc.
    const response = this.processQuery(message.content);
    
    await this.sendMessage({
      to: message.from,
      type: MessageType.RESPONSE,
      content: {
        topic: 'query:response',
        body: response
      },
      priority: message.priority
    });
  }
  
  private async handleNegotiation(message: Message): Promise<void> {
    // Handle negotiation messages for resource allocation, task sharing, etc.
    const negotiationResponse = this.processNegotiation(message.content);
    
    await this.sendMessage({
      to: message.from,
      type: MessageType.RESPONSE,
      content: {
        topic: 'negotiation:response',
        body: negotiationResponse
      },
      priority: message.priority
    });
  }
  
  /**
   * Utility methods
   */
  private async sendAcknowledgment(message: Message): Promise<void> {
    await this.sendMessage({
      to: message.from,
      type: MessageType.ACKNOWLEDGE,
      content: {
        topic: 'message:received',
        body: { messageId: message.id, receivedAt: new Date() }
      },
      priority: MessagePriority.LOW
    });
  }
  
  private async sendErrorResponse(message: Message, error: any): Promise<void> {
    await this.sendMessage({
      to: message.from,
      type: MessageType.RESPONSE,
      content: {
        topic: 'error:processing',
        body: { 
          originalMessageId: message.id, 
          error: error.message,
          agentId: this.agentId
        }
      },
      priority: MessagePriority.HIGH
    });
  }
  
  private getCoordinationState(): any {
    return {
      agentId: this.agentId,
      state: this.state,
      currentTasks: Array.from(this.currentTasks.values()),
      capabilities: Array.from(this.capabilities.keys()),
      workload: this.state.workload,
      availability: this.state.energy > 30 && this.state.stress < 70
    };
  }
  
  private identifyRequiredCapabilities(action: string): string[] {
    // Map actions to required capabilities
    const capabilityMap: Record<string, string[]> = {
      'gather_information': ['research', 'data_access'],
      'analyze_data': ['analysis', 'statistics'],
      'design_solution': ['design', 'architecture'],
      'write_code': ['programming', 'software_development'],
      'synthesize_findings': ['synthesis', 'writing']
    };
    
    return capabilityMap[action] || [];
  }
  
  private updateCoordinationContext(topic: string, data: any): void {
    this.coordinationContext.set(topic, data);
    this.emit('coordination:context_updated', { topic, data });
  }
  
  private processSharedResult(result: any): void {
    // Process shared results from other agents
    this.coordinationContext.set('shared_results', result);
    this.emit('coordination:result_received', result);
  }
  
  private processQuery(content: any): any {
    return {
      agentId: this.agentId,
      capabilities: Array.from(this.capabilities.keys()),
      state: this.state,
      currentGoals: Array.from(this.goals.values()),
      timestamp: new Date()
    };
  }
  
  private processNegotiation(content: any): any {
    // Simple negotiation logic - can be enhanced
    return {
      agentId: this.agentId,
      response: 'accept', // or 'reject', 'counter'
      terms: content.body,
      timestamp: new Date()
    };
  }
  
  
  private async handleGoalAssignment(body: any, message: Message): Promise<void> {
    const goal = body.goal;
    await this.setGoal(goal.description, goal.priority, goal.deadline);
    
    await this.sendMessage({
      to: message.from,
      type: MessageType.ACKNOWLEDGE,
      content: {
        topic: 'goal:accepted',
        body: { goalId: goal.id, agentId: this.agentId }
      },
      priority: MessagePriority.HIGH
    });
  }
  
  private async handleJoinTeam(body: any, message: Message): Promise<void> {
    // Logic for joining a team
    this.emit('coordination:team_joined', { teamId: body.teamId, agentId: this.agentId });
  }
  
  private async handleLeaveTeam(body: any, message: Message): Promise<void> {
    // Logic for leaving a team
    this.emit('coordination:team_left', { teamId: body.teamId, agentId: this.agentId });
  }
  
  private async respondWithCapabilities(message: Message): Promise<void> {
    await this.sendMessage({
      to: message.from,
      type: MessageType.RESPONSE,
      content: {
        topic: 'capabilities:list',
        body: {
          agentId: this.agentId,
          capabilities: Array.from(this.capabilities.values()),
          availability: this.getCoordinationState().availability
        }
      },
      priority: message.priority
    });
  }
  
  private async respondWithState(message: Message): Promise<void> {
    await this.sendMessage({
      to: message.from,
      type: MessageType.RESPONSE,
      content: {
        topic: 'state:current',
        body: this.getCoordinationState()
      },
      priority: message.priority
    });
  }
  
  private async handleCoordinationRequest(body: any, message: Message): Promise<void> {
    // Handle coordination requests from other agents
    const response = {
      approved: this.state.energy > 30,
      supportOffered: body.requiredCapabilities.filter((cap: string) => 
        this.capabilities.has(cap)
      ),
      agentId: this.agentId
    };
    
    await this.sendMessage({
      to: message.from,
      type: MessageType.RESPONSE,
      content: {
        topic: 'coordination:response',
        body: response
      },
      priority: message.priority
    });
  }
  
  /**
   * Cleanup coordination when agent stops
   */
  public async stop(): Promise<void> {
    if (this.isRegistered) {
      await this.messageBus.unregisterAgent(this.agentId);
      this.isRegistered = false;
    }
    
    this.emit('agent:stopped', { agentId: this.agentId });
  }

  // Public API
  getState(): AgentState {
    return { ...this.state };
  }

  getGoals(): Goal[] {
    return Array.from(this.goals.values());
  }

  getCapabilities(): Capability[] {
    return Array.from(this.capabilities.values());
  }

  getExperiences(limit: number = 10): Experience[] {
    return this.experiences.slice(-limit);
  }

  async pause(): Promise<void> {
    this.emit('agent:paused', { agentId: this.id });
  }

  async resume(): Promise<void> {
    this.emit('agent:resumed', { agentId: this.id });
  }
}