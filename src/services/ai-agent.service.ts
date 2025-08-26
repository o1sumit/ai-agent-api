import { Service } from 'typedi';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { GOOGLE_API_KEY, GOOGLE_MODEL, DEFAULT_ROW_LIMIT, QUERY_TIMEOUT_MS, REDACT_SQL_IN_RESPONSES } from '@config';
import { HttpException } from '@exceptions/HttpException';
import { SchemaDetectorService } from './schema-detector.service';
import { SQLSchemaDetectorService } from './sql-schema-detector.service';
import { DbPoolService } from './db-pool.service';
import { AIMemoryService } from './ai-memory.service';
import { QueryResult, MongoQueryObject, SQLQueryObject, DBType } from '@interfaces/ai-agent.interface';
import { logger } from '@utils/logger';
import mongoose from 'mongoose';
import { SchemaRegistryService } from './schema-registry.service';
import { SqlInsightService } from './sql-insight.service';
import { DataProfilerService } from './data-profiler.service';
import { SchemaKeywordMatcherService } from './schema-keyword-matcher.service';
import { Container } from 'typedi';

type PlanStep =
  | {
      type: 'db_query';
      description?: string;
      subQuery: string;
    }
  | {
      type: 'compute_statistics';
      description?: string;
      onStep: number; // index of previous step to analyze
      operations?: string[]; // e.g., ["count", "topk:field:5", "mean:price"]
    }
  | {
      type: 'llm_analysis';
      description?: string;
      onSteps: number[]; // indices of steps to analyze
      instructions?: string;
    };

interface ExecutionPlan {
  steps: PlanStep[];
}

interface DBConnectionOptions {
  dbUrl: string;
  dbType?: DBType;
  refreshSchema?: boolean;
  insight?: boolean;
}

@Service()
export class AIAgentService {
  private llm: ChatGoogleGenerativeAI;
  private schemaDetector: SchemaDetectorService;
  private sqlSchemaDetector: SQLSchemaDetectorService;
  private dbPool: DbPoolService;
  private memoryService: AIMemoryService;
  private schemaRegistry: SchemaRegistryService;
  private sqlInsight: SqlInsightService;
  private profiler: DataProfilerService;
  private schemaMatcher: SchemaKeywordMatcherService;

  constructor() {
    // LLM is optional; when missing we'll use heuristic fallbacks
    if (!GOOGLE_API_KEY) {
      logger.warn('GOOGLE_API_KEY not set. Falling back to heuristic planning/generation without LLM.');
    } else {
      this.llm = new ChatGoogleGenerativeAI({
        apiKey: GOOGLE_API_KEY,
        model: GOOGLE_MODEL,
        temperature: 0.1,
      });
    }

    this.schemaDetector = new SchemaDetectorService();
    this.sqlSchemaDetector = new SQLSchemaDetectorService();
    this.dbPool = Container.get(DbPoolService);
    this.memoryService = new AIMemoryService();
    this.schemaRegistry = new SchemaRegistryService();
    this.sqlInsight = new SqlInsightService();
    this.profiler = new DataProfilerService();
    this.schemaMatcher = new SchemaKeywordMatcherService();
  }

