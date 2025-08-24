import { Service } from 'typedi';
import { Server as SocketIOServer } from 'socket.io';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { SECRET_KEY } from '@config';
import { ChatMessageModel, ChatSessionModel } from '@models/chat.model';
import { DatabaseAgentService } from './database-agent.service';
import { AIMemoryService } from './ai-memory.service';
import { ChatMessage, ChatSession, WebSocketEvents, ChatServiceConfig } from '@interfaces/chat.interface';
import { logger } from '@utils/logger';

import { Socket } from 'socket.io';
import { Document } from 'mongoose';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  user?: any;
}

@Service()
export class WebSocketChatService {
  private io: SocketIOServer;
  private databaseAgent: DatabaseAgentService;
  private memoryService: AIMemoryService;
  private activeSessions: Map<string, Set<string>> = new Map(); // sessionId -> Set of socketIds
  private userSockets: Map<string, string> = new Map(); // userId -> socketId
  private config: ChatServiceConfig = {
    maxMessagesPerSession: 1000,
    maxSessionsPerUser: 10,
    sessionTimeoutMinutes: 60,
    enableTypingIndicator: true,
    enableThinkingProcess: true,
  };

  constructor() {
    this.databaseAgent = new DatabaseAgentService();
    this.memoryService = new AIMemoryService();
  }

