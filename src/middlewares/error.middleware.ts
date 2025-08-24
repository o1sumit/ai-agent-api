import { NextFunction, Request, Response } from 'express';
import { HttpException } from '@exceptions/HttpException';
import { logger } from '@utils/logger';

export const ErrorMiddleware = (error: HttpException, req: Request, res: Response, next: NextFunction) => {
  try {
    const status: number = error.status || 500;
    const message: string = error.message || 'Something went wrong';

    const requestId = (req as any).requestId;
    const meta: any = { requestId, method: req.method, path: req.path, status };
    if (error && (error as any).stack) meta.stack = (error as any).stack;
    logger.error(`[${req.method}] ${req.path} >> StatusCode:: ${status}, Message:: ${message}` , meta);
    res.status(status).json({ message });
  } catch (error) {
    next(error);
  }
};
