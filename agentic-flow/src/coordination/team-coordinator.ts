import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import {
  Team,
  TeamFormation,
  TeamStatus,
  AgentId,
  Goal,
  GoalPriority,
  GoalStatus,
  AgentProfile,
  AgentCapability,
  AgentState as AgentStateEnum,
  CoordinationStrategy,
  CoordinationContext,
  Message,
  MessageType,
  MessagePriority,
  Constraint
} from '../types';
import { Logger } from '../utils/logger';
import { MessageBus } from '../communication/message-bus';

/**
 * Team coordinator for managing agent teams and coordination
 */
export class TeamCoordinator extends EventEmitter {
  private readonly logger: Logger;
  private readonly messageBus: MessageBus;
  private teams: Map<string, Team>;
  private agentTeams: Map<string, string>; // agentId -> teamId
  private strategies: Map<string, CoordinationStrategy>;

  constructor() {
    super();
    this.logger = new Logger('TeamCoordinator');
    this.messageBus = MessageBus.getInstance();
    this.teams = new Map();
    this.agentTeams = new Map();
    this.strategies = new Map();
    
    this.initializeStrategies();
  }

  /**
   * Initialize default coordination strategies
   */
  private initializeStrategies(): void {
    // Hierarchical strategy
    this.registerStrategy({
      type: 'hierarchical',
      parameters: { levels: 3 },
      evaluate: (context) => {
        // Evaluate based on team size and goal complexity
        const teamSize = context.team.members.length;
        const goalComplexity = context.currentGoals.reduce((sum, g) => 
          sum + (g.subGoals?.length || 1), 0
        );
        return teamSize > 5 && goalComplexity > 10 ? 0.9 : 0.5;
      }
    });
    
    // Flat strategy
    this.registerStrategy({
      type: 'flat',
      parameters: { maxSize: 10 },
      evaluate: (context) => {
        // Better for small teams with simple goals
        const teamSize = context.team.members.length;
        const goalComplexity = context.currentGoals.reduce((sum, g) => 
          sum + (g.subGoals?.length || 1), 0
        );
        return teamSize <= 5 && goalComplexity <= 5 ? 0.9 : 0.3;
      }
    });
    
    // Matrix strategy
    this.registerStrategy({
      type: 'matrix',
      parameters: { dimensions: 2 },
      evaluate: (context) => {
        // Good for cross-functional teams
        const uniqueCapabilities = new Set<string>();
        context.team.members.forEach(memberId => {
          // In real implementation, would look up agent capabilities
          uniqueCapabilities.add('default');
        });
        return uniqueCapabilities.size > 3 ? 0.8 : 0.4;
      }
    });
    
    // Dynamic strategy
    this.registerStrategy({
      type: 'dynamic',
      parameters: { adaptationRate: 0.1 },
      evaluate: (context) => {
        // Always moderately good, adapts over time
        return 0.7;
      }
    });
  }

  /**
   * Create a new team
   */
  public async createTeam(
    name: string,
    leader: AgentId,
    goals: Goal[],
    formation: TeamFormation = TeamFormation.DYNAMIC
  ): Promise<Team> {
    try {
      this.logger.info('Creating new team', { name, leader: leader.id });
      
      const team: Team = {
        id: uuidv4(),
        name,
        leader,
        members: [leader],
        goals,
        formation,
        status: TeamStatus.FORMING,
        createdAt: new Date()
      };
      
      // Store team
      this.teams.set(team.id, team);
      this.agentTeams.set(this.getAgentKey(leader), team.id);
      
      // Notify leader
      await this.notifyTeamUpdate(team, 'team:created');
      
      this.emit('team:created', team);
      return team;
    } catch (error) {
      this.logger.error('Failed to create team', error);
      throw error;
    }
  }