  public async processQuery(userQuery: string, userId: string, dbOptions: DBConnectionOptions & { dryRun?: boolean }): Promise<QueryResult> {
    const startTime = Date.now();

    try {
      logger.info(`Processing AI query for user ${userId}: ${userQuery}`);

      // Get database connection
      const dbConnection = await this.dbPool.get(dbOptions.dbUrl, dbOptions.dbType);

      // Get memory insights for the user
      const memoryInsights = await this.memoryService.getMemoryInsights(userId, userQuery);

      // Early exit for greetings/small talk without hitting the database
      if (this.isGreeting(userQuery)) {
        const executionTime = Date.now() - startTime;
        const politeMessage = await this.composeGeneralResponse(userQuery, memoryInsights);

        try {
          await this.memoryService.recordQuery(
            userId,
            userQuery,
            'Conversation detected: no database query executed',
            'find',
            ['n/a'],
            executionTime,
            0,
            true,
          );
        } catch (memErr: any) {
          logger.warn(`Memory record (conversation) failed: ${memErr.message}`);
        }

        return {
          data: null,
          message: politeMessage,
          query: undefined,
          suggestions: memoryInsights.suggestions,
          executionTime,
          memoryInsights: {
            similarQueries: memoryInsights.similarQueries.length,
            userLevel: memoryInsights.userPreferences?.learningProfile?.skillLevel || 'beginner',
            queryPattern: memoryInsights.queryPattern,
          },
        };
      }

      // Get database schema from persistent registry (build if missing/stale)
      const schemaInfo = await this.schemaRegistry.getOrBuildSchemaString(
        dbOptions.dbUrl,
        dbConnection.type,
        dbConnection,
        dbOptions.refreshSchema === true,
      );

      // Build quick capability summary to guide planning
      let capabilitySummary = '';
      try {
        capabilitySummary = await this.profiler.getCapabilitiesSummary(dbConnection);
      } catch (e: any) {
        logger.warn(`Profiling failed: ${e.message}`);
      }

      // Lightweight keyword-to-schema candidates leveraging parsed schema for any DB
      let schemaHints: any = null;
      try {
        schemaHints = await this.schemaMatcher.match(userQuery, { schemaJson: schemaInfo, dbType: dbConnection.type, dbConnection });
      } catch (e: any) {
        logger.warn(`Schema keyword match failed: ${e.message}`);
      }

      // Plan → Execute workflow
      let plan: ExecutionPlan | null = null;
      let finalData: any = null;
      let executedQueries: Array<{ queryObject: MongoQueryObject | SQLQueryObject; result: any }> = [];
      let toolOutputs: Array<{ stepIndex: number; type: string; output: any }> = [];

      try {
        // Enrich plan prompt with capability summary
        const enrichedMemory = { ...memoryInsights, capabilitySummary, schemaHints } as any;
        plan = await this.planExecution(userQuery, schemaInfo, enrichedMemory, dbConnection.type);
        if (dbOptions.dryRun) {
          // Only preview: synthesize executedQueries list by generating queries without executing
          for (let i = 0; i < plan.steps.length; i++) {
            const step = plan.steps[i] as PlanStep;
            if (step.type === 'db_query') {
              const subQuery = (step as any).subQuery || userQuery;
              const queryObject = await this.generateQuery(subQuery, schemaInfo, memoryInsights, dbConnection.type);
              executedQueries.push({ queryObject, result: null });
            }
          }
        } else {
          // Heuristic: if the user asks for top/most selling product and DB is SQL, attempt an insight-first query
          if (dbConnection.type !== 'mongodb' && /most\s+selling|top\s+selling|best\s+selling/i.test(userQuery)) {
            try {
              const sql = await this.sqlInsight.getTopSellingSQL(
                dbConnection.type,
                dbConnection.type === 'postgres' ? dbConnection.pg : dbConnection.mysql,
              );
              if (sql) {
                const quickQuery: SQLQueryObject = { operation: 'sql', queryString: 'Top selling products', sql };
                const result = await this.executeQuery(quickQuery, dbConnection);
                finalData = result;
                executedQueries.push({ queryObject: quickQuery, result });
              }
            } catch (e: any) {
              logger.warn(`Insight query failed, falling back to plan: ${e.message}`);
            }
          }

          // If no insight data fetched, run the planned execution
          const execution =
            finalData == null
              ? await this.executePlannedSteps(plan, dbConnection, schemaInfo, memoryInsights, userQuery)
              : ({ finalData, executedQueries, toolOutputs } as any);
          finalData = execution.finalData;
          executedQueries = execution.executedQueries;
          toolOutputs = execution.toolOutputs;
        }
      } catch (planError: any) {
        logger.warn(`Plan-execute flow failed, falling back to single-shot: ${planError.message}`);
        // Fallback to single-shot query generation
        const queryObject = await this.generateQuery(userQuery, schemaInfo, { ...memoryInsights, capabilitySummary, schemaHints }, dbConnection.type);
        if (dbOptions.dryRun) {
          executedQueries = [{ queryObject, result: null }];
        } else {
          const result = await this.executeQuery(queryObject, dbConnection);
          finalData = result;
          executedQueries = [{ queryObject, result }];
        }
      }

      const executionTime = Date.now() - startTime;
      const resultCount = Array.isArray(finalData) ? finalData.length : finalData ? 1 : 0;

      // Record this query in memory
      try {
        if (executedQueries.length > 0) {
          const first = executedQueries[0].queryObject;
          await this.memoryService.recordQuery(
            userId,
            userQuery,
            first.queryString,
            (first as any).operation,
            dbConnection.type === 'mongodb' ? [(first as MongoQueryObject).collection || 'unknown'] : ['sql_table'],
            executionTime,
            resultCount,
            true,
          );
        } else {
          await this.memoryService.recordQuery(
            userId,
            userQuery,
            'Plan executed without direct DB query',
            'find',
            ['n/a'],
            executionTime,
            resultCount,
            true,
          );
        }
      } catch (memErr: any) {
        logger.warn(`Memory record failed: ${memErr.message}`);
      }

      // Generate final response message using LLM if available; otherwise default
      let finalMessage = dbOptions.dryRun ? 'Preview generated successfully' : `Retrieved ${resultCount} record(s)`;
      if (this.llm) {
        try {
          finalMessage = await this.generateFinalResponseMessage(userQuery, executedQueries, toolOutputs, memoryInsights);
        } catch (composeErr: any) {
          logger.warn(`Failed to compose final response, using default message: ${composeErr.message}`);
        }
      }

      return {
        data: finalData,
        message: finalMessage,
        query: executedQueries[0]?.queryObject?.queryString,
        suggestions: memoryInsights.suggestions,
        executionTime,
        plan,
        trace: toolOutputs,
        executedQueries: executedQueries.map(eq => {
          const base: any = { operation: (eq.queryObject as any).operation, queryString: (eq.queryObject as any).queryString };
          if ((eq.queryObject as any).sql) base.sql = REDACT_SQL_IN_RESPONSES ? '[redacted]' : (eq.queryObject as any).sql;
          if ((eq.queryObject as any).collection) base.collection = (eq.queryObject as any).collection;
          if ((eq.queryObject as any).filter) base.filter = (eq.queryObject as any).filter;
          return base;
        }),
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

  private isGreeting(input: string): boolean {
    const text = (input || '').trim().toLowerCase();
    if (!text) return false;
    const patterns = [
      /^(hi|hello|hey|yo|sup)[!,. ]*$/,
      /^(good\s*(morning|afternoon|evening))\b/,
      /^(how\s*are\s*you)\b/,
      /^thanks?\b/,
      /^thank\s*you\b/,
      /^what'?s\s*up\b/,
    ];
    return patterns.some(rx => rx.test(text));
  }

  private async composeGeneralResponse(userQuery: string, memoryInsights: any): Promise<string> {
    const prompt = `You are a mature, helpful assistant. The user message appears to be greeting or small talk.

User: "${userQuery}"
User preferences: ${JSON.stringify(memoryInsights?.userPreferences || {}, null, 2)}

Respond briefly and warmly, offer help, and mention you can:
- answer questions
- query connected databases (when provided)
- perform light data analysis and recommendations.
Do not include raw data or technical details. Keep it to 1-2 short sentences.`;
    const res = await this.llm.invoke([new SystemMessage(prompt), new HumanMessage('Please reply with 1-2 short sentences only.')]);
    return res.content.toString();
  }

  // Create a multi-step execution plan in JSON
  private async planExecution(userQuery: string, schemaInfo: string, memoryInsights: any, dbType: DBType): Promise<ExecutionPlan> {
    const toolsDescription = `Available Tools:
1) db_query: Generate and execute a single ${dbType.toUpperCase()} or MongoDB query for a sub-goal. Input: { "subQuery": string }
2) compute_statistics: Compute quick stats on prior step results (arrays of objects). Input: { "onStep": number, "operations"?: string[] }
3) llm_analysis: Use the LLM to analyze results and produce insights or recommendations. Input: { "onSteps": number[], "instructions"?: string }`;

    const planningPrompt = `You are a senior data agent. Create a concise step-by-step plan to fulfill the user's request by selecting from the available tools.

User Query:\n"${userQuery}"

Database Schema:\n${schemaInfo}

User Context:\n${JSON.stringify(memoryInsights || {}, null, 2)}

Important Notes About Database Schema JSON:
- SQL schemas include keys: table (e.g. schema.table), columns [{ column_name, data_type, is_nullable }], primary_key [..], foreign_keys [{ column_name, references_table, references_column }].
- Prefer joins based on foreign_keys instead of ad-hoc matching.
- Use table names exactly as they appear in the schema JSON (keep schema prefixes where present).
- For MongoDB, collection schemas include relationships (reference/potential_reference). Consider using $lookup when relationships are provided.

${toolsDescription}

Rules:
- Prefer a single db_query step when sufficient.
- For analysis or recommendations, first fetch relevant data (db_query), then compute_statistics if numeric/categorical summaries help, and optionally do llm_analysis to explain/advise.
- Keep the plan minimal but sufficient.
- Output strictly valid JSON in this schema:
{
  "steps": [
    { "type": "db_query", "description": "...", "subQuery": "..." },
    { "type": "compute_statistics", "onStep": 0, "operations": ["count", "topk:field:5"] },
    { "type": "llm_analysis", "onSteps": [0,1], "instructions": "Explain insights and give recommendations" }
  ]
}`;

    const response = await this.llm.invoke([new SystemMessage(planningPrompt), new HumanMessage('Return only the JSON object for the plan.')]);
    const raw = response.content.toString();
    const sanitized = this.sanitizeJsonContent(raw);
    const match = sanitized.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Planning failed: No JSON found');
    const parsed = JSON.parse(match[0]);
    if (!parsed.steps || !Array.isArray(parsed.steps)) throw new Error('Planning failed: Invalid plan structure');
    return parsed as ExecutionPlan;
  }

  // Execute plan steps in order
  private async executePlannedSteps(
    plan: ExecutionPlan,
    dbConnection: any,
    schemaInfo: string,
    memoryInsights: any,
    userQuery: string,
  ): Promise<{
    finalData: any;
    executedQueries: Array<{ queryObject: MongoQueryObject | SQLQueryObject; result: any }>;
    toolOutputs: Array<{ stepIndex: number; type: string; output: any }>;
  }> {
    const executedQueries: Array<{ queryObject: MongoQueryObject | SQLQueryObject; result: any }> = [];
    const toolOutputs: Array<{ stepIndex: number; type: string; output: any }> = [];
    const stepResults: any[] = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i] as PlanStep;
      try {
        if (step.type === 'db_query') {
          const subQuery = (step as Extract<PlanStep, { type: 'db_query' }>).subQuery || userQuery;
          const queryObject = await this.generateQuery(subQuery, schemaInfo, memoryInsights, dbConnection.type);
          const result = await this.executeQuery(queryObject, dbConnection);
          executedQueries.push({ queryObject, result });
          stepResults[i] = result;
          toolOutputs.push({ stepIndex: i, type: 'db_query', output: { query: queryObject.queryString, rows: this.previewArray(result) } });
        } else if (step.type === 'compute_statistics') {
          const onIndex = (step as Extract<PlanStep, { type: 'compute_statistics' }>).onStep;
          const base = stepResults[onIndex];
          const ops = (step as Extract<PlanStep, { type: 'compute_statistics' }>).operations || ['count'];
          const stats = this.computeQuickStatistics(base, ops);
          stepResults[i] = stats;
          toolOutputs.push({ stepIndex: i, type: 'compute_statistics', output: stats });
        } else if (step.type === 'llm_analysis') {
          const onSteps = (step as Extract<PlanStep, { type: 'llm_analysis' }>).onSteps || [];
          const instructions = (step as Extract<PlanStep, { type: 'llm_analysis' }>).instructions || 'Analyze the results and provide insights.';
          const picked = onSteps.map(idx => stepResults[idx]);
          const analysis = await this.performLLMAnalysis(userQuery, picked, instructions);
          stepResults[i] = analysis;
          toolOutputs.push({ stepIndex: i, type: 'llm_analysis', output: analysis });
        }
      } catch (err: any) {
        logger.warn(`Step ${i} (${(step as any).type}) failed: ${err.message}`);
        stepResults[i] = { error: err.message };
        toolOutputs.push({ stepIndex: i, type: 'error', output: err.message });
      }
    }

    // Choose final data: prefer last db_query result; else last step result
    let finalData: any = null;
    for (let i = plan.steps.length - 1; i >= 0; i--) {
      if (plan.steps[i].type === 'db_query') {
        finalData = stepResults[i];
        break;
      }
    }
    if (finalData == null && plan.steps.length > 0) {
      finalData = stepResults[plan.steps.length - 1];
    }

    return { finalData, executedQueries, toolOutputs };
  }

  private previewArray(value: any, limit = 10): any {
    if (Array.isArray(value)) return value.slice(0, limit);
    return value;
  }

  private computeQuickStatistics(data: any, operations: string[]): any {
    const result: any = {};
    const arr = Array.isArray(data) ? data : [];
    const columns = this.inferColumns(arr);

    for (const opRaw of operations) {
      const op = String(opRaw || '').toLowerCase();
      if (op === 'count') {
        result.count = arr.length;
      } else if (op.startsWith('topk:')) {
        const [, field, kStr] = op.split(':');
        const k = Math.max(1, Math.min(50, parseInt(kStr || '5', 10)));
        const freq: Record<string, number> = {};
        for (const row of arr) {
          const v = row?.[field];
          if (v != null) freq[String(v)] = (freq[String(v)] || 0) + 1;
        }
        result[`topk_${field}`] = Object.entries(freq)
          .sort((a, b) => b[1] - a[1])
          .slice(0, k)
          .map(([val, cnt]) => ({ value: val, count: cnt }));
      } else if (op.startsWith('mean:') || op.startsWith('avg:')) {
        const field = op.split(':')[1];
        const nums = arr.map(r => Number(r?.[field])).filter(n => Number.isFinite(n));
        const mean = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        result[`mean_${field}`] = mean;
      } else if (op.startsWith('min:')) {
        const field = op.split(':')[1];
        const nums = arr.map(r => Number(r?.[field])).filter(n => Number.isFinite(n));
        result[`min_${field}`] = nums.length ? Math.min(...nums) : null;
      } else if (op.startsWith('max:')) {
        const field = op.split(':')[1];
        const nums = arr.map(r => Number(r?.[field])).filter(n => Number.isFinite(n));
        result[`max_${field}`] = nums.length ? Math.max(...nums) : null;
      } else if (op.startsWith('sum:')) {
        const field = op.split(':')[1];
        const nums = arr.map(r => Number(r?.[field])).filter(n => Number.isFinite(n));
        result[`sum_${field}`] = nums.length ? nums.reduce((a, b) => a + b, 0) : 0;
      } else if (op.startsWith('distinct:')) {
        const field = op.split(':')[1];
        const set = new Set<string>();
        for (const row of arr) if (row && row[field] != null) set.add(String(row[field]));
        result[`distinct_${field}`] = Array.from(set);
      }
    }
    result.columns = columns;
    return result;
  }

  private inferColumns(rows: any[]): string[] {
    const set = new Set<string>();
    for (const row of rows) if (row && typeof row === 'object') for (const k of Object.keys(row)) set.add(k);
    return Array.from(set);
  }

  private async performLLMAnalysis(userQuery: string, datasets: any[], instructions: string): Promise<string> {
    const sample = datasets.map(ds => (Array.isArray(ds) ? ds.slice(0, 20) : ds));
    const prompt = `User query: "${userQuery}"

We have the following datasets (JSON previews, truncated to first 20 rows each):
${sample.map((s, idx) => `Dataset ${idx}:\n${JSON.stringify(s, null, 2)}`).join('\n\n')}

Instructions: ${instructions}

Provide a concise analysis and, if applicable, recommendations grounded in the data. Do not include raw JSON in the final message.`;
    const res = await this.llm.invoke([new SystemMessage(prompt), new HumanMessage('Provide a concise analysis and recommendations.')]);
    return res.content.toString();
  }

  private async generateFinalResponseMessage(
    userQuery: string,
    executedQueries: Array<{ queryObject: MongoQueryObject | SQLQueryObject; result: any }>,
    toolOutputs: Array<{ stepIndex: number; type: string; output: any }>,
    memoryInsights: any,
  ): Promise<string> {
    const querySummaries = executedQueries.map((q, i) => ({
      index: i,
      description: q.queryObject.queryString,
      rows: Array.isArray(q.result) ? q.result.length : q.result ? 1 : 0,
    }));
    const previewOutputs = toolOutputs.slice(-5); // last few tool outputs
    const prompt = `Summarize the results for the user.

User Query: "${userQuery}"
Executed Queries: ${JSON.stringify(querySummaries)}
Recent Tool Outputs: ${JSON.stringify(previewOutputs)}
User Preferences: ${JSON.stringify(memoryInsights?.userPreferences || {}, null, 2)}

Guidelines:
- Be direct and clear.
- If analysis/recommendations are available, include them briefly.
- Avoid raw JSON; present findings in plain language.
`;
    const res = await this.llm.invoke([new SystemMessage(prompt), new HumanMessage('Write a short final message for the user.')]);
    return res.content.toString();
  }

  private async generateQuery(
    userQuery: string,
    schemaInfo: string,
    memoryInsights: any,
    dbType: DBType,
  ): Promise<MongoQueryObject | SQLQueryObject> {
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

    // If LLM is unavailable, use heuristic generator
    if (!this.llm) {
      return this.generateHeuristicQuery(userQuery, schemaInfo, dbType);
    }

    if (dbType === 'mongodb') {
      return this.generateMongoQuery(userQuery, schemaInfo, memoryContext);
    } else {
      return this.generateSQLQuery(userQuery, schemaInfo, memoryContext, dbType);
    }
  }

  // Heuristic generator for when no LLM is available
  private async generateHeuristicQuery(userQuery: string, schemaInfo: string, dbType: DBType): Promise<MongoQueryObject | SQLQueryObject> {
    const text = (userQuery || '').toLowerCase();
    // Extract likely collection/table keyword
    const names: string[] = [];
    try {
      const parsed = JSON.parse(schemaInfo);
      if (Array.isArray(parsed)) {
        if (dbType === 'mongodb') {
          for (const s of parsed) if ((s as any)?.collection) names.push(String((s as any).collection).toLowerCase());
        } else {
          for (const t of parsed) if ((t as any)?.table) names.push(String((t as any).table).toLowerCase());
        }
      }
    } catch {}

    const pickName = (): string | undefined => {
      const tokens = text.split(/[^a-z0-9_.]+/g).filter(Boolean);
      const scored = names.map(n => ({ n, score: tokens.some(t => n.includes(t)) ? n.length : 0 })).sort((a, b) => b.score - a.score);
      return scored[0]?.score ? scored[0].n : undefined;
    };

    const wantCount = /\bcount|how many\b/.test(text);
    const wantLatest = /\b(latest|recent|newest)\b/.test(text);
    const wantLimit = /\btop|first\b/.test(text);

    if (dbType === 'mongodb') {
      const collection = (pickName() || 'users').replace(/^.*\./, '');
      if (wantCount) return { operation: 'count', queryString: 'Count documents', collection } as any;
      const filter: any = {};
      const sort = wantLatest ? { createdAt: -1 } : undefined;
      const limit = wantLimit ? 10 : 100;
      return { operation: 'find', queryString: 'Heuristic find', collection, filter, sort, limit, projection: { password: 0 } } as any;
    } else {
      const tableFull = pickName() || (dbType === 'postgres' ? 'public.users' : 'users');
      const table = tableFull;
      if (wantCount) {
        return { operation: 'sql', queryString: 'Count rows', sql: `SELECT COUNT(*) AS count FROM ${table}`, parameters: [] } as any;
      }
      const order = wantLatest ? ' ORDER BY created_at DESC' : '';
      const limit = wantLimit ? ' LIMIT 10' : ' LIMIT 100';
      return { operation: 'sql', queryString: 'Heuristic select', sql: `SELECT * FROM ${table}${order}${limit}`, parameters: [] } as any;
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

Relationship Guidance:
- If schema relationships indicate references between collections, prefer aggregation with $lookup to join related data. Use indexed fields for join keys when possible.

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

  private async generateSQLQuery(
    userQuery: string,
    schemaInfo: string,
    memoryContext: string,
    dbType: 'postgres' | 'mysql',
  ): Promise<SQLQueryObject> {
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

Relationship and Naming Guidance:
- The schema JSON includes: table, columns, primary_key, foreign_keys. When joining, prefer the foreign_keys provided rather than guessing.
- Use table names exactly as listed in Database Schema, including schema prefixes (e.g., public.users) when present.
- Prefer qualified column names (table.column) to avoid ambiguity in joins.

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
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('SQL query timeout')), QUERY_TIMEOUT_MS));
          const queryPromise = dbConnection.pg.query(sqlText, sqlQuery.parameters || []);
          const result = await Promise.race([queryPromise, timeoutPromise]);
          return (result as any).rows;
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
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('SQL query timeout')), QUERY_TIMEOUT_MS));
          const execPromise = dbConnection.mysql.execute(sql, sqlQuery.parameters || []);
          const result = await Promise.race([execPromise, timeoutPromise]);
          const [rows] = result as any;
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
          return Object.keys(obj).some(k => k === '$where' || k === '$function' || (typeof obj[k] === 'object' && containsDangerousMongo(obj[k])));
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
            query = query.limit(Math.min(limit || DEFAULT_ROW_LIMIT, DEFAULT_ROW_LIMIT));
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
            const limitedPipeline = Array.isArray(pipeline) ? [...pipeline] : pipeline;
            // Append limit if none exists
            if (Array.isArray(limitedPipeline) && !limitedPipeline.some((st: any) => st.$limit)) {
              limitedPipeline.push({ $limit: DEFAULT_ROW_LIMIT });
            }
            return await model.aggregate(limitedPipeline).exec();

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

  // Explicit profiling endpoint: returns normalized schema JSON and capability summary
  public async profileDatabase(dbUrl: string, dbType?: DBType): Promise<{ schema: string; capabilitySummary: string; dbType: DBType }> {
    const conn = await this.dbPool.get(dbUrl, dbType);
    const effectiveType = conn.type as DBType;
    const schema = await this.schemaRegistry.getOrBuildSchemaString(dbUrl, effectiveType, conn, true);
    const capabilitySummary = await this.profiler.getCapabilitiesSummary(conn);
    return { schema, capabilitySummary, dbType: effectiveType };
  }

  // Lightweight connection check (reuses pool/connection, will not create duplicates for same URL)
  public async testConnection(dbUrl: string, dbType?: DBType): Promise<{ ok: boolean; type?: DBType; details?: any }> {
    return this.dbPool.getConnectionStatus(dbUrl, dbType);
  }
}
