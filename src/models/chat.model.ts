import { model, Schema, Document } from 'mongoose';
import { ChatMessage, ChatSession } from '@interfaces/chat.interface';

const ChatMessageSchema: Schema = new Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    sessionId: {
      type: String,
      required: true,
      index: true,
    },
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['user', 'agent', 'system'],
      required: true,
    },
    metadata: {
      queryType: String,
      executionTime: Number,
      dataRetrieved: Boolean,
      toolsUsed: [String],
      confidence: Number,
    },
  },
  {
    timestamps: true,
  },
);

const ChatSessionSchema: Schema = new Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    title: {
      type: String,
      default: 'New Chat',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    messageCount: {
      type: Number,
      default: 0,
    },
    lastActivity: {
      type: Date,
      default: Date.now,
    },
    context: {
      currentTopic: String,
      recentQueries: [String],
      userPreferences: Schema.Types.Mixed,
      databaseContext: [String],
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for better performance
ChatMessageSchema.index({ sessionId: 1, createdAt: -1 });
ChatMessageSchema.index({ userId: 1, createdAt: -1 });
ChatMessageSchema.index({ type: 1, createdAt: -1 });

ChatSessionSchema.index({ userId: 1, lastActivity: -1 });
ChatSessionSchema.index({ isActive: 1, lastActivity: -1 });

// TTL index to automatically delete old inactive sessions (30 days)
ChatSessionSchema.index({ lastActivity: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const ChatMessageModel = model<ChatMessage & Document>('ChatMessage', ChatMessageSchema);
export const ChatSessionModel = model<ChatSession & Document>('ChatSession', ChatSessionSchema);
