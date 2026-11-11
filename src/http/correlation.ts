import type { Request, Response } from 'express';
import { newId } from '../shared/ids';

const SAFE = /^[\x21-\x7e]{1,128}$/;

/** Uses the caller's X-Correlation-Id when present, otherwise creates one. */
export function correlationIdOf(req: Request, res: Response): string {
  const header = req.headers['x-correlation-id'];
  const id = typeof header === 'string' && SAFE.test(header) ? header : newId();
  res.setHeader('X-Correlation-Id', id);
  return id;
}
