import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import {
  Message,
  AgentId,
  MessageType,
  MessagePriority,
  MessageContent
} from '../types';
import { Logger } from '../utils/logger';
import { MessageRouter } from './message-router';
import { MessageQueue } from './message-queue';

/**
 * Central message bus for inter-agent communication
 */
export class MessageBus extends EventEmitter {
  private static instance: MessageBus;
  private readonly logger: Logger;
  private readonly router: MessageRouter;
  private readonly queues: Map<string, MessageQueue>;
  private readonly subscribers: Map<string, (message: Message) => Promise<void>>;
  private readonly messageHistory: Message[];
  private readonly maxHistorySize: number = 1000;

  private constructor() {
    super();
    this.logger = new Logger('MessageBus');
    this.router = new MessageRouter();
    this.queues = new Map();
    this.subscribers = new Map();
    this.messageHistory = [];
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): MessageBus {
    if (!MessageBus.instance) {
      MessageBus.instance = new MessageBus();
    }
    return MessageBus.instance;
  }

  /**
   * Register an agent with the message bus
   */
  public async registerAgent(agentId: AgentId): Promise<void> {
    const key = this.getAgentKey(agentId);
    
    if (this.queues.has(key)) {
      throw new Error(`Agent already registered: ${key}`);
    }
    
    // Create message queue for agent
    const queue = new MessageQueue(agentId);
    this.queues.set(key, queue);
    
    // Register with router
    this.router.registerAgent(agentId);
    
    this.logger.info('Agent registered', { agentId: key });
    this.emit('agent:registered', agentId);
  }

  /**
   * Unregister an agent from the message bus
   */
  public async unregisterAgent(agentId: AgentId): Promise<void> {
    const key = this.getAgentKey(agentId);
    
    // Remove queue
    const queue = this.queues.get(key);
    if (queue) {
      queue.clear();
      this.queues.delete(key);
    }
    
    // Remove subscriber
    this.subscribers.delete(key);
    
    // Unregister from router
    this.router.unregisterAgent(agentId);
    
    this.logger.info('Agent unregistered', { agentId: key });
    this.emit('agent:unregistered', agentId);
  }

  /**
   * Subscribe to messages for an agent
   */
  public subscribe(
    agentId: AgentId,
    handler: (message: Message) => Promise<void>
  ): void {
    const key = this.getAgentKey(agentId);
    this.subscribers.set(key, handler);
    
    // Process any queued messages
    const queue = this.queues.get(key);
    if (queue) {
      this.processQueuedMessages(agentId, handler);
    }
  }

  /**
   * Unsubscribe from messages
   */
  public unsubscribe(agentId: AgentId): void {
    const key = this.getAgentKey(agentId);
    this.subscribers.delete(key);
  }

  /**
   * Send a message
   */
  public async send(message: Message): Promise<void> {
    try {
      // Validate message
      this.validateMessage(message);
      
      // Add to history
      this.addToHistory(message);
      
      // Route message
      const recipients = await this.router.route(message);
      
      if (recipients.length === 0) {
        this.logger.warn('No recipients found for message', { messageId: message.id });
        this.emit('message:undelivered', message);
        return;
      }
      
      // Deliver to recipients
      for (const recipient of recipients) {
        await this.deliverMessage(message, recipient);
      }
      
      this.logger.debug('Message sent', { 
        messageId: message.id, 
        recipientCount: recipients.length 
      });
      
      this.emit('message:sent', message);
    } catch (error) {
      this.logger.error('Failed to send message', error);
      this.emit('message:error', { message, error });
      throw error;
    }
  }

  /**
   * Broadcast a message to all agents
   */
  public async broadcast(
    from: AgentId,
    type: MessageType,
    content: MessageContent,
    priority: MessagePriority = MessagePriority.NORMAL
  ): Promise<void> {
    const message: Message = {
      id: uuidv4(),
      from,
      to: [], // Empty array indicates broadcast
      type,
      content,
      timestamp: new Date(),
      priority
    };
    
    await this.send(message);
  }

