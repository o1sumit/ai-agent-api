export type DBType = 'mongodb' | 'postgres' | 'mysql';

export interface AIQueryRequest {
  query: string;
  dbUrl: string;
  dbType?: DBType;
}

export interface AIQueryResponse {
  data: any;
  message: string;
  query?: string;
  suggestions?: string[];
  executionTime?: number;
  memoryInsights?: MemoryInsights;
}

export interface SampleQueriesResponse {
  queries: string[];
  message: string;
}

export interface QueryResult {
  data: any;
  message: string;
  query?: string;
  suggestions?: string[];
  executionTime?: number;
  memoryInsights?: MemoryInsights;
}

export interface MemoryInsights {
  similarQueries: number;
  userLevel: 'beginner' | 'intermediate' | 'advanced';
  queryPattern: string;
}

export interface MongoQueryObject {
  operation: string;
  queryString: string;
  collection?: string;
  filter?: any;
  projection?: any;
  sort?: any;
  limit?: number;
  // Optional fields for CRUD operations
  document?: any; // for insertOne
  update?: any; // for updateOne
  options?: any; // optional driver options
}

export interface SQLQueryObject {
  operation: 'sql';
  queryString: string;
  sql: string;
  parameters?: any[];
}

export interface AIFeedbackRequest {
  queryId: string;
  feedback: 'positive' | 'negative';
}

export interface AIStatusResponse {
  status: 'active' | 'inactive';
  message: string;
  supportedOperations: string[];
  features: string[];
}
