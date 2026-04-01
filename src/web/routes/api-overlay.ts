import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { logger } from '../../logging/logger.js';

const OVERLAY_DIR = path.join(process.cwd(), 'data');
const OVERLAY_PATH = path.join(OVERLAY_DIR, 'overlay.png');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo immagini (PNG, JPG, WebP)'));
    }
  },
});

export function createApiOverlayRouter(): Router {
  const router = Router();

  // GET - check if overlay exists
  router.get('/', (_req, res) => {
    const exists = fs.existsSync(OVERLAY_PATH);
    res.json({
      enabled: exists,
      url: exists ? '/api/overlay/image' : null,
    });
  });

  // GET - serve the overlay image
  router.get('/image', (_req, res) => {
    if (!fs.existsSync(OVERLAY_PATH)) {
      res.status(404).json({ error: 'Nessun overlay configurato' });
      return;
    }
    res.sendFile(OVERLAY_PATH);
  });

  // POST - upload overlay image
  router.post('/', upload.single('overlay'), (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Nessun file caricato' });
        return;
      }

      if (!fs.existsSync(OVERLAY_DIR)) {
        fs.mkdirSync(OVERLAY_DIR, { recursive: true });
      }

      fs.writeFileSync(OVERLAY_PATH, req.file.buffer);
      logger.info(`Overlay image uploaded (${req.file.size} bytes)`);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // DELETE - remove overlay
  router.delete('/', (_req, res) => {
    try {
      if (fs.existsSync(OVERLAY_PATH)) {
        fs.unlinkSync(OVERLAY_PATH);
        logger.info('Overlay image removed');
      }
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
