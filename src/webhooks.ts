import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { db } from './db';
import { signPayload, deliver } from './delivery';
import { logger } from './logger';

export const webhooksRouter = Router();

interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  cursor: string | null;
  active: boolean;
}

webhooksRouter.post('/:id/ping', async (req: Request, res: Response) => {
  const { id } = req.params;

  const webhook = db
    .prepare('SELECT id, url, secret, cursor, active FROM webhooks WHERE id = ?')
    .get(id) as WebhookRow | undefined;

  if (!webhook) {
    return res.status(404).json({ error: 'webhook not found' });
  }

  const payload = {
    id: randomUUID(),
    type: 'ping',
    createdAt: new Date().toISOString(),
    data: {},
  };

  const body = JSON.stringify(payload);
  const signature = signPayload(body, webhook.secret);

  const startedAt = Date.now();
  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    const result = await deliver(webhook.url, body, signature);
    statusCode = result.statusCode;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.warn({ webhookId: webhook.id, err }, 'webhook ping delivery failed');
  }

  const latencyMs = Date.now() - startedAt;

  return res.status(200).json({
    webhookId: webhook.id,
    statusCode,
    latencyMs,
    ok: statusCode !== null && statusCode >= 200 && statusCode < 300,
    error,
  });
});
