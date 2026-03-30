import NodeMediaServer from 'node-media-server';
import { logger } from '../logging/logger.js';
import type { Config } from '../config/index.js';
import type { DistributionManager } from '../distribution/manager.js';

export function createRtmpServer(config: Config, distribution: DistributionManager): NodeMediaServer {
  const nms = new NodeMediaServer({
    rtmp: {
      port: config.rtmpPort,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
    },
    http: {
      port: 0,
      allow_origin: '*',
    },
  });

  nms.on('prePublish', (id: string, streamPath: string, args: Record<string, string>) => {
    const session = nms.getSession(id);
    const key = streamPath.split('/').pop();

    if (key !== config.rtmpIngestKey) {
      logger.warn(`Rejected unauthorized stream attempt on path: ${streamPath}`);
      session.reject();
      return;
    }

    logger.info('Authorized stream connected - starting distribution');
    distribution.onStreamStart(streamPath).catch((err) => {
      logger.error(`Failed to start distribution: ${err.message}`);
    });
  });

  nms.on('donePublish', (id: string, streamPath: string) => {
    logger.info('Stream disconnected - stopping distribution');
    distribution.onStreamStop().catch((err) => {
      logger.error(`Failed to stop distribution: ${err.message}`);
    });
  });

  nms.on('prePlay', (id: string, streamPath: string, args: Record<string, string>) => {
    // Allow internal ffmpeg processes to read the stream
    logger.debug(`Play request: ${streamPath}`);
  });

  return nms;
}
