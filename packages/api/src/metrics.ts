import { Counter, Registry } from 'prom-client';

export const registry = new Registry();

export const webhookDeliveries = new Counter({
  name: 'webhook_deliveries_total',
  help: 'Total number of webhook delivery attempts',
  labelNames: ['status'],
  registers: [registry],
});

export const webhookDeadLetters = new Counter({
  name: 'webhook_dead_letters_total',
  help: 'Total number of webhook events moved to the dead-letter list',
  registers: [registry],
});

export const webhookRedeliveries = new Counter({
  name: 'webhook_redeliveries_total',
  help: 'Total number of dead-lettered webhook events re-queued for delivery',
  labelNames: ['status'],
  registers: [registry],
});
