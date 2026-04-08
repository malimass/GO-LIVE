import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Config } from '../config/index.js';
import type { DistributionManager } from '../distribution/manager.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createApiStatusRouter } from './routes/api-status.js';
import { createApiConfigRouter } from './routes/api-config.js';
import { createApiStreamRouter } from './routes/api-stream.js';
import { createApiLogsRouter } from './routes/api-logs.js';
import { createApiOverlayRouter } from './routes/api-overlay.js';
import { createFacebookOAuthRouter } from './routes/api-facebook-oauth.js';
import { createApiPhoneStreamRouter } from './routes/api-phone-stream.js';
import { PhoneIngestManager } from './phone-ingest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

declare module 'express-session' {
  interface SessionData {
    authenticated: boolean;
    fbOAuthState?: string;
    fbOAuthPages?: Array<{ id: string; name: string; access_token: string }>;
  }
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.session.authenticated) {
    next();
    return;
  }
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.redirect('/login');
}

export function createWebApp(config: Config, distribution: DistributionManager): { app: express.Application; phoneIngest: PhoneIngestManager } {
  const app = express();
  const phoneIngest = new PhoneIngestManager(config, distribution);

  // Trust proxy (nginx HTTPS)
  app.set('trust proxy', 1);

  // View engine
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, '../../public')));
  app.use(session({
    secret: config.dashboardPassword + '_session',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  }));

  // Login routes (no auth required)
  app.get('/login', (_req, res) => {
    res.render('login', { error: null });
  });

  app.post('/login', (req, res) => {
    if (req.body.password === config.dashboardPassword) {
      req.session.authenticated = true;
      res.redirect('/');
    } else {
      res.render('login', { error: 'Password errata' });
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  });

  // Health check (no auth — for Railway)
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', live: distribution.isLive });
  });

  // Protected routes
  app.use(requireAuth);
  app.use('/', createDashboardRouter(config, distribution));
  app.use('/api/status', createApiStatusRouter(distribution));
  app.use('/api/config', createApiConfigRouter(config));
  app.use('/api/stream', createApiStreamRouter(distribution, config));
  app.use('/api/logs', createApiLogsRouter());
  app.use('/api/overlay', createApiOverlayRouter());
  app.use('/api/facebook-oauth', createFacebookOAuthRouter(config));
  app.use('/api/phone-stream', createApiPhoneStreamRouter(phoneIngest));

  app.get('/phone', (req, res) => {
    res.render('phone-stream', { ingestKey: config.rtmpIngestKey });
  });

  return { app, phoneIngest };
}
