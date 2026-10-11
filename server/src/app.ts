import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { config } from './config.js';
import { requireAuth, requireRole } from './auth/session.js';
import { errorHandler } from './lib/http.js';
import { authRouter } from './routes/auth.js';
import { clientsRouter } from './routes/clients.js';
import { documentsRouter } from './routes/documents.js';
import { dashboardRouter } from './routes/dashboard.js';
import { usersRouter } from './routes/users.js';
import { adminRouter } from './routes/admin.js';
import { tripsRouter } from './routes/trips.js';
import { companiesRouter } from './routes/companies.js';
import { trashRouter } from './routes/trash.js';
import { activityRouter } from './routes/activity.js';
import { cronRouter } from './routes/cron.js';

/**
 * Rejects cross-site state-changing requests. Together with the SameSite=strict
 * session cookie this protects against CSRF.
 */
function sameOriginOnly(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let host: string | null = null;
  try {
    host = new URL(origin).host;
  } catch {
    // fall through to rejection
  }
  if (host === req.get('host') || origin === config.appUrl) return next();
  res.status(403).json({ error: 'Cross-site request blocked' });
}

export function createApp() {
  const app = express();
  if (config.isProd) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'data:', 'blob:'],
          // pdf.js decodes some scanned image formats with WebAssembly.
          'script-src': ["'self'", "'wasm-unsafe-eval'"],
          'worker-src': ["'self'"],
          'upgrade-insecure-requests': config.isProd ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(sameOriginOnly);

  // For the host's health checks; reveals nothing.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/cron', cronRouter);
  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth);
  // Settings the browser needs (e.g. the upload size limit, which is lower on Vercel).
  app.get('/api/config', (_req, res) => {
    res.json({ maxUploadMb: config.maxUploadMb, scheduledAlerts: !config.onVercel });
  });
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/trips', tripsRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api/travellers', clientsRouter);
  app.use('/api/clients', clientsRouter); // older name, kept for compatibility
  app.use('/api/documents', documentsRouter);
  app.use('/api/activity', activityRouter);
  app.use('/api/trash', requireRole('admin'), trashRouter);
  app.use('/api/users', requireRole('admin'), usersRouter);
  app.use('/api/admin', requireRole('admin'), adminRouter);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Serve the built React app in production.
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