  /**
   * Reply to a message
   */
  public async reply(
    originalMessage: Message,
    from: AgentId,
    type: MessageType,
    content: MessageContent,
    priority?: MessagePriority
  ): Promise<void> {
    const replyMessage: Message = {
      id: uuidv4(),
      from,
      to: originalMessage.from,
      type,
      content,
      timestamp: new Date(),
      replyTo: originalMessage.id,
      priority: priority || originalMessage.priority
    };
    
    await this.send(replyMessage);
    
    // Emit response event for request-response pattern
    if (type === MessageType.RESPONSE) {
      this.emit(`response:${originalMessage.id}`, replyMessage);
    }
  }

  /**
   * Enhanced message delivery with coordination tracking
   */
  private async deliverMessage(message: Message, recipient: AgentId): Promise<void> {
    const key = this.getAgentKey(recipient);
    const handler = this.subscribers.get(key);
    
    if (handler) {
      // Direct delivery
      try {
        await handler(message);
        this.emit('message:delivered', { message, recipient });
        
        // Also emit the message for coordination patterns
        this.emit('message:delivered', message);
      } catch (error) {
        this.logger.error('Handler failed to process message', error);
        this.emit('message:handlerError', { message, recipient, error });
      }
    } else {
      // Queue for later delivery
      const queue = this.queues.get(key);
      if (queue) {
        queue.enqueue(message);
        this.logger.debug('Message queued for offline agent', { 
          messageId: message.id, 
          agentId: key 
        });
        this.emit('message:queued', { message, recipient });
      } else {
        this.logger.warn('No queue found for recipient', { agentId: key });
        this.emit('message:undeliverable', { message, recipient });
      }
    }
  }

  /**
   * Process queued messages for an agent
   */
  private async processQueuedMessages(
    agentId: AgentId,
    handler: (message: Message) => Promise<void>
  ): Promise<void> {
    const key = this.getAgentKey(agentId);
    const queue = this.queues.get(key);
    
    if (!queue) return;
    
    const messages = queue.dequeueAll();
    this.logger.info('Processing queued messages', { 
      agentId: key, 
      count: messages.length 
    });
    
    for (const message of messages) {
      try {
        await handler(message);
        this.emit('message:delivered', { message, recipient: agentId });
      } catch (error) {
        this.logger.error('Failed to process queued message', error);
        this.emit('message:handlerError', { message, recipient: agentId, error });
      }
    }
  }

  /**
   * Validate message
   */
  private validateMessage(message: Message): void {
    if (!message.id) {
      throw new Error('Message must have an ID');
    }
    
    if (!message.from) {
      throw new Error('Message must have a sender');
    }
    
    if (!message.type) {
      throw new Error('Message must have a type');
    }
    
    if (!message.content) {
      throw new Error('Message must have content');
    }
  }

