import { Service } from 'typedi';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { GOOGLE_API_KEY } from '@config';
import { HttpException } from '@exceptions/httpException';
import { SchemaDetectorService } from './schema-detector.service';
import { SQLSchemaDetectorService } from './sql-schema-detector.service';
import { DbPoolService } from './db-pool.service';
import { AIMemoryService } from './ai-memory.service';
import { QueryResult, MongoQueryObject, SQLQueryObject, DBType } from '@interfaces/ai-agent.interface';
import { logger } from '@utils/logger';
import mongoose from 'mongoose';

interface DBConnectionOptions {
  dbUrl: string;
  dbType?: DBType;
}

@Service()
export class AIAgentService {
  private llm: ChatGoogleGenerativeAI;
  private schemaDetector: SchemaDetectorService;
  private sqlSchemaDetector: SQLSchemaDetectorService;
  private dbPool: DbPoolService;
  private memoryService: AIMemoryService;

  constructor() {
    if (!GOOGLE_API_KEY) {
      throw new HttpException(500, 'Google API key is not configured');
    }

    this.llm = new ChatGoogleGenerativeAI({
      apiKey: GOOGLE_API_KEY,
      model: 'gemini-1.5-flash',
      temperature: 0.1,
    });

    this.schemaDetector = new SchemaDetectorService();
    this.sqlSchemaDetector = new SQLSchemaDetectorService();
    this.dbPool = new DbPoolService();
    this.memoryService = new AIMemoryService();
  }

  public async processQuery(userQuery: string, userId: string, dbOptions: DBConnectionOptions): Promise<QueryResult> {
    const startTime = Date.now();

    try {
      logger.info(`Processing AI query for user ${userId}: ${userQuery}`);

      // Get database connection
      const dbConnection = await this.dbPool.get(dbOptions.dbUrl, dbOptions.dbType);

      // Get memory insights for the user
      const memoryInsights = await this.memoryService.getMemoryInsights(userId, userQuery);

      // Get dynamic database schema
      let schemaInfo: string;
      if (dbConnection.type === 'mongodb') {
        const schemas = await this.schemaDetector.getAllSchemas(dbConnection.mongo);
        schemaInfo = this.schemaDetector.getSchemaAsString(schemas);
      } else {
        schemaInfo = await this.sqlSchemaDetector.getSchemaAsString(
          dbConnection.type,
          dbConnection.type === 'postgres' ? dbConnection.pg : dbConnection.mysql
        );
      }

      // Generate query using AI with memory context
      const queryObject = await this.generateQuery(userQuery, schemaInfo, memoryInsights, dbConnection.type);

      // Execute the generated query
      const result = await this.executeQuery(queryObject, dbConnection);

      const executionTime = Date.now() - startTime;
      const resultCount = Array.isArray(result) ? result.length : result ? 1 : 0;

      // Record this query in memory
      await this.memoryService.recordQuery(
        userId,
        userQuery,
        queryObject.queryString,
        queryObject.operation as any,
        dbConnection.type === 'mongodb' ? [(queryObject as MongoQueryObject).collection || 'unknown'] : ['sql_table'],
        executionTime,
        resultCount,
        true,
      );

      return {
        data: result,
        message: 'Query executed successfully',
        query: queryObject.queryString,
        suggestions: memoryInsights.suggestions,
        executionTime,
        memoryInsights: {
          similarQueries: memoryInsights.similarQueries.length,
          userLevel: memoryInsights.userPreferences?.learningProfile?.skillLevel || 'beginner',
          queryPattern: memoryInsights.queryPattern,
        },
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      // Record failed query
      try {
        await this.memoryService.recordQuery(userId, userQuery, 'FAILED', 'find', ['unknown'], executionTime, 0, false);
      } catch (memoryError: any) {
        logger.error(`Failed to record failed query: ${memoryError.message}`);
      }

      logger.error(`AI Agent error for user ${userId}: ${error.message}`);
      throw new HttpException(500, `AI Agent failed: ${error.message}`);
    }
  }

  private async generateQuery(userQuery: string, schemaInfo: string, memoryInsights: any, dbType: DBType): Promise<MongoQueryObject | SQLQueryObject> {
    // Build context from memory
    let memoryContext = '';
    if (memoryInsights.similarQueries.length > 0) {
      memoryContext = `\n\nUser's Previous Successful Queries:\n${memoryInsights.similarQueries
        .map((q: any) => `- "${q.query}" → ${q.queryType} operation`)
        .join('\n')}`;
    }

    if (memoryInsights.userPreferences) {
      const prefs = memoryInsights.userPreferences;
      memoryContext += `\n\nUser Profile:
- Skill Level: ${prefs.learningProfile?.skillLevel || 'beginner'}
- Frequently Used Collections: ${prefs.frequentCollections?.join(', ') || 'none'}
- Common Query Patterns: ${
        prefs.queryHistory
          ?.slice(0, 3)
          .map((h: any) => h.pattern)
          .join(', ') || 'none'
      }`;
    }

    if (memoryInsights.suggestions.length > 0) {
      memoryContext += `\n\nSuggestions based on user history:\n${memoryInsights.suggestions.join('\n- ')}`;
    }

    if (dbType === 'mongodb') {
      return this.generateMongoQuery(userQuery, schemaInfo, memoryContext);
    } else {
      return this.generateSQLQuery(userQuery, schemaInfo, memoryContext, dbType);
    }
  }

  private async generateMongoQuery(userQuery: string, schemaInfo: string, memoryContext: string): Promise<MongoQueryObject> {

    const systemPrompt = `You are an advanced MongoDB query generator with user context awareness. Generate optimized MongoDB queries based on the user's natural language input, database schema, and their query history.

Database Schema:
${schemaInfo}

${memoryContext}

Rules:
1. Generate only valid MongoDB queries for the available collections
2. Use appropriate MongoDB operators ($eq, $ne, $gt, $lt, $gte, $lte, $in, $regex, etc.)
3. Always exclude password and sensitive fields in projections
4. Consider the user's skill level and previous query patterns
5. For beginners, prefer simpler queries; for advanced users, suggest more complex operations
6. If user frequently queries certain collections, prioritize those
7. Use the user's previous successful query patterns as guidance
8. Return the response in this exact JSON format:

{
  "operation": "find|findOne|aggregate|count",
  "queryString": "Human readable description of what the query does",
  "collection": "collection_name",
  "filter": {MongoDB filter object},
  "projection": {MongoDB projection object},
  "sort": {MongoDB sort object if needed},
  "limit": number if needed
}

Important:
- Always specify the collection name
- For user queries, default to "users" collection unless another collection is clearly specified
- Use regex for text searches: {"field": {"$regex": "pattern", "$options": "i"}}
- For date ranges, use appropriate date objects
- Consider user's frequent patterns and suggest optimizations

Examples:
- "Get all users" → {"operation": "find", "collection": "users", "queryString": "Find all users", "filter": {}, "projection": {"password": 0}}
- "Find user with email john@example.com" → {"operation": "findOne", "collection": "users", "queryString": "Find user by email", "filter": {"email": "john@example.com"}, "projection": {"password": 0}}`;

    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userQuery)];

