import { GOOGLE_API_KEY, GOOGLE_MODEL, DEFAULT_ROW_LIMIT, QUERY_TIMEOUT_MS } from '@config';
import { AgentResponse, AgentState, DatabaseTool } from '@interfaces/chat.interface';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { DynamicTool } from '@langchain/core/tools';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { END, START, StateGraph } from '@langchain/langgraph';
import { UserModel } from '@models/users.model';
import { logger } from '@utils/logger';
import mongoose from 'mongoose';
import { Service } from 'typedi';
import { AIMemoryService } from './ai-memory.service';
import { SchemaRegistryService } from './schema-registry.service';
import { SchemaDetectorService } from './schema-detector.service';

@Service()
export class DatabaseAgentService {
  private llm: ChatGoogleGenerativeAI;
  private schemaDetector: SchemaDetectorService;
  private schemaRegistry: SchemaRegistryService;
  private memoryService: AIMemoryService;
  private graph: any;

  constructor() {
    this.llm = new ChatGoogleGenerativeAI({
      apiKey: GOOGLE_API_KEY,
      model: GOOGLE_MODEL,
      temperature: 0.1,
    });

    this.schemaDetector = new SchemaDetectorService();
    this.schemaRegistry = new SchemaRegistryService();
    this.memoryService = new AIMemoryService();
    this.initializeAgent();
  }

  private initializeAgent() {
    // Create the state graph for the agent workflow
    const g: any = new StateGraph<AgentState>({
      channels: {
        messages: { reducer: (x, y) => x.concat(y) },
        currentQuery: { reducer: (x, y) => y ?? x },
        context: { reducer: (x, y) => ({ ...x, ...y }) },
        tools: { reducer: (x, y) => y ?? x },
        thinking: { reducer: (x, y) => y ?? x },
        finalResponse: { reducer: (x, y) => y ?? x },
      },
    });

    // Define the agent workflow nodes
    g.addNode('analyze_query', this.analyzeQuery.bind(this));
    g.addNode('load_context', this.loadContext.bind(this));
    g.addNode('plan_execution', this.planExecution.bind(this));
    g.addNode('execute_tools', this.executeTools.bind(this));
    g.addNode('generate_response', this.generateResponse.bind(this));

    // Define the workflow edges
    g.addEdge(START, 'analyze_query');
    g.addEdge('analyze_query', 'load_context');
    g.addEdge('load_context', 'plan_execution');
    g.addEdge('plan_execution', 'execute_tools');
    g.addEdge('execute_tools', 'generate_response');
    g.addEdge('generate_response', END);

    this.graph = g.compile();
  }

