import { Router } from 'express';
import fs from 'fs';

export function createApiLogsRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const logFile = 'logs/go-live.log';

    if (!fs.existsSync(logFile)) {
      res.json({ logs: ['No log file found. Logs are printed to console.'] });
      return;
    }

    try {
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      // Return last 100 lines
      const tail = lines.slice(-100);
      res.json({ logs: tail });
    } catch {
      res.json({ logs: ['Error reading log file'] });
    }
  });

  return router;
}
