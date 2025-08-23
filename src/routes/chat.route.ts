import { Router } from 'express';
import { ChatController } from '@controllers/chat.controller';
import { Routes } from '@interfaces/routes.interface';
import { AuthMiddleware } from '@middlewares/auth.middleware';

export class ChatRoute implements Routes {
  public path = '/chat';
  public router = Router();
  public chat = new ChatController();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // GET /chat/sessions - Get user's chat sessions
    this.router.get(`${this.path}/sessions`, AuthMiddleware, this.chat.getUserSessions);

    // GET /chat/sessions/:sessionId/history - Get session message history
    this.router.get(`${this.path}/sessions/:sessionId/history`, AuthMiddleware, this.chat.getSessionHistory);

    // PUT /chat/sessions/:sessionId/title - Update session title
    this.router.put(`${this.path}/sessions/:sessionId/title`, AuthMiddleware, this.chat.updateSessionTitle);

    // DELETE /chat/sessions/:sessionId - Delete session
    this.router.delete(`${this.path}/sessions/:sessionId`, AuthMiddleware, this.chat.deleteSession);

    // GET /chat/stats - Get chat statistics
    this.router.get(`${this.path}/stats`, AuthMiddleware, this.chat.getChatStats);

    // GET /chat/search - Search messages
    this.router.get(`${this.path}/search`, AuthMiddleware, this.chat.searchMessages);
  }
}