  public async processMessage(message: string, userId: string, _sessionId: string, conversationHistory: any[] = []): Promise<AgentResponse> {
    try {
      // Handle greetings/small talk upfront with no DB actions
      if (this.isGreeting(message)) {
        const polite = await this.composeGeneralResponse(message, userId);
        return {
          message: polite,
          type: 'text',
          confidence: 0.9,
        };
      }

      // Initialize the agent state
      const initialState: AgentState = {
        messages: [new HumanMessage(message)],
        currentQuery: message,
        context: {
          userId,
          sessionId: _sessionId,
          conversationHistory,
        },
        tools: await this.createDatabaseTools(),
      };

      // Execute the agent workflow
      const result = await this.graph.invoke(initialState);

      return (
        result.finalResponse || {
          message: 'I apologize, but I encountered an issue processing your request.',
          type: 'error' as const,
          confidence: 0,
        }
      );
    } catch (error) {
      logger.error(`Database agent error: ${error.message}`);
      return {
        message: 'I encountered an error while processing your request. Please try again.',
        type: 'error',
        confidence: 0,
      };
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

  private async composeGeneralResponse(message: string, userId: string): Promise<string> {
    try {
      const memoryService = this.memoryService;
      const insights = await memoryService.getMemoryInsights(userId, message);
      const prompt = `You are a mature, helpful assistant. The user message appears to be greeting or small talk.

User: "${message}"
User preferences: ${JSON.stringify(insights?.userPreferences || {}, null, 2)}

Respond briefly and warmly (1-2 short sentences). Offer help and mention you can:
- answer questions
- query connected databases
- perform light data analysis and recommendations.
Do not include any raw data or technical details.`;
      const res = await this.llm.invoke([new SystemMessage(prompt), new HumanMessage('Please reply with 1-2 short sentences only.')]);
      return res.content.toString();
    } catch (e: any) {
      return 'Hi! How can I help you today? I can answer questions or analyze your data.';
    }
  }

  private async analyzeQuery(state: AgentState): Promise<Partial<AgentState>> {
    const query = state.currentQuery || '';
    const thinking = `Analyzing user query: "${query}"`;
    const started = Date.now();
    logger.info(`Agent thinking: ${thinking}`);

    // Determine query intent and complexity
    const queryAnalysis = await this.llm.invoke([
      new SystemMessage(`Analyze this user query and determine:
1. Intent (data_retrieval, data_analysis, question_answering, conversation)
2. Complexity (simple, medium, complex)
3. Required database operations
4. Expected response type

Query: "${query}"`),
      new HumanMessage('Return a short analysis.'),
    ]);

    logger.info(`analyze_query completed in ${Date.now() - started}ms`);
    return {
      thinking,
      context: {
        ...state.context,
        queryAnalysis: queryAnalysis.content.toString(),
      },
    };
  }

  private async loadContext(state: AgentState): Promise<Partial<AgentState>> {
    const { userId } = state.context;
    const thinking = 'Loading database schema and user context...';
    const started = Date.now();

    // Load database schema (reuse persistent registry when possible)
    let schemaInfo = '';
    try {
      // Fallback: use default mongoose connection schema when no external dbUrl here
      const schemas = await this.schemaDetector.getAllSchemas();
      schemaInfo = this.schemaDetector.getSchemaAsString(schemas);
    } catch (e: any) {
      logger.warn(`Schema load failed in loadContext: ${e.message}`);
      schemaInfo = '[]';
    }

    // Load user memory
    const memoryInsights = await this.memoryService.getMemoryInsights(userId, state.currentQuery || '');

    logger.info(`load_context completed in ${Date.now() - started}ms`);
    return {
      thinking,
      context: {
        ...state.context,
        databaseSchema: schemaInfo,
        userMemory: memoryInsights,
      },
    };
  }

  private async planExecution(state: AgentState): Promise<Partial<AgentState>> {
    const thinking = 'Planning the best approach to answer your question...';
    const started = Date.now();

    const planningPrompt = `Based on the user query and available context, create an execution plan.

User Query: "${state.currentQuery}"
Database Schema: ${state.context.databaseSchema}
User Memory: ${JSON.stringify(state.context.userMemory, null, 2)}

Available Tools:
${state.tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n')}

Create a step-by-step plan to answer the user's query effectively.`;

    const plan = await this.llm.invoke([new SystemMessage(planningPrompt), new HumanMessage('Return only the plan text.')]);

    logger.info(`plan_execution completed in ${Date.now() - started}ms`);
    return {
      thinking,
      context: {
        ...state.context,
        executionPlan: plan.content.toString(),
      },
    };
  }

  private async executeTools(state: AgentState): Promise<Partial<AgentState>> {
    const thinking = 'Executing database operations...';
    const toolResults: any[] = [];
    const started = Date.now();

    try {
      // Create dynamic tools for this execution
      const tools = await this.createDynamicTools();

      // Use the LLM to decide which tools to use and how
      const toolSelectionPrompt = `You are an execution planner. Choose database tools to run.

User Query: "${state.currentQuery}"
Plan: ${state.context.executionPlan}

Available Tools:
${tools.map(tool => `${tool.name}: ${tool.description}`).join('\n')}

Strictly output a JSON array of objects with this schema (no prose):
[
  { "name": "query_users" | "count_documents" | "aggregate_data", "input": { ...toolSpecificParams } }
]

Rules:
- Only include tools you truly need.
- Validate that required params are present.
- For reads, include reasonable limits.`;

      const toolDecision = await this.llm.invoke([
        new SystemMessage(toolSelectionPrompt),
        new HumanMessage('Return ONLY the JSON array of tool calls.'),
      ]);

      // Parse and execute tools based on the decision
      const toolsToExecute = this.parseToolExecution(toolDecision.content.toString());

      for (const toolExec of toolsToExecute) {
        const tool = tools.find(t => t.name === toolExec.name);
        if (tool) {
          try {
            const result = await tool.call(JSON.stringify(toolExec.input));
            toolResults.push({
              tool: toolExec.name,
              input: toolExec.input,
              result,
            });
          } catch (error) {
            logger.error(`Tool execution error: ${error.message}`);
            toolResults.push({
              tool: toolExec.name,
              input: toolExec.input,
              error: error.message,
            });
          }
        }
      }
    } catch (error) {
      logger.error(`Tool execution planning error: ${error.message}`);
    }

    logger.info(`execute_tools completed in ${Date.now() - started}ms`);
    return {
      thinking,
      context: {
        ...state.context,
        toolResults,
      },
    };
  }

  private async generateResponse(state: AgentState): Promise<Partial<AgentState>> {
    const thinking = 'Generating final response...';
    const started = Date.now();

    const responsePrompt = `Generate a helpful response based on the database query results.

Original Query: "${state.currentQuery}"
Tool Results: ${JSON.stringify(state.context.toolResults, null, 2)}
User Memory: ${JSON.stringify(state.context.userMemory, null, 2)}

Provide a clear, helpful response that:
1. Directly answers the user's question
2. Includes relevant data if retrieved
3. Suggests follow-up questions if appropriate
4. Uses the user's preferred communication style based on their history

Response format should be conversational and user-friendly.`;

    const response = await this.llm.invoke([new SystemMessage(responsePrompt), new HumanMessage('Write a concise, friendly response.')]);

    const finalResponse: AgentResponse = {
      message: response.content.toString(),
      type: 'text',
      data: state.context.toolResults?.filter(r => !r.error).map(r => r.result),
      toolsUsed: state.context.toolResults?.map(r => r.tool) || [],
      confidence: this.calculateConfidence(state.context.toolResults || []),
      followUpQuestions: this.generateFollowUpQuestions(state.currentQuery || '', state.context.toolResults || []),
    };

    logger.info(`generate_response completed in ${Date.now() - started}ms`);
    return {
      thinking,
      finalResponse,
    };
  }

  private async createDatabaseTools(): Promise<DatabaseTool[]> {
    return [
      {
        name: 'query_users',
        description: 'Query user data from the database',
        parameters: {
          type: 'object',
          properties: {
            filter: { type: 'object', description: 'MongoDB filter object' },
            limit: { type: 'number', description: 'Maximum number of results' },
            sort: { type: 'object', description: 'Sort criteria' },
          },
          required: ['filter'],
        },
      },
      {
        name: 'count_documents',
        description: 'Count documents in a collection',
        parameters: {
          type: 'object',
          properties: {
            collection: { type: 'string', description: 'Collection name' },
            filter: { type: 'object', description: 'MongoDB filter object' },
          },
          required: ['collection', 'filter'],
        },
      },
      {
        name: 'aggregate_data',
        description: 'Perform aggregation operations on data',
        parameters: {
          type: 'object',
          properties: {
            collection: { type: 'string', description: 'Collection name' },
            pipeline: { type: 'array', description: 'Aggregation pipeline' },
          },
          required: ['collection', 'pipeline'],
        },
      },
    ];
  }

  private async createDynamicTools() {
    const tools = [
      new DynamicTool({
        name: 'query_users',
        description: 'Query user data from the database',
        func: async (input: string) => {
          try {
            const params = JSON.parse(input || '{}');
            const filter = params.filter || {};
            // Guardrails: block dangerous operators
            const containsDangerous = (obj: any): boolean => {
              if (!obj || typeof obj !== 'object') return false;
              if (Array.isArray(obj)) return obj.some(containsDangerous);
              return Object.keys(obj).some(k => k === '$where' || k === '$function' || (typeof obj[k] === 'object' && containsDangerous(obj[k])));
            };
            if (containsDangerous(filter)) throw new Error('Dangerous Mongo operator in filter');

            const limit = Math.min(Number(params.limit) || 10, DEFAULT_ROW_LIMIT);
            const sort = params.sort || {};
            const projection = { password: 0 };
            const result = await UserModel.find(filter, projection).limit(limit).sort(sort).maxTimeMS(QUERY_TIMEOUT_MS);
            return JSON.stringify(result);
          } catch (error) {
            return `Error: ${error.message}`;
          }
        },
      }),
      new DynamicTool({
        name: 'count_documents',
        description: 'Count documents in a collection',
        func: async (input: string) => {
          try {
            const params = JSON.parse(input || '{}');
            if (!params.collection) throw new Error('collection is required');
            const model = this.getModelForCollection(params.collection);
            const count = await model.countDocuments(params.filter || {}).maxTimeMS(QUERY_TIMEOUT_MS);
            return count.toString();
          } catch (error) {
            return `Error: ${error.message}`;
          }
        },
      }),
      new DynamicTool({
        name: 'aggregate_data',
        description: 'Perform aggregation operations on data',
        func: async (input: string) => {
          try {
            const params = JSON.parse(input || '{}');
            if (!params.collection || !Array.isArray(params.pipeline)) throw new Error('collection and pipeline are required');
            const model = this.getModelForCollection(params.collection);
            const pipeline = [...params.pipeline];
            if (pipeline.some((st: any) => st.$out || st.$merge)) throw new Error('Dangerous aggregation stage blocked');
            if (!pipeline.some((st: any) => st.$limit)) pipeline.push({ $limit: DEFAULT_ROW_LIMIT });
            const result = await model.aggregate(pipeline).option({ maxTimeMS: QUERY_TIMEOUT_MS });
            return JSON.stringify(result);
          } catch (error) {
            return `Error: ${error.message}`;
          }
        },
      }),
    ];

    return tools;
  }

  private getModelForCollection(collectionName: string): any {
    const modelMap: { [key: string]: any } = {
      users: UserModel,
    };

    const existingModel = Object.values(mongoose.models).find((model: any) => model.collection.name === collectionName);

    return existingModel || modelMap[collectionName] || UserModel;
  }

  private parseToolExecution(toolDecision: string): Array<{ name: string; input: any }> {
    try {
      const allowed = new Set(['query_users', 'count_documents', 'aggregate_data']);
      const parsed = JSON.parse(this.sanitizeJsonContent(toolDecision));
      if (!Array.isArray(parsed)) return [];
      const cleaned: Array<{ name: string; input: any }> = [];
      for (const item of parsed) {
        const name = String(item?.name || '');
        const input = item?.input ?? {};
        if (!allowed.has(name)) continue;
        // lightweight validation
        if (name === 'query_users') {
          if (input.limit != null) input.limit = Math.min(Number(input.limit) || 10, DEFAULT_ROW_LIMIT);
          else input.limit = Math.min(10, DEFAULT_ROW_LIMIT);
        }
        if (name !== 'query_users' && !input.collection) continue;
        cleaned.push({ name, input });
      }
      return cleaned;
    } catch {
      return [];
    }
  }

  private sanitizeJsonContent(text: string): string {
    return (text || '')
      .replace(/```json[\s\S]*?```/g, m => m.replace(/```json|```/g, ''))
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false');
  }

  private calculateConfidence(toolResults: any[]): number {
    if (toolResults.length === 0) return 0.3;

    const successfulTools = toolResults.filter(r => !r.error).length;
    const totalTools = toolResults.length;

    return Math.min(0.9, (successfulTools / totalTools) * 0.8 + 0.1);
  }

  private generateFollowUpQuestions(query: string, toolResults: any[]): string[] {
    const questions: string[] = [];

    if (toolResults.some(r => r.tool === 'query_users')) {
      questions.push('Would you like to see more details about any specific user?');
      questions.push('Do you want to filter these results further?');
    }

    if (toolResults.some(r => r.tool === 'count_documents')) {
      questions.push('Would you like to see the actual data, not just the count?');
      questions.push('Do you want to break this down by different criteria?');
    }

    return questions.slice(0, 2); // Limit to 2 follow-up questions
  }
}
