import { Router } from 'express';
import { AIAgentController } from '@controllers/ai-agent.controller';
import { Routes } from '@interfaces/routes.interface';
import { ValidationMiddleware } from '@middlewares/validation.middleware';
import { AuthMiddleware } from '@middlewares/auth.middleware';
import { AIQueryDto, ProfileDbDto } from '@dtos/ai-agent.dto';

export class AIAgentRoute implements Routes {
  public path = '/ai-agent';
  public router = Router();
  public aiAgent = new AIAgentController();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // POST /ai-agent/query - Process natural language query (requires authentication)
    this.router.post(`${this.path}/query`, AuthMiddleware, ValidationMiddleware(AIQueryDto), this.aiAgent.processQuery);

    // GET /ai-agent/samples - Get sample queries (public)
    this.router.get(`${this.path}/samples`, this.aiAgent.getSampleQueries);

    // GET /ai-agent/status - Get AI agent status (public)
    this.router.get(`${this.path}/status`, this.aiAgent.getStatus);

    // POST /ai-agent/feedback - Record feedback for a query (requires authentication)
    this.router.post(`${this.path}/feedback`, AuthMiddleware, this.aiAgent.recordFeedback);

    // GET /ai-agent/stats - Get user statistics (requires authentication)
    this.router.get(`${this.path}/stats`, AuthMiddleware, this.aiAgent.getUserStats);

    // POST /ai-agent/refresh-schema - Refresh schema cache (requires authentication)
    this.router.post(`${this.path}/refresh-schema`, AuthMiddleware, this.aiAgent.refreshSchema);

    // POST /ai-agent/profile - Profile DB and return normalized schema (requires authentication)
    this.router.post(`${this.path}/profile`, AuthMiddleware, ValidationMiddleware(ProfileDbDto), this.aiAgent.profileDatabase);

    // POST /ai-agent/check-connection - Check DB connection status (requires authentication)
    this.router.post(`${this.path}/check-connection`, AuthMiddleware, ValidationMiddleware(ProfileDbDto), this.aiAgent.checkConnection);
  }
}