  /**
   * Add member to team
   */
  public async addMember(teamId: string, agentId: AgentId): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }
    
    const agentKey = this.getAgentKey(agentId);
    
    // Check if agent is already in a team
    if (this.agentTeams.has(agentKey)) {
      throw new Error(`Agent already in team: ${agentKey}`);
    }
    
    // Add to team
    team.members.push(agentId);
    this.agentTeams.set(agentKey, teamId);
    
    // Notify team members
    await this.notifyTeamUpdate(team, 'member:added', { newMember: agentId });
    
    this.logger.info('Added member to team', { teamId, agentId: agentKey });
    this.emit('team:memberAdded', { team, member: agentId });
  }

  /**
   * Remove member from team
   */
  public async removeMember(teamId: string, agentId: AgentId): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }
    
    const agentKey = this.getAgentKey(agentId);
    
    // Remove from team
    team.members = team.members.filter(m => 
      this.getAgentKey(m) !== agentKey
    );
    this.agentTeams.delete(agentKey);
    
    // Check if team is empty
    if (team.members.length === 0) {
      await this.disbandTeam(teamId);
      return;
    }
    
    // Assign new leader if needed
    if (this.getAgentKey(team.leader) === agentKey) {
      team.leader = team.members[0];
      await this.notifyTeamUpdate(team, 'leader:changed', { newLeader: team.leader });
    }
    
    // Notify remaining members
    await this.notifyTeamUpdate(team, 'member:removed', { removedMember: agentId });
    
    this.logger.info('Removed member from team', { teamId, agentId: agentKey });
    this.emit('team:memberRemoved', { team, member: agentId });
  }

  /**
   * Assign goal to team
   */
  public async assignGoal(teamId: string, goal: Goal): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }
    
    // Add goal
    team.goals.push(goal);
    
    // Update team status if needed
    if (team.status === TeamStatus.ACTIVE) {
      team.status = TeamStatus.EXECUTING;
    }
    
    // Notify team members
    await this.notifyTeamUpdate(team, 'goal:assigned', { goal });
    
    // Coordinate goal execution
    await this.coordinateGoalExecution(team, goal);
    
    this.logger.info('Assigned goal to team', { teamId, goalId: goal.id });
    this.emit('team:goalAssigned', { team, goal });
  }

  /**
   * Coordinate goal execution within team
   */
  private async coordinateGoalExecution(team: Team, goal: Goal): Promise<void> {
    try {
      // Select coordination strategy
      const strategy = this.selectStrategy(team, [goal]);
      
      // Create coordination context
      const context: CoordinationContext = {
        team,
        currentGoals: [goal],
        agentStates: new Map(), // Would be populated with actual states
        environment: {}
      };
      
      // Apply strategy
      this.logger.debug('Applying coordination strategy', { 
        teamId: team.id, 
        strategy: strategy.type 
      });
      
      // Decompose goal based on team formation
      const taskAssignments = await this.decomposeAndAssign(team, goal, strategy);
      
      // Send task assignments to team members
      for (const [agentId, tasks] of taskAssignments) {
        await this.messageBus.send({
          id: uuidv4(),
          from: team.leader,
          to: agentId,
          type: MessageType.COMMAND,
          content: {
            topic: 'task:assignment',
            body: { tasks, goal, strategy: strategy.type }
          },
          timestamp: new Date(),
          priority: MessagePriority.HIGH
        });
      }
      
      this.emit('coordination:executed', { team, goal, strategy });
    } catch (error) {
      this.logger.error('Failed to coordinate goal execution', error);
      throw error;
    }
  }

  /**
   * Decompose goal and assign tasks to team members using real coordination algorithms
   */
  private async decomposeAndAssign(
    team: Team,
    goal: Goal,
    strategy: CoordinationStrategy
  ): Promise<Map<AgentId, any[]>> {
    const assignments = new Map<AgentId, any[]>();
    
    // Get agent capabilities for intelligent assignment
    const agentCapabilities = await this.getTeamCapabilities(team);
    
    // Decompose goal based on strategy
    const subGoals = goal.subGoals || await this.intelligentGoalDecomposition(goal);
    
    switch (strategy.type) {
      case 'hierarchical':
        return this.hierarchicalAssignment(team, subGoals, agentCapabilities);
      case 'flat':
        return this.capabilityBasedAssignment(team, subGoals, agentCapabilities);
      case 'matrix':
        return this.matrixAssignment(team, subGoals, agentCapabilities);
      case 'dynamic':
        return this.dynamicAssignment(team, subGoals, agentCapabilities);
      default:
        return this.defaultAssignment(team, subGoals);
    }
  }
  
  /**
   * Get capabilities of all team members
   */
  private async getTeamCapabilities(team: Team): Promise<Map<string, string[]>> {
    const capabilities = new Map<string, string[]>();
    
    for (const member of team.members) {
      try {
        // Query agent for capabilities
        const response = await this.messageBus.sendAndWaitForResponse({
          id: uuidv4(),
          from: team.leader,
          to: member,
          type: MessageType.REQUEST,
          content: {
            topic: 'capability:query',
            body: { requestId: uuidv4() }
          },
          timestamp: new Date(),
          priority: MessagePriority.HIGH
        }, 5000);
        
        const agentKey = this.getAgentKey(member);
        capabilities.set(agentKey, response.content.body.capabilities || []);
      } catch (error) {
        this.logger.warn('Failed to get agent capabilities', { member: this.getAgentKey(member), error });
        capabilities.set(this.getAgentKey(member), []);
      }
    }
    
    return capabilities;
  }
  
  /**
   * Intelligent goal decomposition
   */
  private async intelligentGoalDecomposition(goal: Goal): Promise<Goal[]> {
    const decomposed: Goal[] = [];
    
    // Analyze goal complexity and type
    const complexityScore = this.analyzeGoalComplexity(goal);
    
    if (complexityScore > 0.7) {
      // High complexity - break into phases
      const phases = this.identifyGoalPhases(goal);
      
      phases.forEach((phase, index) => {
        decomposed.push({
          id: uuidv4(),
          description: phase.description,
          type: goal.type,
          priority: goal.priority,
          status: GoalStatus.PENDING,
          dependencies: index > 0 ? [decomposed[index - 1].id] : [],
          constraints: phase.constraints || [],
          subGoals: [],
          metadata: {
            parentGoal: goal.id,
            phase: index + 1,
            totalPhases: phases.length
          }
        });
      });
    } else {
      // Low complexity - create parallel sub-goals
      const subTasks = this.identifyParallelTasks(goal);
      
      subTasks.forEach(task => {
        decomposed.push({
          id: uuidv4(),
          description: task.description,
          type: goal.type,
          priority: task.priority || goal.priority,
          status: GoalStatus.PENDING,
          dependencies: [],
          constraints: task.constraints || [],
          subGoals: [],
          metadata: {
            parentGoal: goal.id,
            taskType: task.type
          }
        });
      });
    }
    
    return decomposed.length > 0 ? decomposed : [goal];
  }
  
  /**
   * Hierarchical task assignment
   */
  private async hierarchicalAssignment(
    team: Team,
    subGoals: Goal[],
    agentCapabilities: Map<string, string[]>
  ): Promise<Map<AgentId, any[]>> {
    const assignments = new Map<AgentId, any[]>();
    
    // Leader handles coordination and complex tasks
    const leaderKey = this.getAgentKey(team.leader);
    const leaderCapabilities = agentCapabilities.get(leaderKey) || [];
    
    const complexTasks: Goal[] = [];
    const simpleTasks: Goal[] = [];
    
    subGoals.forEach(goal => {
      if (this.analyzeGoalComplexity(goal) > 0.6) {
        complexTasks.push(goal);
      } else {
        simpleTasks.push(goal);
      }
    });
    
    // Assign complex tasks to leader if capable
    if (complexTasks.length > 0) {
      assignments.set(team.leader, complexTasks.map(task => ({
        goalId: task.id,
        description: task.description,
        type: task.type,
        priority: task.priority,
        role: 'coordinator'
      })));
    }
    
    // Distribute simple tasks among other members
    const otherMembers = team.members.filter(m => this.getAgentKey(m) !== leaderKey);
    this.distributeTasksByCapability(simpleTasks, otherMembers, agentCapabilities, assignments);
    
    return assignments;
  }
  
  /**
   * Capability-based assignment
   */
  private async capabilityBasedAssignment(
    team: Team,
    subGoals: Goal[],
    agentCapabilities: Map<string, string[]>
  ): Promise<Map<AgentId, any[]>> {
    const assignments = new Map<AgentId, any[]>();
    
    for (const goal of subGoals) {
      const requiredCapabilities = this.analyzeRequiredCapabilities(goal);
      const bestAgent = this.findBestAgentForTask(team.members, requiredCapabilities, agentCapabilities);
      
      if (!assignments.has(bestAgent)) {
        assignments.set(bestAgent, []);
      }
      
      assignments.get(bestAgent)!.push({
        goalId: goal.id,
        description: goal.description,
        type: goal.type,
        priority: goal.priority,
        requiredCapabilities,
        assignmentReason: 'capability-match'
      });
    }
    
    return assignments;
  }
  
  /**
   * Matrix assignment for cross-functional collaboration
   */
  private async matrixAssignment(
    team: Team,
    subGoals: Goal[],
    agentCapabilities: Map<string, string[]>
  ): Promise<Map<AgentId, any[]>> {
    const assignments = new Map<AgentId, any[]>();
    
    // Create capability matrix
    const capabilityMatrix = this.createCapabilityMatrix(team.members, agentCapabilities);
    
    for (const goal of subGoals) {
      const requiredCapabilities = this.analyzeRequiredCapabilities(goal);
      
      if (requiredCapabilities.length > 1) {
        // Multi-capability task - assign to multiple agents
        const collaborativeAssignment = this.createCollaborativeAssignment(
          goal, 
          requiredCapabilities, 
          capabilityMatrix
        );
        
        for (const [agentId, taskPart] of collaborativeAssignment) {
          if (!assignments.has(agentId)) {
            assignments.set(agentId, []);
          }
          assignments.get(agentId)!.push(taskPart);
        }
      } else {
        // Single capability task - standard assignment
        const bestAgent = this.findBestAgentForTask(team.members, requiredCapabilities, agentCapabilities);
        
        if (!assignments.has(bestAgent)) {
          assignments.set(bestAgent, []);
        }
        
        assignments.get(bestAgent)!.push({
          goalId: goal.id,
          description: goal.description,
          type: goal.type,
          priority: goal.priority,
          role: 'primary'
        });
      }
    }
    
    return assignments;
  }
  
  /**
   * Dynamic assignment based on current workload and performance
   */
  private async dynamicAssignment(
    team: Team,
    subGoals: Goal[],
    agentCapabilities: Map<string, string[]>
  ): Promise<Map<AgentId, any[]>> {
    const assignments = new Map<AgentId, any[]>();
    
    // Get current workload for each agent
    const workloads = await this.getTeamWorkloads(team);
    
    // Sort goals by priority
    const sortedGoals = subGoals.sort((a, b) => {
      const priorityWeight = {
        'critical': 4,
        'high': 3,
        'medium': 2,
        'low': 1
      };
      return priorityWeight[b.priority] - priorityWeight[a.priority];
    });
    
    for (const goal of sortedGoals) {
      const requiredCapabilities = this.analyzeRequiredCapabilities(goal);
      
      // Find agent with matching capabilities and lowest workload
      const candidateAgents = team.members.filter(agent => {
        const agentKey = this.getAgentKey(agent);
        const capabilities = agentCapabilities.get(agentKey) || [];
        return this.hasRequiredCapabilities(capabilities, requiredCapabilities);
      });
      
      if (candidateAgents.length === 0) {
        // No perfect match - assign to least loaded agent
        const leastLoadedAgent = this.getLeastLoadedAgent(team.members, workloads);
        
        if (!assignments.has(leastLoadedAgent)) {
          assignments.set(leastLoadedAgent, []);
        }
        
        assignments.get(leastLoadedAgent)!.push({
          goalId: goal.id,
          description: goal.description,
          type: goal.type,
          priority: goal.priority,
          needsSupport: true,
          supportCapabilities: requiredCapabilities
        });
      } else {
        // Find least loaded among capable agents
        const bestAgent = this.getLeastLoadedAgent(candidateAgents, workloads);
        
        if (!assignments.has(bestAgent)) {
          assignments.set(bestAgent, []);
        }
        
        assignments.get(bestAgent)!.push({
          goalId: goal.id,
          description: goal.description,
          type: goal.type,
          priority: goal.priority,
          confidence: 'high'
        });
        
        // Update workload simulation
        const agentKey = this.getAgentKey(bestAgent);
        workloads.set(agentKey, (workloads.get(agentKey) || 0) + this.estimateTaskLoad(goal));
      }
    }
    
    return assignments;
  }
  
  /**
   * Utility methods for assignment algorithms
   */
  private analyzeGoalComplexity(goal: Goal): number {
    let complexity = 0;
    
    // Analyze description complexity
    const words = goal.description.toLowerCase().split(' ');
    const complexityIndicators = [
      'analyze', 'research', 'implement', 'design', 'create',
      'optimize', 'integrate', 'coordinate', 'synthesize'
    ];
    
    complexity += words.filter(word => 
      complexityIndicators.some(indicator => word.includes(indicator))
    ).length * 0.1;
    
    // Consider constraints
    complexity += (goal.constraints?.length || 0) * 0.05;
    
    // Consider sub-goals
    complexity += (goal.subGoals?.length || 0) * 0.1;
    
    // Consider dependencies
    complexity += goal.dependencies.length * 0.05;
    
    return Math.min(complexity, 1.0);
  }
  
  private identifyGoalPhases(goal: Goal): Array<{ description: string; constraints?: Constraint[] }> {
    const phases = [];
    const description = goal.description.toLowerCase();
    
    if (description.includes('research') || description.includes('analyze')) {
      phases.push({ description: `Research and analysis for: ${goal.description}` });
    }
    
    if (description.includes('design') || description.includes('plan')) {
      phases.push({ description: `Design and planning for: ${goal.description}` });
    }
    
    if (description.includes('implement') || description.includes('build') || description.includes('create')) {
      phases.push({ description: `Implementation of: ${goal.description}` });
    }
    
    if (description.includes('test') || description.includes('verify') || description.includes('validate')) {
      phases.push({ description: `Testing and validation for: ${goal.description}` });
    }
    
    return phases.length > 0 ? phases : [{ description: goal.description }];
  }
  
  private identifyParallelTasks(goal: Goal): Array<{ description: string; type?: string; priority?: GoalPriority; constraints?: Constraint[] }> {
    const tasks = [];
    const description = goal.description.toLowerCase();
    
    // Identify different aspects that can be worked on in parallel
    if (description.includes('data') || description.includes('information')) {
      tasks.push({ 
        description: `Data collection and preparation for: ${goal.description}`,
        type: 'data_task'
      });
    }
    
    if (description.includes('interface') || description.includes('ui') || description.includes('user')) {
      tasks.push({ 
        description: `User interface work for: ${goal.description}`,
        type: 'ui_task'
      });
    }
    
    if (description.includes('backend') || description.includes('server') || description.includes('api')) {
      tasks.push({ 
        description: `Backend development for: ${goal.description}`,
        type: 'backend_task'
      });
    }
    
    if (description.includes('documentation') || description.includes('docs')) {
      tasks.push({ 
        description: `Documentation for: ${goal.description}`,
        type: 'documentation_task',
        priority: GoalPriority.LOW
      });
    }
    
    return tasks.length > 0 ? tasks : [{ description: goal.description }];
  }
  
  private analyzeRequiredCapabilities(goal: Goal): string[] {
    const capabilities = [];
    const description = goal.description.toLowerCase();
    
    // Map keywords to capabilities
    const capabilityMap = {
      'research': ['research', 'analysis'],
      'analyze': ['analysis', 'data_processing'],
      'code': ['programming', 'software_development'],
      'implement': ['programming', 'implementation'],
      'design': ['design', 'architecture'],
      'write': ['writing', 'documentation'],
      'test': ['testing', 'quality_assurance'],
      'coordinate': ['coordination', 'project_management'],
      'ui': ['ui_design', 'frontend_development'],
      'backend': ['backend_development', 'server_management'],
      'data': ['data_processing', 'database_management']
    };
    
    for (const [keyword, caps] of Object.entries(capabilityMap)) {
      if (description.includes(keyword)) {
        capabilities.push(...caps);
      }
    }
    
    return [...new Set(capabilities)];
  }
  
  private findBestAgentForTask(
    agents: AgentId[],
    requiredCapabilities: string[],
    agentCapabilities: Map<string, string[]>
  ): AgentId {
    if (requiredCapabilities.length === 0) {
      return agents[0]; // Default to first agent
    }
    
    let bestAgent = agents[0];
    let bestScore = -1;
    
    for (const agent of agents) {
      const agentKey = this.getAgentKey(agent);
      const capabilities = agentCapabilities.get(agentKey) || [];
      
      const matchingCapabilities = requiredCapabilities.filter(req => 
        capabilities.some(cap => cap.toLowerCase().includes(req.toLowerCase()))
      );
      
      const score = matchingCapabilities.length / requiredCapabilities.length;
      
      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }
    
    return bestAgent;
  }
  
  private distributeTasksByCapability(
    tasks: Goal[],
    agents: AgentId[],
    agentCapabilities: Map<string, string[]>,
    assignments: Map<AgentId, any[]>
  ): void {
    for (const task of tasks) {
      const requiredCapabilities = this.analyzeRequiredCapabilities(task);
      const bestAgent = this.findBestAgentForTask(agents, requiredCapabilities, agentCapabilities);
      
      if (!assignments.has(bestAgent)) {
        assignments.set(bestAgent, []);
      }
      
      assignments.get(bestAgent)!.push({
        goalId: task.id,
        description: task.description,
        type: task.type,
        priority: task.priority,
        role: 'executor'
      });
    }
  }
  
  private createCapabilityMatrix(agents: AgentId[], agentCapabilities: Map<string, string[]>): Map<string, Set<string>> {
    const matrix = new Map<string, Set<string>>();
    
    for (const agent of agents) {
      const agentKey = this.getAgentKey(agent);
      const capabilities = agentCapabilities.get(agentKey) || [];
      matrix.set(agentKey, new Set(capabilities));
    }
    
    return matrix;
  }
  
  private createCollaborativeAssignment(
    goal: Goal,
    requiredCapabilities: string[],
    capabilityMatrix: Map<string, Set<string>>
  ): Map<AgentId, any> {
    const assignment = new Map<AgentId, any>();
    
    for (const capability of requiredCapabilities) {
      const capableAgents = Array.from(capabilityMatrix.entries())
        .filter(([_, caps]) => caps.has(capability))
        .map(([agentKey, _]) => agentKey);
      
      if (capableAgents.length > 0) {
        const selectedAgentKey = capableAgents[0]; // Simple selection
        const agentId = { id: selectedAgentKey.split(':')[1], namespace: selectedAgentKey.split(':')[0] };
        
        assignment.set(agentId, {
          goalId: goal.id,
          description: `${capability} work for: ${goal.description}`,
          type: goal.type,
          priority: goal.priority,
          role: 'collaborator',
          focus: capability
        });
      }
    }
    
    return assignment;
  }
  
  private async getTeamWorkloads(team: Team): Promise<Map<string, number>> {
    const workloads = new Map<string, number>();
    
    for (const member of team.members) {
      try {
        const response = await this.messageBus.sendAndWaitForResponse({
          id: uuidv4(),
          from: team.leader,
          to: member,
          type: MessageType.REQUEST,
          content: {
            topic: 'state:query',
            body: { requestId: uuidv4() }
          },
          timestamp: new Date(),
          priority: MessagePriority.NORMAL
        }, 3000);
        
        const agentKey = this.getAgentKey(member);
        workloads.set(agentKey, response.content.body.workload || 0);
      } catch (error) {
        const agentKey = this.getAgentKey(member);
        workloads.set(agentKey, 50); // Default moderate workload
      }
    }
    
    return workloads;
  }
  
  private hasRequiredCapabilities(agentCapabilities: string[], requiredCapabilities: string[]): boolean {
    return requiredCapabilities.some(required => 
      agentCapabilities.some(agent => agent.toLowerCase().includes(required.toLowerCase()))
    );
  }
  
  private getLeastLoadedAgent(agents: AgentId[], workloads: Map<string, number>): AgentId {
    let leastLoadedAgent = agents[0];
    let lowestWorkload = Infinity;
    
    for (const agent of agents) {
      const agentKey = this.getAgentKey(agent);
      const workload = workloads.get(agentKey) || 0;
      
      if (workload < lowestWorkload) {
        lowestWorkload = workload;
        leastLoadedAgent = agent;
      }
    }
    
    return leastLoadedAgent;
  }
  
  private estimateTaskLoad(goal: Goal): number {
    const complexity = this.analyzeGoalComplexity(goal);
    const priorityWeight = {
      'critical': 1.5,
      'high': 1.2,
      'medium': 1.0,
      'low': 0.8
    };
    
    return complexity * priorityWeight[goal.priority] * 20; // Base load of 20
  }
  
  private defaultAssignment(team: Team, subGoals: Goal[]): Map<AgentId, any[]> {
    const assignments = new Map<AgentId, any[]>();
    
    subGoals.forEach((subGoal, index) => {
      const assignedAgent = team.members[index % team.members.length];
      
      if (!assignments.has(assignedAgent)) {
        assignments.set(assignedAgent, []);
      }
      
      assignments.get(assignedAgent)!.push({
        goalId: subGoal.id,
        description: subGoal.description,
        type: subGoal.type,
        priority: subGoal.priority
      });
    });
    
    return assignments;
  }

  /**
   * Select best coordination strategy for current context
   */
  private selectStrategy(team: Team, goals: Goal[]): CoordinationStrategy {
    let bestStrategy: CoordinationStrategy | null = null;
    let bestScore = -1;
    
    const context: CoordinationContext = {
      team,
      currentGoals: goals,
      agentStates: new Map(),
      environment: {}
    };
    
    // Evaluate each strategy
    for (const strategy of this.strategies.values()) {
      const score = strategy.evaluate(context);
      if (score > bestScore) {
        bestScore = score;
        bestStrategy = strategy;
      }
    }
    
    // Default to team's formation strategy
    if (!bestStrategy) {
      bestStrategy = this.strategies.get(team.formation) || 
                   this.strategies.get('dynamic')!;
    }
    
    return bestStrategy;
  }

  /**
   * Update team status
   */
  public async updateTeamStatus(teamId: string, status: TeamStatus): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }
    
    const previousStatus = team.status;
    team.status = status;
    
    await this.notifyTeamUpdate(team, 'status:changed', { previousStatus, newStatus: status });
    
    this.logger.info('Updated team status', { teamId, previousStatus, newStatus: status });
    this.emit('team:statusChanged', { team, previousStatus, newStatus: status });
  }

  /**
   * Disband a team
   */
  public async disbandTeam(teamId: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }
    
    // Update status
    team.status = TeamStatus.DISBANDED;
    
    // Remove all members from team mapping
    team.members.forEach(member => {
      this.agentTeams.delete(this.getAgentKey(member));
    });
    
    // Notify members
    await this.notifyTeamUpdate(team, 'team:disbanded');
    
    // Remove team
    this.teams.delete(teamId);
    
    this.logger.info('Disbanded team', { teamId });
    this.emit('team:disbanded', team);
  }

  /**
   * Notify team members of updates
   */
  private async notifyTeamUpdate(
    team: Team,
    updateType: string,
    data?: any
  ): Promise<void> {
    const message: Message = {
      id: uuidv4(),
      from: team.leader,
      to: team.members,
      type: MessageType.INFORM,
      content: {
        topic: updateType,
        body: {
          teamId: team.id,
          teamName: team.name,
          ...data
        }
      },
      timestamp: new Date(),
      priority: MessagePriority.HIGH
    };
    
    await this.messageBus.send(message);
  }

  /**
   * Register a coordination strategy
   */
  public registerStrategy(strategy: CoordinationStrategy): void {
    this.strategies.set(strategy.type, strategy);
    this.logger.info('Registered coordination strategy', { type: strategy.type });
  }

  /**
   * Get team by ID
   */
  public getTeam(teamId: string): Team | undefined {
    return this.teams.get(teamId);
  }

  /**
   * Get team for agent
   */
  public getAgentTeam(agentId: AgentId): Team | undefined {
    const teamId = this.agentTeams.get(this.getAgentKey(agentId));
    return teamId ? this.teams.get(teamId) : undefined;
  }

  /**
   * Get all teams
   */
  public getAllTeams(): Team[] {
    return Array.from(this.teams.values());
  }

  /**
   * Get teams by status
   */
  public getTeamsByStatus(status: TeamStatus): Team[] {
    return Array.from(this.teams.values()).filter(team => team.status === status);
  }

  /**
   * Find teams capable of handling specific goal types
   */
  public findCapableTeams(requiredCapabilities: string[]): Team[] {
    // In real implementation, would check actual agent capabilities
    // For now, return all active teams
    return this.getTeamsByStatus(TeamStatus.ACTIVE);
  }

  /**
   * Get agent key for consistent identification
   */
  private getAgentKey(agentId: AgentId): string {
    return `${agentId.namespace || 'default'}:${agentId.id}`;
  }

  /**
   * Real-time performance-based team optimization
   */
  public async optimizeTeamFormation(teamId: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }
    
    // Get real performance metrics
    const performanceMetrics = await this.gatherTeamPerformanceMetrics(team);
    const agentStates = await this.getTeamStates(team);
    
    const context: CoordinationContext = {
      team,
      currentGoals: team.goals,
      agentStates,
      environment: {
        performance: performanceMetrics,
        timestamp: new Date()
      }
    };
    
    // Evaluate current formation
    const currentStrategy = this.strategies.get(team.formation);
    if (!currentStrategy) return;
    
    const currentScore = currentStrategy.evaluate(context);
    
    // Test all available strategies with current context
    let bestFormation = team.formation;
    let bestScore = currentScore;
    let bestStrategy: CoordinationStrategy | null = null;
    
    for (const [formationType, strategy] of this.strategies) {
      const score = strategy.evaluate(context);
      
      this.logger.debug('Strategy evaluation', {
        teamId,
        strategy: formationType,
        score,
        currentScore
      });
      
      if (score > bestScore) {
        bestScore = score;
        bestFormation = formationType as TeamFormation;
        bestStrategy = strategy;
      }
    }
    
    // Apply optimization if significant improvement found
    const improvementThreshold = 0.1; // 10% improvement required
    if (bestFormation !== team.formation && 
        (bestScore - currentScore) > improvementThreshold) {
      
      const previousFormation = team.formation;
      team.formation = bestFormation;
      
      // Implement formation change
      await this.implementFormationChange(team, previousFormation, bestFormation, bestStrategy!);
      
      await this.notifyTeamUpdate(team, 'formation:optimized', { 
        previousFormation,
        newFormation: bestFormation,
        improvement: bestScore - currentScore,
        performanceMetrics
      });
      
      this.logger.info('Team formation optimized', { 
        teamId, 
        previousFormation,
        newFormation: bestFormation,
        improvement: bestScore - currentScore
      });
    } else {
      this.logger.debug('No significant improvement found', {
        teamId,
        currentScore,
        bestScore,
        improvement: bestScore - currentScore
      });
    }
  }
  
  /**
   * Gather real performance metrics from team members
   */
  private async gatherTeamPerformanceMetrics(team: Team): Promise<any> {
    const metrics = {
      completionRate: 0,
      averageResponseTime: 0,
      errorRate: 0,
      collaborationScore: 0,
      workloadBalance: 0
    };
    
    let successfulResponses = 0;
    
    for (const member of team.members) {
      try {
        const response = await this.messageBus.sendAndWaitForResponse({
          id: uuidv4(),
          from: team.leader,
          to: member,
          type: MessageType.REQUEST,
          content: {
            topic: 'performance:metrics',
            body: { timeframe: '1h' }
          },
          timestamp: new Date(),
          priority: MessagePriority.NORMAL
        }, 5000);
        
        const agentMetrics = response.content.body;
        
        // Aggregate metrics
        metrics.completionRate += agentMetrics.tasksCompleted || 0;
        metrics.averageResponseTime += agentMetrics.averageResponseTime || 0;
        metrics.errorRate += agentMetrics.errorRate || 0;
        
        successfulResponses++;
      } catch (error) {
        this.logger.warn('Failed to get performance metrics', { 
          member: this.getAgentKey(member),
          error 
        });
      }
    }
    
    // Calculate averages
    if (successfulResponses > 0) {
      metrics.completionRate /= successfulResponses;
      metrics.averageResponseTime /= successfulResponses;
      metrics.errorRate /= successfulResponses;
    }
    
    // Calculate collaboration score based on message patterns
    metrics.collaborationScore = await this.calculateCollaborationScore(team);
    
    // Calculate workload balance
    metrics.workloadBalance = await this.calculateWorkloadBalance(team);
    
    return metrics;
  }
  
  /**
   * Get current states of all team members
   */
  private async getTeamStates(team: Team): Promise<Map<string, AgentStateEnum>> {
    const states = new Map<string, AgentStateEnum>();
    
    for (const member of team.members) {
      try {
        const response = await this.messageBus.sendAndWaitForResponse({
          id: uuidv4(),
          from: team.leader,
          to: member,
          type: MessageType.REQUEST,
          content: {
            topic: 'state:query',
            body: {}
          },
          timestamp: new Date(),
          priority: MessagePriority.NORMAL
        }, 3000);
        
        const agentKey = this.getAgentKey(member);
        states.set(agentKey, response.content.body.state || AgentStateEnum.IDLE);
      } catch (error) {
        const agentKey = this.getAgentKey(member);
        states.set(agentKey, AgentStateEnum.IDLE);
      }
    }
    
    return states;
  }
  
  /**
   * Implement formation change with coordination
   */
  private async implementFormationChange(
    team: Team,
    previousFormation: TeamFormation,
    newFormation: TeamFormation,
    strategy: CoordinationStrategy
  ): Promise<void> {
    // Notify all team members of formation change
    await this.notifyTeamUpdate(team, 'formation:changing', {
      previousFormation,
      newFormation,
      strategy: strategy.type
    });
    
    // Reorganize based on new formation
    switch (newFormation) {
      case TeamFormation.HIERARCHICAL:
        await this.implementHierarchicalStructure(team);
        break;
      case TeamFormation.FLAT:
        await this.implementFlatStructure(team);
        break;
      case TeamFormation.MATRIX:
        await this.implementMatrixStructure(team);
        break;
      case TeamFormation.DYNAMIC:
        await this.implementDynamicStructure(team);
        break;
    }
    
    // Update coordination patterns
    await this.updateCoordinationPatterns(team, newFormation);
  }
  
  /**
   * Calculate collaboration score based on message patterns
   */
  private async calculateCollaborationScore(team: Team): Promise<number> {
    const coordinationMetrics = this.messageBus.getCoordinationMetrics();
    
    // Simple collaboration scoring based on communication patterns
    const messageCount = coordinationMetrics.messageCount;
    const responseTime = coordinationMetrics.averageResponseTime;
    const activeAgents = coordinationMetrics.activeAgents;
    
    // Normalize and combine metrics
    const messageScore = Math.min(messageCount / 100, 1); // Up to 100 messages is good
    const responseScore = Math.max(0, 1 - (responseTime / 10000)); // Under 10 seconds is good
    const participationScore = activeAgents / team.members.length;
    
    return (messageScore + responseScore + participationScore) / 3;
  }
  
  /**
   * Calculate workload balance across team
   */
  private async calculateWorkloadBalance(team: Team): Promise<number> {
    const workloads = await this.getTeamWorkloads(team);
    const workloadValues = Array.from(workloads.values());
    
    if (workloadValues.length === 0) return 1;
    
    const average = workloadValues.reduce((sum, val) => sum + val, 0) / workloadValues.length;
    const variance = workloadValues.reduce((sum, val) => sum + Math.pow(val - average, 2), 0) / workloadValues.length;
    const standardDeviation = Math.sqrt(variance);
    
    // Lower standard deviation = better balance
    // Normalize to 0-1 scale where 1 is perfect balance
    return Math.max(0, 1 - (standardDeviation / 50)); // 50 is reasonable max deviation
  }
  
  /**
   * Formation-specific implementation methods
   */
  private async implementHierarchicalStructure(team: Team): Promise<void> {
    // Set up clear reporting structure
    await this.messageBus.send({
      id: uuidv4(),
      from: team.leader,
      to: team.members.filter(m => this.getAgentKey(m) !== this.getAgentKey(team.leader)),
      type: MessageType.INFORM,
      content: {
        topic: 'structure:hierarchical',
        body: {
          leader: team.leader,
          reportingStructure: 'centralized',
          decisionMaking: 'top-down'
        }
      },
      timestamp: new Date(),
      priority: MessagePriority.HIGH
    });
  }
  
  private async implementFlatStructure(team: Team): Promise<void> {
    // Enable peer-to-peer communication
    await this.messageBus.send({
      id: uuidv4(),
      from: team.leader,
      to: team.members,
      type: MessageType.INFORM,
      content: {
        topic: 'structure:flat',
        body: {
          communicationPattern: 'peer-to-peer',
          decisionMaking: 'consensus',
          autonomy: 'high'
        }
      },
      timestamp: new Date(),
      priority: MessagePriority.HIGH
    });
  }
  
  private async implementMatrixStructure(team: Team): Promise<void> {
    // Set up cross-functional collaboration
    await this.messageBus.send({
      id: uuidv4(),
      from: team.leader,
      to: team.members,
      type: MessageType.INFORM,
      content: {
        topic: 'structure:matrix',
        body: {
          collaborationPattern: 'cross-functional',
          reportingStructure: 'dual',
          taskAllocation: 'capability-based'
        }
      },
      timestamp: new Date(),
      priority: MessagePriority.HIGH
    });
  }
  
  private async implementDynamicStructure(team: Team): Promise<void> {
    // Enable adaptive coordination
    await this.messageBus.send({
      id: uuidv4(),
      from: team.leader,
      to: team.members,
      type: MessageType.INFORM,
      content: {
        topic: 'structure:dynamic',
        body: {
          adaptationEnabled: true,
          restructuringTriggers: ['performance', 'workload', 'capabilities'],
          evaluationInterval: '15m'
        }
      },
      timestamp: new Date(),
      priority: MessagePriority.HIGH
    });
  }
  
  private async updateCoordinationPatterns(team: Team, formation: TeamFormation): Promise<void> {
    // Update message routing and coordination rules based on new formation
    const patterns = {
      [TeamFormation.HIERARCHICAL]: 'hub-and-spoke',
      [TeamFormation.FLAT]: 'mesh',
      [TeamFormation.MATRIX]: 'hybrid',
      [TeamFormation.DYNAMIC]: 'adaptive'
    };
    
    await this.messageBus.send({
      id: uuidv4(),
      from: team.leader,
      to: team.members,
      type: MessageType.INFORM,
      content: {
        topic: 'coordination:pattern_updated',
        body: {
          pattern: patterns[formation],
          formation,
          effectiveAt: new Date()
        }
      },
      timestamp: new Date(),
      priority: MessagePriority.HIGH
    });
  }
}