import { loadConfig } from './config/index.js';
import { logger } from './logging/logger.js';
import { createRtmpServer } from './rtmp/server.js';
import { DistributionManager } from './distribution/manager.js';
import { createWebApp } from './web/app.js';

async function main() {
  logger.info('GO-LIVE starting...');

  const config = loadConfig();
  logger.info(`Configured ${config.facebook.length} Facebook + ${config.instagram.length} Instagram destinations`);

  const distributionManager = new DistributionManager(config);

  // Start RTMP ingest server
  const rtmpServer = createRtmpServer(config, distributionManager);
  rtmpServer.run();
  logger.info(`RTMP server listening on port ${config.rtmpPort}`);

  // Start web dashboard
  const app = createWebApp(config, distributionManager);
  app.listen(config.port, () => {
    logger.info(`Dashboard available at http://localhost:${config.port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await distributionManager.stopAll();
    rtmpServer.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
