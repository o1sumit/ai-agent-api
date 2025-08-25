// Test environment setup
process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.SECRET_KEY = 'test-secret-key';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '27017';
process.env.DB_DATABASE = 'test-db';
process.env.GOOGLE_API_KEY = 'test-api-key';
process.env.LOG_FORMAT = 'combined';
process.env.ORIGIN = 'http://localhost:3001';
process.env.CREDENTIALS = 'false';

// Mock mongoose connect to avoid actual database connections during tests
jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue({}),
  set: jest.fn(),
  model: jest.fn(),
  Schema: jest.fn(),
  disconnect: jest.fn(),
}));

// Mock WebSocket service to avoid initialization issues
jest.mock('@services/websocket-chat.service', () => ({
  WebSocketChatService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    cleanupInactiveSessions: jest.fn(),
  })),
}));

// Mock database agent service to avoid Google API key issues
jest.mock('@services/database-agent.service', () => ({
  DatabaseAgentService: jest.fn().mockImplementation(() => ({
    processQuery: jest.fn(),
  })),
}));