    const response = await this.llm.invoke(messages);

    try {
      const jsonMatch = response.content.toString().match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found in AI response');
      }

      const queryObject = JSON.parse(jsonMatch[0]);

      if (!queryObject.operation || !queryObject.queryString) {
        throw new Error('Invalid query object structure');
      }

      // Handle date placeholders
      if (queryObject.filter) {
        queryObject.filter = this.replaceDatePlaceholders(queryObject.filter);
      }

      // Ensure collection is specified
      if (!queryObject.collection) {
        queryObject.collection = 'users'; // Default fallback
      }

      return queryObject;
    } catch (error) {
      logger.error(`Failed to parse AI response: ${response.content}`);
      throw new Error(`Failed to generate valid MongoDB query: ${error.message}`);
    }
  }

  private async generateSQLQuery(userQuery: string, schemaInfo: string, memoryContext: string, dbType: 'postgres' | 'mysql'): Promise<SQLQueryObject> {
    const systemPrompt = `You are an advanced ${dbType.toUpperCase()} SQL query generator with user context awareness. Generate optimized SQL queries based on the user's natural language input, database schema, and their query history.

Database Schema:
${schemaInfo}

${memoryContext}

Rules:
1. Generate only valid ${dbType.toUpperCase()} SQL queries for the available tables
2. Use appropriate SQL operators and functions
3. Always exclude password and sensitive fields in SELECT statements
4. Consider the user's skill level and previous query patterns
5. For beginners, prefer simpler queries; for advanced users, suggest more complex operations
6. Use parameterized queries when appropriate
7. Return the response in this exact JSON format:

{
  "operation": "sql",
  "queryString": "Human readable description of what the query does",
  "sql": "SELECT * FROM table_name WHERE condition",
  "parameters": [optional array of parameters for parameterized queries]
}

Important:
- Always use proper SQL syntax for ${dbType.toUpperCase()}
- Use LIMIT for result limiting
- Use proper date/time functions for ${dbType.toUpperCase()}
- Consider performance and use appropriate indexes
- Exclude sensitive fields like passwords

Examples:
- "Get all users" → {"operation": "sql", "queryString": "Find all users", "sql": "SELECT id, name, email, created_at FROM users", "parameters": []}
- "Find user with email john@example.com" → {"operation": "sql", "queryString": "Find user by email", "sql": "SELECT id, name, email FROM users WHERE email = $1", "parameters": ["john@example.com"]}`;

    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userQuery)];
    const response = await this.llm.invoke(messages);

    try {
      const jsonMatch = response.content.toString().match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found in AI response');
      }

      const queryObject = JSON.parse(jsonMatch[0]);

      if (!queryObject.operation || !queryObject.queryString || !queryObject.sql) {
        throw new Error('Invalid SQL query object structure');
      }

      return queryObject;
    } catch (error: any) {
      logger.error(`Failed to parse AI response: ${response.content}`);
      throw new Error(`Failed to generate valid SQL query: ${error.message}`);
    }
  }

  private replaceDatePlaceholders(filter: any): any {
    const processValue = (value: any): any => {
      if (typeof value === 'string') {
        if (value === 'DATE_7_DAYS_AGO') {
          const date = new Date();
          date.setDate(date.getDate() - 7);
          return date;
        }
        if (value === 'DATE_30_DAYS_AGO') {
          const date = new Date();
          date.setDate(date.getDate() - 30);
          return date;
        }
        if (value === 'DATE_TODAY') {
          const date = new Date();
          date.setHours(0, 0, 0, 0);
          return date;
        }
      }
      if (typeof value === 'object' && value !== null) {
        const result: any = {};
        for (const [key, val] of Object.entries(value)) {
          result[key] = processValue(val);
        }
        return result;
      }
      return value;
    };

    return processValue(filter);
  }

  private async executeQuery(queryObj: MongoQueryObject | SQLQueryObject, dbConnection: any): Promise<any> {
    logger.info(`Executing ${queryObj.operation} query: ${queryObj.queryString}`);

    try {
      if (queryObj.operation === 'sql') {
        const sqlQuery = queryObj as SQLQueryObject;
        if (dbConnection.type === 'postgres') {
          const result = await dbConnection.pg.query(sqlQuery.sql, sqlQuery.parameters || []);
          return result.rows;
        } else if (dbConnection.type === 'mysql') {
          const [rows] = await dbConnection.mysql.execute(sqlQuery.sql, sqlQuery.parameters || []);
          return rows;
        }
      } else {
        // MongoDB query
        const mongoQuery = queryObj as MongoQueryObject;
        const { operation, collection, filter = {}, projection = { password: 0 }, sort, limit } = mongoQuery;
        
        // Get the appropriate model
        const model = this.getModelForCollection(collection, dbConnection.mongo);

        switch (operation) {
          case 'find':
            let query = model.find(filter, projection);
            if (sort) query = query.sort(sort);
            if (limit) query = query.limit(limit);
            return await query.exec();

          case 'findOne':
            return await model.findOne(filter, projection).exec();

          case 'count':
            return await model.countDocuments(filter).exec();

          case 'aggregate':
            const pipeline = filter.pipeline || [{ $match: filter }];
            return await model.aggregate(pipeline).exec();

          default:
            throw new Error(`Unsupported operation: ${operation}`);
        }
      }
    } catch (error: any) {
      logger.error(`Database query execution failed: ${error.message}`);
      throw new Error(`Database query failed: ${error.message}`);
    }
  }

  private getModelForCollection(collectionName: string, conn?: mongoose.Connection): any {
    const connection = conn || mongoose.connection;
    
    // Try to find existing mongoose model
    const existingModel = Object.values(connection.models).find((model: any) => model.collection.name === collectionName);

    if (existingModel) {
      return existingModel;
    }

    // Create dynamic model if not found
    const dynamicSchema = new mongoose.Schema({}, { strict: false });
    return connection.model(collectionName, dynamicSchema);
  }

  public async getSampleQueries(): Promise<string[]> {
    return [
      'Get all users',
      'Find user with email john@example.com',
      'Get users created in the last 7 days',
      'Count total number of users',
      'Find users with gmail email addresses',
      'Get the most recently created user',
      'Show me users sorted by creation date',
      'Find users created today',
      'Get first 10 users',
      'Show me all tables',
      'Get all records from products table',
      'Find orders from last month',
    ];
  }

  public async recordFeedback(userId: string, queryId: string, feedback: 'positive' | 'negative'): Promise<void> {
    await this.memoryService.recordFeedback(userId, queryId, feedback);
  }

  public async getUserStats(userId: string): Promise<any> {
    return await this.memoryService.getUserStats(userId);
  }

  public async refreshSchemaCache(): Promise<void> {
    await this.schemaDetector.refreshCache();
  }
}
