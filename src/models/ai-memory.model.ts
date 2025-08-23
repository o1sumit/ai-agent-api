import { model, Schema, Document } from 'mongoose';

export interface AIMemory {
  userId: string;
  query: string;
  generatedMongoQuery: string;
  executionTime: number;
  resultCount: number;
  wasSuccessful: boolean;
  feedback?: 'positive' | 'negative';
  queryType: 'find' | 'findOne' | 'count' | 'aggregate';
  collections: string[];
  timestamp: Date;
  contextTags?: string[]; // Tags like 'user-search', 'date-filter', etc.
  queryPattern?: string; // Normalized pattern for learning
}

export interface UserPreferences {
  userId: string;
  preferredQueryStyle?: string;
  commonFilters?: any;
  frequentCollections?: string[];
  queryHistory?: {
    pattern: string;
    frequency: number;
    lastUsed: Date;
  }[];
  learningProfile?: {
    skillLevel: 'beginner' | 'intermediate' | 'advanced';
    preferredResponseDetail: 'brief' | 'detailed';
    commonMistakes?: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

const AIMemorySchema: Schema = new Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    query: {
      type: String,
      required: true,
    },
    generatedMongoQuery: {
      type: String,
      required: true,
    },
    executionTime: {
      type: Number,
      required: true,
    },
    resultCount: {
      type: Number,
      required: true,
    },
    wasSuccessful: {
      type: Boolean,
      required: true,
    },
    feedback: {
      type: String,
      enum: ['positive', 'negative'],
    },
    queryType: {
      type: String,
      enum: ['find', 'findOne', 'count', 'aggregate'],
      required: true,
    },
    collections: [
      {
        type: String,
        required: true,
      },
    ],
    contextTags: [String],
    queryPattern: String,
  },
  {
    timestamps: true,
  },
);

const UserPreferencesSchema: Schema = new Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    preferredQueryStyle: String,
    commonFilters: Schema.Types.Mixed,
    frequentCollections: [String],
    queryHistory: [
      {
        pattern: String,
        frequency: { type: Number, default: 1 },
        lastUsed: { type: Date, default: Date.now },
      },
    ],
    learningProfile: {
      skillLevel: {
        type: String,
        enum: ['beginner', 'intermediate', 'advanced'],
        default: 'beginner',
      },
      preferredResponseDetail: {
        type: String,
        enum: ['brief', 'detailed'],
        default: 'detailed',
      },
      commonMistakes: [String],
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for better performance
AIMemorySchema.index({ userId: 1, timestamp: -1 });
AIMemorySchema.index({ queryPattern: 1 });
AIMemorySchema.index({ wasSuccessful: 1 });

UserPreferencesSchema.index({ userId: 1 });

export const AIMemoryModel = model<AIMemory & Document>('AIMemory', AIMemorySchema);
export const UserPreferencesModel = model<UserPreferences & Document>('UserPreferences', UserPreferencesSchema);