  public initialize(server: Server): void {
    this.io = new SocketIOServer(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    // Authentication middleware
    this.io.use(async (socket: AuthenticatedSocket, next) => {
      try {
        const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];

        if (!token) {
          return next(new Error('Authentication required'));
        }

        const decoded = jwt.verify(token, SECRET_KEY) as any;
        // Support tokens storing user id as _id (our AuthService) or id
        socket.userId = decoded._id || decoded.id;
        socket.user = decoded;

        logger.info(`WebSocket authenticated: User ${socket.userId}`);
        next();
      } catch (error) {
        logger.error(`WebSocket authentication failed: ${error.message}`);
        next(new Error('Authentication failed'));
      }
    });

    this.setupEventHandlers();
    logger.info('WebSocket Chat Service initialized');
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket: AuthenticatedSocket) => {
      logger.info(`WebSocket connected: ${socket.id}, User: ${socket.userId}`);

      if (socket.userId) {
        this.userSockets.set(socket.userId, socket.id);
      }

      // Handle joining a chat session
      socket.on('join-session', async (data: WebSocketEvents['join-session']) => {
        try {
          const { sessionId, userId } = data;

          if (userId !== socket.userId) {
            socket.emit('error', { message: 'Unauthorized access to session' });
            return;
          }

          // Get or create session
          let session = await ChatSessionModel.findOne({ id: sessionId, userId });

          if (!session) {
            session = await this.createSession(userId, 'Chat Session', sessionId);
          }

          // Join the session room
          socket.join(sessionId);

          // Track active session
          if (!this.activeSessions.has(sessionId)) {
            this.activeSessions.set(sessionId, new Set());
          }
          this.activeSessions.get(sessionId)?.add(socket.id);

          // Update session activity
          session.lastActivity = new Date();
          await session.save();

          socket.emit('session-joined', { sessionId, session: session.toObject() });
          logger.info(`User ${userId} joined session ${sessionId}`);
        } catch (error) {
          logger.error(`Error joining session: ${error.message}`);
          socket.emit('error', { message: 'Failed to join session' });
        }
      });

      // Handle sending messages
      socket.on('send-message', async (data: WebSocketEvents['send-message']) => {
        try {
          const { message, sessionId, dbUrl, dbType, dryRun } = data;
          const userId = socket.userId;

          // Validate session access
          const session = await ChatSessionModel.findOne({ id: sessionId, userId });
          if (!session) {
            socket.emit('error', { message: 'Session not found' });
            return;
          }

          // Create user message
          const userMessage = await this.createMessage({
            userId,
            sessionId,
            message,
            type: 'user',
          });

          // Broadcast user message to session
          this.io.to(sessionId).emit('message-received', userMessage);

          // Show thinking indicator
          if (this.config.enableThinkingProcess) {
            this.io.to(sessionId).emit('agent-thinking', {
              message: 'Analyzing your request...',
              sessionId,
            });
          }

          // Get conversation history
          const conversationHistory = await ChatMessageModel.find({ sessionId }).sort({ createdAt: -1 }).limit(20).lean();

          // Process message
          let agentResponse;
          if (dbUrl) {
            // If DB URL provided in chat, route to the new AI Agent multi-DB flow directly
            const aiAgent = new (require('./ai-agent.service').AIAgentService)();
            const result = await aiAgent.processQuery(message, userId, { dbUrl, dbType: dbType as any, dryRun });
            agentResponse = {
              message: result.message || (typeof result?.data === 'object' ? JSON.stringify(result.data) : String(result?.data ?? '')),
              type: dryRun ? 'text' : 'data',
              data: result.data,
              toolsUsed: ['ai-agent'],
              executionTime: result.executionTime,
              confidence: 0.8,
              plan: result.plan,
              trace: result.trace,
              executedQueries: result.executedQueries,
            } as any;
          } else {
            // Fallback to the existing database agent workflow
            agentResponse = await this.databaseAgent.processMessage(message, userId, sessionId, conversationHistory.reverse());
          }

          // Create agent message
          const agentMessage = await this.createMessage({
            userId: 'agent',
            sessionId,
            message: agentResponse.message,
            type: 'agent',
            metadata: {
              queryType: agentResponse.type,
              executionTime: agentResponse.executionTime,
              dataRetrieved: !!agentResponse.data,
              toolsUsed: agentResponse.toolsUsed,
              confidence: agentResponse.confidence,
            },
          });

          // Update session
          session.messageCount += 2; // user + agent message
          session.lastActivity = new Date();

          // Update context
          if (!session.context) session.context = {};
          session.context.recentQueries = [message, ...(session.context.recentQueries || []).slice(0, 4)];

          await session.save();

          // Record in memory system
          await this.memoryService.recordQuery(
            userId,
            message,
            agentResponse.message,
            'find', // This would be determined by the agent
            ['chat'],
            agentResponse.executionTime || 0,
            agentResponse.data ? (Array.isArray(agentResponse.data) ? agentResponse.data.length : 1) : 0,
            agentResponse.type !== 'error',
          );

          // Send agent response
          this.io.to(sessionId).emit('message-received', agentMessage);
          this.io.to(sessionId).emit('agent-response', {
            response: agentResponse,
            sessionId,
          });

          logger.info(`Message processed for session ${sessionId}`);
        } catch (error) {
          logger.error(`Error processing message: ${error.message}`);
          socket.emit('error', { message: 'Failed to process message' });
        }
      });

      // Handle typing indicators
      socket.on('typing', (data: WebSocketEvents['typing']) => {
        if (this.config.enableTypingIndicator) {
          socket.to(data.sessionId).emit('typing-indicator', {
            userId: socket.userId || 'unknown',
            isTyping: data.isTyping,
            sessionId: data.sessionId,
          });
        }
      });

      // Handle getting user sessions
      socket.on('get-sessions', async (data: WebSocketEvents['get-sessions']) => {
        try {
          const { userId } = data;

          if (userId !== socket.userId) {
            socket.emit('error', { message: 'Unauthorized' });
            return;
          }

          const sessions = await ChatSessionModel.find({ userId, isActive: true })
            .sort({ lastActivity: -1 })
            .limit(this.config.maxSessionsPerUser)
            .lean();

          socket.emit('sessions-list', { sessions });
        } catch (error) {
          logger.error(`Error getting sessions: ${error.message}`);
          socket.emit('error', { message: 'Failed to get sessions' });
        }
      });

      // Handle creating new session
      socket.on('create-session', async (data: WebSocketEvents['create-session']) => {
        try {
          const { userId, title } = data;

          if (userId !== socket.userId) {
            socket.emit('error', { message: 'Unauthorized' });
            return;
          }

          const session = await this.createSession(userId, title);
          socket.emit('session-created', { session: session.toObject() });
        } catch (error) {
          logger.error(`Error creating session: ${error.message}`);
          socket.emit('error', { message: 'Failed to create session' });
        }
      });

      // Handle deleting session
      socket.on('delete-session', async (data: WebSocketEvents['delete-session']) => {
        try {
          const { sessionId, userId } = data;

          if (userId !== socket.userId) {
            socket.emit('error', { message: 'Unauthorized' });
            return;
          }

          await ChatSessionModel.findOneAndUpdate({ id: sessionId, userId }, { isActive: false });

          // Remove from active sessions
          this.activeSessions.delete(sessionId);

          socket.emit('session-deleted', { sessionId });
        } catch (error) {
          logger.error(`Error deleting session: ${error.message}`);
          socket.emit('error', { message: 'Failed to delete session' });
        }
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        logger.info(`WebSocket disconnected: ${socket.id}, User: ${socket.userId}`);

        if (socket.userId) {
          this.userSockets.delete(socket.userId);
        }

        // Remove from active sessions
        this.activeSessions.forEach((sockets, sessionId) => {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            this.activeSessions.delete(sessionId);
          }
        });
      });
    });
  }

  private async createMessage(data: {
    userId: string;
    sessionId: string;
    message: string;
    type: 'user' | 'agent' | 'system';
    metadata?: any;
  }): Promise<ChatMessage> {
    const messageData = {
      id: uuidv4(),
      ...data,
      timestamp: new Date(),
    };

    const message = await ChatMessageModel.create(messageData);
    return message.toObject();
  }

  private async createSession(userId: string, title?: string, id?: string): Promise<ChatSession & Document & { _id: any }> {
    const sessionData = {
      id: id || uuidv4(),
      userId,
      title: title || `Chat ${new Date().toLocaleString()}`,
      isActive: true,
      messageCount: 0,
      lastActivity: new Date(),
      context: {
        recentQueries: [],
        databaseContext: [],
      },
    };

    const session = await ChatSessionModel.create(sessionData);
    return session;
  }

  public getActiveSessionsCount(): number {
    return this.activeSessions.size;
  }

  public getConnectedUsersCount(): number {
    return this.userSockets.size;
  }

  public async cleanupInactiveSessions(): Promise<void> {
    const cutoffTime = new Date(Date.now() - this.config.sessionTimeoutMinutes * 60 * 1000);

    await ChatSessionModel.updateMany(
      {
        lastActivity: { $lt: cutoffTime },
        isActive: true,
      },
      {
        isActive: false,
      },
    );

    logger.info('Cleaned up inactive sessions');
  }
}
