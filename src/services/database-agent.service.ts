import { GOOGLE_API_KEY } from '@config';
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
import { SchemaDetectorService } from './schema-detector.service';

@Service()
export class DatabaseAgentService {
  private llm: ChatGoogleGenerativeAI;
  private schemaDetector: SchemaDetectorService;
  private memoryService: AIMemoryService;
  private graph: StateGraph<AgentState>;

  constructor() {
    this.llm = new ChatGoogleGenerativeAI({
      apiKey: GOOGLE_API_KEY,
      model: 'gemini-1.5-flash',
      temperature: 0.2,
    });

    this.schemaDetector = new SchemaDetectorService();
    this.memoryService = new AIMemoryService();
    this.initializeAgent();
  }

  private initializeAgent() {
    // Create the state graph for the agent workflow
    this.graph = new StateGraph<AgentState>({
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
    this.graph.addNode('analyze_query', this.analyzeQuery.bind(this));
    this.graph.addNode('load_context', this.loadContext.bind(this));
    this.graph.addNode('plan_execution', this.planExecution.bind(this));
    this.graph.addNode('execute_tools', this.executeTools.bind(this));
    this.graph.addNode('generate_response', this.generateResponse.bind(this));

    // Define the workflow edges
    this.graph.addEdge(START, 'analyze_query');
    this.graph.addEdge('analyze_query', 'load_context');
    this.graph.addEdge('load_context', 'plan_execution');
    this.graph.addEdge('plan_execution', 'execute_tools');
    this.graph.addEdge('execute_tools', 'generate_response');
    this.graph.addEdge('generate_response', END);

    this.graph = this.graph.compile();
  }

  public async processMessage(message: string, userId: string, _sessionId: string, conversationHistory: any[] = []): Promise<AgentResponse> {
    try {
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

  private async analyzeQuery(state: AgentState): Promise<Partial<AgentState>> {
    const query = state.currentQuery || '';
    const thinking = `Analyzing user query: "${query}"`;

    logger.info(`Agent thinking: ${thinking}`);

    // Determine query intent and complexity
    const queryAnalysis = await this.llm.invoke([
      new SystemMessage(`Analyze this user query and determine:
1. Intent (data_retrieval, data_analysis, question_answering, conversation)
2. Complexity (simple, medium, complex)
3. Required database operations
4. Expected response type

Query: "${query}"`),
    ]);

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

    // Load database schema
    const schemas = await this.schemaDetector.getAllSchemas();
    const schemaInfo = this.schemaDetector.getSchemaAsString(schemas);

    // Load user memory
    const memoryInsights = await this.memoryService.getMemoryInsights(userId, state.currentQuery || '');

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

    const planningPrompt = `Based on the user query and available context, create an execution plan.

User Query: "${state.currentQuery}"
Database Schema: ${state.context.databaseSchema}
User Memory: ${JSON.stringify(state.context.userMemory, null, 2)}

Available Tools:
${state.tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n')}

Create a step-by-step plan to answer the user's query effectively.`;

    const plan = await this.llm.invoke([new SystemMessage(planningPrompt)]);

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

    try {
      // Create dynamic tools for this execution
      const tools = await this.createDynamicTools();

      // Use the LLM to decide which tools to use and how
      const toolSelectionPrompt = `Based on the execution plan and user query, determine which database operations to perform.

Query: "${state.currentQuery}"
Plan: ${state.context.executionPlan}

Available Tools:
${tools.map(tool => `${tool.name}: ${tool.description}`).join('\n')}

Execute the necessary database operations to answer the user's query.`;

      const toolDecision = await this.llm.invoke([new SystemMessage(toolSelectionPrompt)]);

      // Parse and execute tools based on the decision
      const toolsToExecute = this.parseToolExecution(toolDecision.content.toString());

      for (const toolExec of toolsToExecute) {
        const tool = tools.find(t => t.name === toolExec.name);
        if (tool) {
          try {
            const result = await tool.call(toolExec.input);
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

    const response = await this.llm.invoke([new SystemMessage(responsePrompt)]);

    const finalResponse: AgentResponse = {
      message: response.content.toString(),
      type: 'text',
      data: state.context.toolResults?.filter(r => !r.error).map(r => r.result),
      toolsUsed: state.context.toolResults?.map(r => r.tool) || [],
      confidence: this.calculateConfidence(state.context.toolResults || []),
      followUpQuestions: this.generateFollowUpQuestions(state.currentQuery || '', state.context.toolResults || []),
    };

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
            const params = JSON.parse(input);
            const result = await UserModel.find(params.filter || {}, { password: 0 })
              .limit(params.limit || 10)
              .sort(params.sort || {});
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
            const params = JSON.parse(input);
            const model = this.getModelForCollection(params.collection);
            const count = await model.countDocuments(params.filter || {});
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
            const params = JSON.parse(input);
            const model = this.getModelForCollection(params.collection);
            const result = await model.aggregate(params.pipeline);
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
    // Simple parsing logic - in production, you might want more sophisticated parsing
    const tools: Array<{ name: string; input: any }> = [];

    if (toolDecision.includes('query_users')) {
      tools.push({
        name: 'query_users',
        input: '{"filter": {}, "limit": 10}',
      });
    }

    return tools;
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
