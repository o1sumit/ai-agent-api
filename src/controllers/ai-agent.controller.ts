import { AIQueryRequest } from '@interfaces/ai-agent.interface';
import { RequestWithUser } from '@interfaces/auth.interface';
import { AIAgentService } from '@services/ai-agent.service';
import { NextFunction, Request, Response } from 'express';
import { Container } from 'typedi';

export class AIAgentController {
  public aiAgent = Container.get(AIAgentService);

  public processQuery = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const { query, dbUrl, dbType, refreshSchema }: AIQueryRequest = req.body;
      const userId = req.user?._id || 'anonymous';

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({
          message: 'Query is required and must be a non-empty string',
        });
      }

      if (!dbUrl || typeof dbUrl !== 'string' || dbUrl.trim().length === 0) {
        return res.status(400).json({
          message: 'dbUrl is required and must be a non-empty string',
        });
      }

      const result = await this.aiAgent.processQuery(query.trim(), userId.toString(), { dbUrl: dbUrl.trim(), dbType, refreshSchema });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

  public getSampleQueries = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const queries = await this.aiAgent.getSampleQueries();

      res.status(200).json({
        queries,
        message: 'Sample queries retrieved successfully',
      });
    } catch (error) {
      next(error);
    }
  };

  public getStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json({
        status: 'active',
        message: 'AI Agent is running with dynamic schema detection, user memory, multi-database, and safe CRUD support',
        supportedOperations: ['find', 'findOne', 'count', 'aggregate', 'insertOne', 'updateOne', 'deleteOne', 'sql'],
        features: [
          'Dynamic schema detection',
          'Multi-database support (MongoDB, PostgreSQL, MySQL)',
          'Connection pooling',
          'Safe CRUD with strict guardrails',
          'User-specific memory',
          'Query optimization based on history',
          'Personalized suggestions',
          'Authentication integration',
        ],
      });
    } catch (error) {
      next(error);
    }
  };

  public recordFeedback = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const { queryId, feedback } = req.body;
      const userId = req.user?._id || 'anonymous';

      if (!queryId || !feedback || !['positive', 'negative'].includes(feedback)) {
        return res.status(400).json({
          message: 'QueryId and feedback (positive/negative) are required',
        });
      }

      await this.aiAgent.recordFeedback(userId.toString(), queryId, feedback);

      res.status(200).json({
        message: 'Feedback recorded successfully',
      });
    } catch (error) {
      next(error);
    }
  };

  public getUserStats = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id || 'anonymous';
      const stats = await this.aiAgent.getUserStats(userId.toString());

      res.status(200).json({
        data: stats,
        message: 'User statistics retrieved successfully',
      });
    } catch (error) {
      next(error);
    }
  };

  public refreshSchema = async (req: Request, res: Response, next: NextFunction) => {
    try {
      await this.aiAgent.refreshSchemaCache();

      res.status(200).json({
        message: 'Schema cache refreshed successfully',
      });
    } catch (error) {
      next(error);
    }
  };
}
