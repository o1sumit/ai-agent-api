import 'reflect-metadata';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import path from 'path';
import helmet from 'helmet';
import hpp from 'hpp';
import morgan from 'morgan';
import { createServer, Server } from 'http';
import crypto from 'crypto';
import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Container } from 'typedi';
import { NODE_ENV, PORT, LOG_FORMAT, ORIGIN, CREDENTIALS } from '@config';
import { dbConnection } from '@database';
import { Routes } from '@interfaces/routes.interface';
import { ErrorMiddleware } from '@middlewares/error.middleware';
import { WebSocketChatService } from '@services/websocket-chat.service';
import { logger, stream } from '@utils/logger';

export class App {
  public app: express.Application;
  public server: Server;
  public env: string;
  public port: string | number;
  private chatService: WebSocketChatService;

  constructor(routes: Routes[]) {
    this.app = express();
    this.server = createServer(this.app);
    this.env = NODE_ENV || 'development';
    this.port = PORT || 3000;

    this.connectToDatabase();
    this.initializeMiddlewares();
    this.initializeRoutes(routes);
    this.initializeSwagger();
    this.initializeWebSocket();
    this.initializeErrorHandling();
  }

  public listen() {
    this.server.listen(this.port, () => {
      logger.info(`=================================`);
      logger.info(`======= ENV: ${this.env} =======`);
      logger.info(`🚀 App listening on the port ${this.port}`);
      logger.info(`📡 WebSocket Chat Service enabled`);
      logger.info(`=================================`);
    });
  }

  public getServer() {
    return this.server;
  }

  public getApp() {
    return this.app;
  }

  private async connectToDatabase() {
    await dbConnection();
  }

  private initializeMiddlewares() {
    // Request ID middleware for correlation
    this.app.use((req, _res, next) => {
      (req as any).requestId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      next();
    });

    this.app.use(morgan(LOG_FORMAT, { stream }));
    this.app.use(cors({ origin: ORIGIN, credentials: CREDENTIALS }));
    this.app.use(hpp());
    this.app.use(helmet());
    this.app.use(compression());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(cookieParser());
  }

  private initializeRoutes(routes: Routes[]) {
    // Serve static playground for WebSocket testing
    this.app.use('/playground', express.static(path.join(process.cwd(), 'playground')));

    routes.forEach(route => {
      this.app.use('/', route.router);
    });
  }

  private initializeSwagger() {
    const options = {
      swaggerDefinition: {
        info: {
          title: 'AI Agent API with WebSocket Chat',
          version: '1.0.0',
          description: 'Advanced AI Agent API with WebSocket-based chat service',
        },
      },
      apis: ['swagger.yaml'],
    };

    const specs = swaggerJSDoc(options);
    this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));
  }

  private initializeWebSocket() {
    this.chatService = Container.get(WebSocketChatService);
    this.chatService.initialize(this.server);

    // Setup periodic cleanup of inactive sessions
    setInterval(() => {
      this.chatService.cleanupInactiveSessions();
    }, 30 * 60 * 1000); // Every 30 minutes
  }

  private initializeErrorHandling() {
    this.app.use(ErrorMiddleware);
  }
}
