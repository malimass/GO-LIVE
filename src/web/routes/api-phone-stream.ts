import { Router } from 'express';
import { logger } from '../../logging/logger.js';
import type { PhoneIngestManager } from '../phone-ingest.js';

export function createApiPhoneStreamRouter(phoneIngest: PhoneIngestManager): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    res.json(phoneIngest.status);
  });

  router.post('/stop', (_req, res) => {
    if (!phoneIngest.isConnected) {
      res.json({ success: false, message: 'Nessuna connessione telefono attiva' });
      return;
    }
    phoneIngest.disconnect();
    logger.info('[Phone] Stopped manually via dashboard');
    res.json({ success: true });
  });

  return router;
}
