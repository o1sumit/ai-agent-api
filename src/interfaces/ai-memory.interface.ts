import { AIMemory, UserPreferences } from '@models/ai-memory.model';

export interface QueryContext {
  userId: string;
  query: string;
  queryType: string;
  collections: string[];
}

export interface MemoryInsight {
  similarQueries: AIMemory[];
  userPreferences: UserPreferences | null;
  suggestions: string[];
  queryPattern: string;
}

export interface UserStats {
  totalQueries: number;
  successfulQueries: number;
  successRate: string;
  averageExecutionTime: number;
  skillLevel: 'beginner' | 'intermediate' | 'advanced';
  frequentCollections: string[];
}

export interface QueryHistoryPattern {
  pattern: string;
  frequency: number;
  lastUsed: Date;
}

export interface LearningProfile {
  skillLevel: 'beginner' | 'intermediate' | 'advanced';
  preferredResponseDetail: 'brief' | 'detailed';
  commonMistakes: string[];
}
