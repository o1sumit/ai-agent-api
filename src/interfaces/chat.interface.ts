export interface ChatMessage {
  id: string;
  userId: string;
  sessionId: string;
  message: string;
  type: 'user' | 'agent' | 'system';
  timestamp: Date;
  metadata?: {
    queryType?: string;
    executionTime?: number;
    dataRetrieved?: boolean;
    toolsUsed?: string[];
    confidence?: number;
  };
}

export interface ChatSession {
  id: string;
  userId: string;
  title?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  lastActivity: Date;
  context?: {
    currentTopic?: string;
    recentQueries?: string[];
    userPreferences?: any;
    databaseContext?: string[];
  };
}

export interface AgentResponse {
  message: string;
  type: 'text' | 'data' | 'error' | 'thinking';
  data?: any;
  suggestions?: string[];
  toolsUsed?: string[];
  executionTime?: number;
  confidence?: number;
  followUpQuestions?: string[];
}

export interface DatabaseTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

export interface AgentState {
  messages: ChatMessage[];
  currentQuery?: string;
  context: {
    userId: string;
    sessionId: string;
    databaseSchema?: any;
    userMemory?: any;
    conversationHistory?: ChatMessage[];
  };
  tools: DatabaseTool[];
  thinking?: string;
  finalResponse?: AgentResponse;
}

export interface WebSocketEvents {
  // Client to Server
  'join-session': { sessionId: string; userId: string };
  'send-message': { message: string; sessionId: string };
  typing: { sessionId: string; isTyping: boolean };
  'get-sessions': { userId: string };
  'create-session': { userId: string; title?: string };
  'delete-session': { sessionId: string; userId: string };

  // Server to Client
  'session-joined': { sessionId: string; session: ChatSession };
  'message-received': { message: ChatMessage };
  'agent-thinking': { message: string; sessionId: string };
  'agent-response': { response: AgentResponse; sessionId: string };
  'typing-indicator': { userId: string; isTyping: boolean; sessionId: string };
  'sessions-list': { sessions: ChatSession[] };
  'session-created': { session: ChatSession };
  'session-deleted': { sessionId: string };
  error: { message: string; code?: string };
}

export interface ChatServiceConfig {
  maxMessagesPerSession: number;
  maxSessionsPerUser: number;
  sessionTimeoutMinutes: number;
  enableTypingIndicator: boolean;
  enableThinkingProcess: boolean;
}