  /**
   * Add message to history
   */
  private addToHistory(message: Message): void {
    this.messageHistory.push(message);
    
    // Trim history if needed
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }
  }

  /**
   * Get message history
   */
  public getHistory(filter?: {
    from?: AgentId;
    to?: AgentId;
    type?: MessageType;
    since?: Date;
  }): Message[] {
    let history = [...this.messageHistory];
    
    if (filter) {
      if (filter.from) {
        const fromKey = this.getAgentKey(filter.from);
        history = history.filter(m => this.getAgentKey(m.from) === fromKey);
      }
      
      if (filter.to) {
        const toKey = this.getAgentKey(filter.to);
        history = history.filter(m => {
          if (Array.isArray(m.to)) {
            return m.to.some(t => this.getAgentKey(t) === toKey);
          }
          return this.getAgentKey(m.to) === toKey;
        });
      }
      
      if (filter.type) {
        history = history.filter(m => m.type === filter.type);
      }
      
      if (filter.since) {
        history = history.filter(m => m.timestamp >= filter.since!);
      }
    }
    
    return history;
  }

  /**
   * Get agent key for consistent identification
   */
  private getAgentKey(agentId: AgentId): string {
    return `${agentId.namespace || 'default'}:${agentId.id}`;
  }

  /**
   * Get queue status for an agent
   */
  public getQueueStatus(agentId: AgentId): { size: number; messages: Message[] } {
    const key = this.getAgentKey(agentId);
    const queue = this.queues.get(key);
    
    if (!queue) {
      return { size: 0, messages: [] };
    }
    
    return {
      size: queue.size(),
      messages: queue.peek()
    };
  }

  /**
   * Clear all messages for an agent
   */
  public clearAgentMessages(agentId: AgentId): void {
    const key = this.getAgentKey(agentId);
    const queue = this.queues.get(key);
    
    if (queue) {
      queue.clear();
    }
  }

  /**
   * Get registered agents
   */
  public getRegisteredAgents(): AgentId[] {
    return this.router.getRegisteredAgents();
  }
  
  // ========================
  // ENHANCED COORDINATION FEATURES
  // ========================
  
  /**
   * Send request and wait for response
   */
  public async sendAndWaitForResponse(
    message: Message,
    timeoutMs: number = 30000
  ): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.removeListener(`response:${message.id}`, responseHandler);
        reject(new Error(`Response timeout for message ${message.id}`));
      }, timeoutMs);
      
      const responseHandler = (response: Message) => {
        clearTimeout(timeoutId);
        resolve(response);
      };
      
      this.once(`response:${message.id}`, responseHandler);
      
      this.send(message).catch(error => {
        clearTimeout(timeoutId);
        this.removeListener(`response:${message.id}`, responseHandler);
        reject(error);
      });
    });
  }
  
  
  /**
   * Coordinate synchronous message exchange between agents
   */
  public async coordinatedExchange(
    initiator: AgentId,
    participants: AgentId[],
    topic: string,
    data: any,
    timeoutMs: number = 60000
  ): Promise<Map<string, any>> {
    const exchangeId = uuidv4();
    const responses = new Map<string, any>();
    const pendingResponses = new Set(participants.map(p => this.getAgentKey(p)));
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Coordinated exchange timeout: ${exchangeId}`));
      }, timeoutMs);
      
      const responseHandler = (message: Message) => {
        if (message.content.topic === `${topic}:response` && 
            message.content.body.exchangeId === exchangeId) {
          const senderKey = this.getAgentKey(message.from);
          responses.set(senderKey, message.content.body);
          pendingResponses.delete(senderKey);
          
          if (pendingResponses.size === 0) {
            clearTimeout(timeoutId);
            this.removeListener('message:delivered', responseHandler);
            resolve(responses);
          }
        }
      };
      
      this.on('message:delivered', responseHandler);
      
      // Send coordination message to all participants
      const coordinationMessage: Message = {
        id: uuidv4(),
        from: initiator,
        to: participants,
        type: MessageType.REQUEST,
        content: {
          topic,
          body: {
            exchangeId,
            data,
            requiredResponse: true,
            deadline: new Date(Date.now() + timeoutMs)
          }
        },
        timestamp: new Date(),
        priority: MessagePriority.HIGH
      };
      
      this.send(coordinationMessage).catch(error => {
        clearTimeout(timeoutId);
        this.removeListener('message:delivered', responseHandler);
        reject(error);
      });
    });
  }
  
  /**
   * Implement barrier synchronization for coordinated actions
   */
  public async barrierSync(
    participants: AgentId[],
    barrierName: string,
    timeoutMs: number = 30000
  ): Promise<void> {
    const barrierId = `${barrierName}_${Date.now()}`;
    const arrivedAgents = new Set<string>();
    const requiredCount = participants.length;
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Barrier synchronization timeout: ${barrierId}`));
      }, timeoutMs);
      
      const arrivalHandler = (message: Message) => {
        if (message.content.topic === 'barrier:arrival' && 
            message.content.body.barrierId === barrierId) {
          const agentKey = this.getAgentKey(message.from);
          arrivedAgents.add(agentKey);
          
          this.logger.debug('Agent arrived at barrier', { 
            agentKey, 
            barrierId, 
            arrived: arrivedAgents.size, 
            required: requiredCount 
          });
          
          if (arrivedAgents.size === requiredCount) {
            clearTimeout(timeoutId);
            this.removeListener('message:delivered', arrivalHandler);
            
            // Notify all participants that barrier is released
            this.broadcast(
              { id: 'barrier_coordinator', namespace: 'system' },
              MessageType.INFORM,
              {
                topic: 'barrier:released',
                body: { barrierId, participants: Array.from(arrivedAgents) }
              },
              MessagePriority.HIGH
            );
            
            resolve();
          }
        }
      };
      
      this.on('message:delivered', arrivalHandler);
      
      // Send barrier setup message to all participants
      const barrierMessage: Message = {
        id: uuidv4(),
        from: { id: 'barrier_coordinator', namespace: 'system' },
        to: participants,
        type: MessageType.INFORM,
        content: {
          topic: 'barrier:setup',
          body: {
            barrierId,
            participants: participants.map(p => this.getAgentKey(p)),
            deadline: new Date(Date.now() + timeoutMs)
          }
        },
        timestamp: new Date(),
        priority: MessagePriority.HIGH
      };
      
      this.send(barrierMessage).catch(error => {
        clearTimeout(timeoutId);
        this.removeListener('message:delivered', arrivalHandler);
        reject(error);
      });
    });
  }
  
  /**
   * Implement consensus mechanism for distributed decision making
   */
  public async reachConsensus(
    participants: AgentId[],
    proposal: any,
    consensusThreshold: number = 0.67,
    timeoutMs: number = 60000
  ): Promise<{ success: boolean; votes: Map<string, boolean>; consensus?: any }> {
    const consensusId = uuidv4();
    const votes = new Map<string, boolean>();
    const responses = new Map<string, any>();
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const success = this.evaluateConsensus(votes, consensusThreshold);
        resolve({ success: false, votes, consensus: success ? proposal : undefined });
      }, timeoutMs);
      
      const voteHandler = (message: Message) => {
        if (message.content.topic === 'consensus:vote' && 
            message.content.body.consensusId === consensusId) {
          const agentKey = this.getAgentKey(message.from);
          const vote = message.content.body.vote;
          const response = message.content.body.response;
          
          votes.set(agentKey, vote);
          responses.set(agentKey, response);
          
          this.logger.debug('Vote received', { 
            agentKey, 
            vote, 
            consensusId,
            totalVotes: votes.size,
            required: participants.length
          });
          
          if (votes.size === participants.length) {
            clearTimeout(timeoutId);
            this.removeListener('message:delivered', voteHandler);
            
            const success = this.evaluateConsensus(votes, consensusThreshold);
            const consensus = success ? this.mergeConsensusResponses(responses) : undefined;
            
            // Notify all participants of consensus result
            this.broadcast(
              { id: 'consensus_coordinator', namespace: 'system' },
              MessageType.INFORM,
              {
                topic: 'consensus:result',
                body: {
                  consensusId,
                  success,
                  votes: Object.fromEntries(votes),
                  consensus
                }
              },
              MessagePriority.HIGH
            );
            
            resolve({ success, votes, consensus });
          }
        }
      };
      
      this.on('message:delivered', voteHandler);
      
      // Send consensus proposal to all participants
      const proposalMessage: Message = {
        id: uuidv4(),
        from: { id: 'consensus_coordinator', namespace: 'system' },
        to: participants,
        type: MessageType.REQUEST,
        content: {
          topic: 'consensus:proposal',
          body: {
            consensusId,
            proposal,
            threshold: consensusThreshold,
            deadline: new Date(Date.now() + timeoutMs)
          }
        },
        timestamp: new Date(),
        priority: MessagePriority.HIGH
      };
      
      this.send(proposalMessage).catch(error => {
        clearTimeout(timeoutId);
        this.removeListener('message:delivered', voteHandler);
        reject(error);
      });
    });
  }
  
  /**
   * Pipeline coordination for sequential task execution
   */
  public async coordinatePipeline(
    stages: { agentId: AgentId; task: any }[],
    initialData: any,
    timeoutMs: number = 120000
  ): Promise<any> {
    let currentData = initialData;
    
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const stageId = uuidv4();
      
      try {
        const stageMessage: Message = {
          id: uuidv4(),
          from: { id: 'pipeline_coordinator', namespace: 'system' },
          to: stage.agentId,
          type: MessageType.COMMAND,
          content: {
            topic: 'pipeline:stage',
            body: {
              stageId,
              stageNumber: i + 1,
              totalStages: stages.length,
              task: stage.task,
              inputData: currentData,
              deadline: new Date(Date.now() + timeoutMs / stages.length)
            }
          },
          timestamp: new Date(),
          priority: MessagePriority.HIGH
        };
        
        const response = await this.sendAndWaitForResponse(stageMessage, timeoutMs / stages.length);
        currentData = response.content.body.outputData;
        
        this.logger.info('Pipeline stage completed', { 
          stageId, 
          stageNumber: i + 1, 
          agentId: this.getAgentKey(stage.agentId) 
        });
        
      } catch (error) {
        this.logger.error('Pipeline stage failed', { 
          stageNumber: i + 1, 
          agentId: this.getAgentKey(stage.agentId), 
          error 
        });
        throw new Error(`Pipeline failed at stage ${i + 1}: ${error}`);
      }
    }
    
    return currentData;
  }
  
  /**
   * Monitor message flow and detect coordination issues
   */
  public getCoordinationMetrics(): {
    messageCount: number;
    averageResponseTime: number;
    failureRate: number;
    activeAgents: number;
    queueSizes: Map<string, number>;
  } {
    const now = Date.now();
    const recentMessages = this.messageHistory.filter(
      m => now - m.timestamp.getTime() < 60000 // Last minute
    );
    
    const responseMessages = recentMessages.filter(m => m.replyTo);
    const averageResponseTime = responseMessages.length > 0 ?
      responseMessages.reduce((sum, m) => {
        const original = this.messageHistory.find(orig => orig.id === m.replyTo);
        return sum + (original ? m.timestamp.getTime() - original.timestamp.getTime() : 0);
      }, 0) / responseMessages.length : 0;
    
    const queueSizes = new Map<string, number>();
    for (const [key, queue] of this.queues) {
      queueSizes.set(key, queue.size());
    }
    
    return {
      messageCount: recentMessages.length,
      averageResponseTime,
      failureRate: 0, // Would track actual failures
      activeAgents: this.router.getRegisteredAgents().length,
      queueSizes
    };
  }
  
  /**
   * Utility methods for consensus and coordination
   */
  private evaluateConsensus(votes: Map<string, boolean>, threshold: number): boolean {
    if (votes.size === 0) return false;
    
    const positiveVotes = Array.from(votes.values()).filter(v => v).length;
    return (positiveVotes / votes.size) >= threshold;
  }
  
  private mergeConsensusResponses(responses: Map<string, any>): any {
    // Simple consensus merging - can be enhanced based on requirements
    const allResponses = Array.from(responses.values());
    if (allResponses.length === 0) return null;
    
    // For now, return the most common response
    const responseCount = new Map<string, number>();
    allResponses.forEach(response => {
      const key = JSON.stringify(response);
      responseCount.set(key, (responseCount.get(key) || 0) + 1);
    });
    
    let maxCount = 0;
    let consensusResponse = null;
    for (const [responseKey, count] of responseCount) {
      if (count > maxCount) {
        maxCount = count;
        consensusResponse = JSON.parse(responseKey);
      }
    }
    
    return consensusResponse;
  }
}