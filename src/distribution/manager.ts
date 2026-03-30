import { EventEmitter } from 'events';
import { FfmpegProcess, type DestinationConfig, type ProcessStatus, type FfmpegHealth } from './ffmpeg-process.js';
import { InstagramKeyExtractor } from '../instagram/key-extractor.js';
import { CookieManager } from '../instagram/cookie-manager.js';
import { logger } from '../logging/logger.js';
import type { Config } from '../config/index.js';

export interface DestinationStatus {
  name: string;
  platform: 'facebook' | 'instagram';
  status: ProcessStatus;
  health: FfmpegHealth | null;
}

export class DistributionManager extends EventEmitter {
  private processes: FfmpegProcess[] = [];
  private igExtractors: InstagramKeyExtractor[] = [];
  private cookieManager: CookieManager;
  private config: Config;
  private _isLive = false;
  private _streamPath: string | null = null;

  constructor(config: Config) {
    super();
    this.config = config;
    this.cookieManager = new CookieManager(config.encryptionKey);
  }

  get isLive(): boolean {
    return this._isLive;
  }

  getStatuses(): DestinationStatus[] {
    return this.processes.map((p) => ({
      name: p.destination.name,
      platform: p.destination.name.toLowerCase().startsWith('facebook') ? 'facebook' as const : 'instagram' as const,
      status: p.status,
      health: p.health,
    }));
  }

  async onStreamStart(streamPath: string): Promise<void> {
    if (this._isLive) {
      logger.warn('Distribution already active, ignoring duplicate start');
      return;
    }

    this._isLive = true;
    this._streamPath = streamPath;
    const inputUrl = `rtmp://127.0.0.1:${this.config.rtmpPort}${streamPath}`;

    logger.info(`Starting distribution from ${streamPath}`);

    // Build Facebook destinations (immediate — keys already known)
    const fbDestinations: DestinationConfig[] = this.config.facebook.map((fb) => ({
      name: fb.name,
      rtmpUrl: fb.rtmpUrl,
      streamKey: fb.streamKey,
    }));

    // Extract Instagram stream keys via Playwright
    const igDestinations: DestinationConfig[] = [];
    for (const ig of this.config.instagram) {
      try {
        logger.info(`Extracting stream key for ${ig.username}...`);
        const cookies = this.cookieManager.decryptCookies(ig.cookiesEnc);
        const extractor = new InstagramKeyExtractor(ig.username, cookies, ig.liveTitle, ig.audience);
        const result = await extractor.extractStreamKey();

        igDestinations.push({
          name: ig.name,
          rtmpUrl: result.url,
          streamKey: result.key,
        });

        this.igExtractors.push(extractor);
        logger.info(`Got stream key for ${ig.username}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to get IG key for ${ig.username}: ${msg}`);
        this.emit('ig-error', { username: ig.username, error: msg });
      }
    }

    // Start all ffmpeg processes
    const allDestinations = [...fbDestinations, ...igDestinations];

    if (allDestinations.length === 0) {
      logger.error('No valid destinations — cannot start distribution');
      this._isLive = false;
      return;
    }

    logger.info(`Starting ${allDestinations.length} ffmpeg processes`);

    for (const dest of allDestinations) {
      const proc = new FfmpegProcess(inputUrl, dest);

      proc.on('failed', (name: string) => {
        logger.error(`Destination ${name} permanently failed`);
        this.emit('destination-failed', name);
      });

      proc.on('health', () => {
        this.emit('health-update');
      });

      this.processes.push(proc);
      proc.start();
    }

    // Wait for ffmpeg to connect and send first frames, then tell Instagram to "Go Live"
    if (this.igExtractors.length > 0) {
      setTimeout(async () => {
        for (const extractor of this.igExtractors) {
          try {
            await extractor.startBroadcast();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to start IG broadcast: ${msg}`);
          }
        }
      }, 8000);
    }

    this.emit('started', allDestinations.length);
  }

  async onStreamStop(): Promise<void> {
    if (!this._isLive) return;

    logger.info('Stopping all distribution');
    await this.stopAll();
  }

  async stopAll(): Promise<void> {
    this._isLive = false;
    this._streamPath = null;

    // Stop all ffmpeg processes
    for (const proc of this.processes) {
      proc.stop();
    }
    this.processes = [];

    // Close all Instagram Playwright sessions
    for (const extractor of this.igExtractors) {
      try {
        await extractor.endLive();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error ending IG live: ${msg}`);
      }
    }
    this.igExtractors = [];

    this.emit('stopped');
  }
}
