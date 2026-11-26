import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { deliverWebhook } from '../lib/webhookDelivery';
import { signPayload } from '../lib/webhookSigning';
import { logger } from '../lib/logger';

const router = Router();

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  secret: z.string().min(16).optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = createWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const webhook = await prisma.webhook.create({
    data: {
      url: parsed.data.url,
      events: parsed.data.events,
      secret: parsed.data.secret,
    },
  });

  return res.status(201).json(webhook);
});

router.get('/', async (_req: Request, res: Response) => {
  const webhooks = await prisma.webhook.findMany({ orderBy: { createdAt: 'desc' } });
  return res.json(webhooks);
});

router.get('/:id', async (req: Request, res: Response) => {
  const webhook = await prisma.webhook.findUnique({ where: { id: req.params.id } });
  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  return res.json(webhook);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const webhook = await prisma.webhook.findUnique({ where: { id: req.params.id } });
  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  await prisma.webhook.delete({ where: { id: req.params.id } });
  return res.status(204).send();
});

router.post('/:id/ping', async (req: Request, res: Response) => {
  const webhook = await prisma.webhook.findUnique({ where: { id: req.params.id } });
  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  const payload = {
    type: 'ping' as const,
    webhookId: webhook.id,
    sentAt: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const signature = signPayload(body, webhook.secret);

  const startedAt = Date.now();
  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    const result = await deliverWebhook({
      url: webhook.url,
      body,
      signature,
    });
    statusCode = result.statusCode;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Delivery failed';
    logger.warn({ err, webhookId: webhook.id }, 'Webhook ping delivery failed');
  }

  const latencyMs = Date.now() - startedAt;

  return res.json({
    webhookId: webhook.id,
    type: payload.type,
    statusCode,
    latencyMs,
    ok: statusCode !== null && statusCode >= 200 && statusCode < 300,
    error,
  });
});

export default router;
