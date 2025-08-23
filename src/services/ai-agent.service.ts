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
    const systemPrompt = `You are a strict, safety-first MongoDB query generator. Generate optimized and SAFE MongoDB operations (CRUD and analysis) from natural language, the database schema, and user history.

Database Schema:
${schemaInfo}

${memoryContext}

Strong Safety Rules:
1) NEVER generate deleteMany or updateMany. Only allow deleteOne and updateOne.
2) NEVER generate deleteOne or updateOne with an empty filter. The filter MUST target a specific document (e.g., by _id or another unique field).
3) NEVER include sensitive fields (like password, accessToken, secrets) in projections or write payloads.
4) For updates, prefer $set and do not unset critical identifiers.
5) For aggregates, do not use $out/$merge stages.
6) For reads, prefer minimal projections (exclude sensitive fields).
7) Always specify the collection name.

Output JSON Format (pick the appropriate fields per operation):
{
  "operation": "find|findOne|aggregate|count|insertOne|updateOne|deleteOne",
  "queryString": "Human readable description",
  "collection": "collection_name",
  "filter": { ... },
  "projection": { ... },
  "sort": { ... },
  "limit": number,
  "pipeline": [ ... ],
  "document": { ... },
  "update": { "$set": { ... } },
  "options": { ... }
}

Additional Guidance:
- Use regex for text searches: {"field": {"$regex": "pattern", "$options": "i"}}
- Use DATE_7_DAYS_AGO, DATE_30_DAYS_AGO, DATE_TODAY placeholders in filters; they will be converted to Date objects.
- For write operations, only include relevant fields, never passwords.

Examples:
- Read: {"operation":"find","collection":"users","queryString":"Get first 10 users","filter":{},"projection":{"password":0},"sort":{"createdAt":-1},"limit":10}
- Insert: {"operation":"insertOne","collection":"products","queryString":"Create a product","document":{"name":"Remede Serum","price":59.99}}
- Update: {"operation":"updateOne","collection":"products","queryString":"Update product price","filter":{"sku":"RMD-001"},"update":{"$set":{"price":69.99}}}
- Delete (safe): {"operation":"deleteOne","collection":"products","queryString":"Remove discontinued product","filter":{"sku":"RMD-001"}}
`;

    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userQuery)];
    const response = await this.llm.invoke(messages);

    try {
      const raw = response.content.toString();
      const sanitizedText = this.sanitizeJsonContent(raw);
      const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found in AI response');
      }

      const queryObject = JSON.parse(jsonMatch[0]);

      if (!queryObject.operation || !queryObject.queryString) {
        throw new Error('Invalid query object structure');
      }

      if (queryObject.filter) {
        queryObject.filter = this.postProcessFilter(queryObject.filter);
      }

      if (!queryObject.collection) {
        queryObject.collection = 'users';
      }

      return queryObject;
    } catch (error) {
      logger.error(`Failed to parse AI response: ${response.content}`);
      throw new Error(`Failed to generate valid MongoDB query: ${error.message}`);
    }
  }

  private async generateSQLQuery(userQuery: string, schemaInfo: string, memoryContext: string, dbType: 'postgres' | 'mysql'): Promise<SQLQueryObject> {
    const systemPrompt = `You are a strict, safety-first ${dbType.toUpperCase()} SQL generator. Generate optimized and SAFE SQL (CRUD and analysis) from natural language, the database schema, and user history.

Database Schema:
${schemaInfo}

${memoryContext}

Strong Safety Rules:
1) ALWAYS use parameterized queries. For Postgres use $1,$2,... and for MySQL use ? placeholders.
2) NEVER generate DELETE without a highly specific WHERE clause. Forbid mass deletions.
3) NEVER generate UPDATE without a highly specific WHERE clause.
4) NEVER drop or truncate tables, or alter schema.
5) ALWAYS exclude sensitive fields (password, accessToken, secrets) in SELECT/INSERT/UPDATE.
6) Prefer LIMIT for reads.
7) Return the response in this exact JSON format:

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
- Read: {"operation": "sql", "queryString": "Find all users", "sql": "SELECT id, name, email, created_at FROM users LIMIT 10", "parameters": []}
- Update (safe): {"operation": "sql", "queryString": "Update product price", "sql": "UPDATE products SET price = $1 WHERE sku = $2", "parameters": [69.99, "RMD-001"]}
- Delete (safe): {"operation": "sql", "queryString": "Delete discontinued product", "sql": "DELETE FROM products WHERE sku = $1", "parameters": ["RMD-001"]}`;

    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userQuery)];
    const response = await this.llm.invoke(messages);

    try {
      const raw = response.content.toString();
      const sanitizedText = this.sanitizeJsonContent(raw);
      const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
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

  // Convert common non-JSON tokens produced by LLM into proper JSON
  private sanitizeJsonContent(text: string): string {
    return text
      .replace(/ObjectId\("([0-9a-fA-F]{24})"\)/g, '"$1"')
      .replace(/new Date\("([^"]+)"\)/g, '"$1"')
      .replace(/ISODate\("([^"]+)"\)/g, '"$1"')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false');
  }

  // Post-process filter: convert placeholders and typed strings into proper types
  private postProcessFilter(filter: any): any {
    const processed = this.replaceDatePlaceholders(filter);
    // Convert stringified ObjectId-like fields to actual ObjectId if safe
    const convert = (obj: any): any => {
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const key of Object.keys(obj)) {
          const val = obj[key];
          if (typeof val === 'string' && /^[0-9a-fA-F]{24}$/.test(val)) {
            try {
              obj[key] = new (mongoose as any).Types.ObjectId(val);
            } catch {
              /* ignore */
            }
          } else if (typeof val === 'object') {
            obj[key] = convert(val);
          }
        }
      } else if (Array.isArray(obj)) {
        return obj.map(v => convert(v));
      }
      return obj;
    };
    return convert(processed);
  }

  private async executeQuery(queryObj: MongoQueryObject | SQLQueryObject, dbConnection: any): Promise<any> {
    logger.info(`Executing ${queryObj.operation} query: ${queryObj.queryString}`);

    try {
      if (queryObj.operation === 'sql') {
        const sqlQuery = queryObj as SQLQueryObject;
        // Guardrail: block dangerous SQL verbs
        let sqlText = sqlQuery.sql || '';
        const lowerSql = sqlText.toLowerCase();
        if (/\b(drop|truncate|alter)\b/.test(lowerSql)) {
          throw new Error('Dangerous SQL operation blocked');
        }

        // Guardrail: prevent mass UPDATE/DELETE without WHERE
        if (/^\s*delete\b/.test(lowerSql) && !/\bwhere\b/.test(lowerSql)) {
          throw new Error('DELETE without WHERE is blocked');
        }
        if (/^\s*update\b/.test(lowerSql) && !/\bwhere\b/.test(lowerSql)) {
          throw new Error('UPDATE without WHERE is blocked');
        }

        // Additional SQL hardening
        if (/--|\/\*/.test(sqlText)) {
          throw new Error('SQL comments are blocked');
        }
        const semicolons = (sqlText.match(/;/g) || []).length;
        if (semicolons > 1) {
          throw new Error('Multiple SQL statements are blocked');
        }
        sqlText = sqlText.replace(/;\s*$/, '');

        if (dbConnection.type === 'postgres') {
          const result = await dbConnection.pg.query(sqlText, sqlQuery.parameters || []);
          return result.rows;
        } else if (dbConnection.type === 'mysql') {
          // Normalize Postgres-style params ($1,$2,...) to MySQL (?) if needed
          let sql = sqlText;
          if (/\$\d+/.test(sql)) {
            const paramCount = (sql.match(/\$\d+/g) || []).length;
            sql = sql.replace(/\$\d+/g, '?');
            if ((sqlQuery.parameters || []).length !== paramCount) {
              throw new Error('Parameter count mismatch after normalization');
            }
          }
          const [rows] = await dbConnection.mysql.execute(sql, sqlQuery.parameters || []);
          return rows;
        }
      } else {
        // MongoDB query
        const mongoQuery = queryObj as MongoQueryObject;
        const { operation, collection, filter = {}, projection = { password: 0 }, sort, limit, document, update } = mongoQuery;
        // Guardrail: block dangerous Mongo operators in filters
        const containsDangerousMongo = (obj: any): boolean => {
          if (!obj || typeof obj !== 'object') return false;
          if (Array.isArray(obj)) return obj.some(containsDangerousMongo);
          return Object.keys(obj).some(k =>
            k === '$where' || k === '$function' || (typeof obj[k] === 'object' && containsDangerousMongo(obj[k]))
          );
        };
        if (containsDangerousMongo(filter)) {
          throw new Error('Dangerous Mongo operator in filter is blocked');
        }
        
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
            const pipeline = (mongoQuery as any).pipeline || filter.pipeline || [{ $match: filter }];
            // Guardrail: forbid $out / $merge
            if (Array.isArray(pipeline) && pipeline.some((st: any) => st.$out || st.$merge)) {
              throw new Error('Dangerous Mongo aggregation stage blocked');
            }
            return await model.aggregate(pipeline).exec();

          case 'insertOne':
            if (!document || typeof document !== 'object') throw new Error('insertOne requires a document');
            if ('password' in document) delete (document as any).password;
            return await model.create(document);

          case 'updateOne':
            if (!filter || Object.keys(filter).length === 0) throw new Error('updateOne requires a specific filter');
            if (!update || typeof update !== 'object') throw new Error('updateOne requires an update object');
            const safeUpdate = Object.keys(update).some(k => k.startsWith('$')) ? update : { $set: update };
            return await model.updateOne(filter, safeUpdate, { upsert: false });

          case 'deleteOne':
            if (!filter || Object.keys(filter).length === 0) throw new Error('deleteOne requires a specific filter');
            return await model.deleteOne(filter);

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
    return connection.model(collectionName, dynamicSchema, collectionName);
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
      // CRUD + Analysis examples
      'Create a new product named Remede Serum with price 59.99',
      'Update the price of product with SKU RMD-001 to 69.99',
      'Delete the product with SKU RMD-001',
      'Show top 5 products by revenue in last 30 days',
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
