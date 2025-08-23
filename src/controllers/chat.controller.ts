import { NextFunction, Response } from 'express';
import { Container } from 'typedi';
import { WebSocketChatService } from '@services/websocket-chat.service';
import { ChatMessageModel, ChatSessionModel } from '@models/chat.model';
import { RequestWithUser } from '@interfaces/auth.interface';

export class ChatController {
  public chatService = Container.get(WebSocketChatService);

  public getSessionHistory = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const userId = req.user?._id;

      if (!sessionId || !userId) {
        return res.status(400).json({
          message: 'Session ID is required',
        });
      }

      // Verify session ownership
      const session = await ChatSessionModel.findOne({
        id: sessionId,
        userId: userId.toString(),
      });

      if (!session) {
        return res.status(404).json({
          message: 'Session not found',
        });
      }

      // Get messages for the session
      const messages = await ChatMessageModel.find({ sessionId }).sort({ createdAt: 1 }).limit(1000).lean();

      res.status(200).json({
        data: {
          session: session.toObject(),
          messages,
        },
        message: 'Session history retrieved successfully',
      });
    } catch (error) {
      next(error);
    }
  };

  public getUserSessions = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;
      const { limit = 20, offset = 0 } = req.query;

      if (!userId) {
        return res.status(400).json({
          message: 'User ID is required',
        });
      }

      const sessions = await ChatSessionModel.find({
        userId: userId.toString(),
        isActive: true,
      })
        .sort({ lastActivity: -1 })
        .limit(Number(limit))
        .skip(Number(offset))
        .lean();

      const totalSessions = await ChatSessionModel.countDocuments({
        userId: userId.toString(),
        isActive: true,
      });

      res.status(200).json({
        data: {
          sessions,
          pagination: {
            total: totalSessions,
            limit: Number(limit),
            offset: Number(offset),
            hasMore: Number(offset) + sessions.length < totalSessions,
          },
        },
        message: 'Sessions retrieved successfully',
      });
    } catch (error) {
      next(error);
    }
  };

  public updateSessionTitle = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const { title } = req.body;
      const userId = req.user?._id;

      if (!sessionId || !userId || !title) {
        return res.status(400).json({
          message: 'Session ID and title are required',
        });
      }

      const session = await ChatSessionModel.findOneAndUpdate(
        {
          id: sessionId,
          userId: userId.toString(),
        },
        { title },
        { new: true },
      );

      if (!session) {
        return res.status(404).json({
          message: 'Session not found',
        });
      }

      res.status(200).json({
        data: session.toObject(),
        message: 'Session title updated successfully',
      });
    } catch (error) {
      next(error);
    }
  };

  public deleteSession = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const userId = req.user?._id;

      if (!sessionId || !userId) {
        return res.status(400).json({
          message: 'Session ID is required',
        });
      }

      const session = await ChatSessionModel.findOneAndUpdate(
        {
          id: sessionId,
          userId: userId.toString(),
        },
        { isActive: false },
        { new: true },
      );

      if (!session) {
        return res.status(404).json({
          message: 'Session not found',
        });
      }

      res.status(200).json({
        message: 'Session deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  };

  public getChatStats = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;

      if (!userId) {
        return res.status(400).json({
          message: 'User ID is required',
        });
      }

      const [totalSessions, totalMessages, activeSessions] = await Promise.all([
        ChatSessionModel.countDocuments({ userId: userId.toString() }),
        ChatMessageModel.countDocuments({ userId: userId.toString() }),
        ChatSessionModel.countDocuments({ userId: userId.toString(), isActive: true }),
      ]);

      const recentActivity = await ChatMessageModel.find({
        userId: userId.toString(),
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('message type createdAt sessionId')
        .lean();

      res.status(200).json({
        data: {
          totalSessions,
          totalMessages,
          activeSessions,
          recentActivity,
          connectedUsers: this.chatService.getConnectedUsersCount(),
          activeChatSessions: this.chatService.getActiveSessionsCount(),
        },
        message: 'Chat statistics retrieved successfully',
      });
    } catch (error) {
      next(error);
    }
  };

  public searchMessages = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;
      const { query, sessionId, limit = 50 } = req.query;

      if (!userId || !query) {
        return res.status(400).json({
          message: 'Search query is required',
        });
      }

      const searchFilter: any = {
        userId: userId.toString(),
        message: { $regex: query, $options: 'i' },
      };

      if (sessionId) {
        searchFilter.sessionId = sessionId;
      }

      const messages = await ChatMessageModel.find(searchFilter).sort({ createdAt: -1 }).limit(Number(limit)).populate('sessionId', 'title').lean();

      res.status(200).json({
        data: messages,
        message: 'Messages found',
      });
    } catch (error) {
      next(error);
    }
  };
}
