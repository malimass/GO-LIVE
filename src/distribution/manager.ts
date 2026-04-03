import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { FfmpegProcess, type DestinationConfig, type ProcessStatus, type FfmpegHealth } from './ffmpeg-process.js';
import { OverlayPreprocessor } from './overlay-preprocessor.js';
import { InstagramKeyExtractor } from '../instagram/key-extractor.js';
import { FacebookBroadcastManager } from '../facebook/broadcast-manager.js';
import { FacebookCookieBroadcaster } from '../facebook/cookie-broadcaster.js';
import { CookieManager } from '../instagram/cookie-manager.js';
import { logger } from '../logging/logger.js';
import type { Config } from '../config/index.js';

const OVERLAY_PATH = path.join(process.cwd(), 'data', 'overlay.png');
const PROCESSED_STREAM_PATH = '/processed/stream';

export interface DestinationStatus {
  name: string;
  platform: 'facebook' | 'instagram';
  status: ProcessStatus;
  health: FfmpegHealth | null;
}

export class DistributionManager extends EventEmitter {
  private processes: FfmpegProcess[] = [];
  private igExtractors: InstagramKeyExtractor[] = [];
  private fbManagers: FacebookBroadcastManager[] = [];
  private overlayPreprocessor: OverlayPreprocessor | null = null;
  private cookieManager: CookieManager;
  private config: Config;
  private _isLive = false;
  private _streamPath: string | null = null;
  private _startedAt: Date | null = null;

  constructor(config: Config) {
    super();
    this.config = config;
    this.cookieManager = new CookieManager(config.encryptionKey);
  }

  get isLive(): boolean {
    return this._isLive;
  }

  get startedAt(): Date | null {
    return this._startedAt;
  }

  private fbNames = new Set<string>();

  getStatuses(): DestinationStatus[] {
    return this.processes.map((p) => ({
      name: p.destination.name,
      platform: this.fbNames.has(p.destination.name) ? 'facebook' as const : 'instagram' as const,
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
    this._startedAt = new Date();
    const rawInputUrl = `rtmp://127.0.0.1:${this.config.rtmpPort}${streamPath}`;

    logger.info(`Starting distribution from ${streamPath}`);

    // If overlay image exists, start preprocessor
    let inputUrl = rawInputUrl;
    const hasOverlay = fs.existsSync(OVERLAY_PATH);
    if (hasOverlay) {
      const processedUrl = `rtmp://127.0.0.1:${this.config.rtmpPort}${PROCESSED_STREAM_PATH}`;
      this.overlayPreprocessor = new OverlayPreprocessor(rawInputUrl, processedUrl, OVERLAY_PATH);
      this.overlayPreprocessor.start();
      inputUrl = processedUrl;
      logger.info('[Overlay] Preprocessor started, destinations will use processed stream');
      // Give the preprocessor time to connect and start publishing
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    // Create Facebook live broadcasts via Graph API or use static stream keys
    this.fbNames.clear();
    const fbDestinations: DestinationConfig[] = [];
    for (const fb of this.config.facebook) {
      try {
        if (fb.mode === 'stream_key') {
          // Static stream key — no Graph API needed
          logger.info(`[FB:${fb.name}] Using permanent stream key`);
          fbDestinations.push({
            name: fb.name,
            rtmpUrl: fb.rtmpUrl,
            streamKey: fb.streamKey,
          });
        } else if (fb.mode === 'cookie') {
          // Cookie-based mode — bypass app restrictions
          logger.info(`[FB:${fb.name}] Creating live via cookie auth`);
          const cookies = this.cookieManager.decryptCookies(fb.cookiesEnc);
          const broadcaster = new FacebookCookieBroadcaster(fb.pageId, fb.name, cookies, fb.liveTitle, fb.liveDescription);
          const result = await broadcaster.createBroadcast();

          fbDestinations.push({
            name: fb.name,
            rtmpUrl: result.url,
            streamKey: result.key,
          });

          this.fbManagers.push(broadcaster as any);
        } else {
          // Graph API mode — create live broadcast
          logger.info(`Creating Facebook live for ${fb.name}...`);
          const manager = new FacebookBroadcastManager(fb.pageId, fb.name, fb.pageAccessToken, fb.liveTitle);
          const result = await manager.createBroadcast();

          fbDestinations.push({
            name: fb.name,
            rtmpUrl: result.url,
            streamKey: result.key,
          });

          this.fbManagers.push(manager);
        }
        this.fbNames.add(fb.name);
        logger.info(`Got stream URL for Facebook ${fb.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to create FB live for ${fb.name}: ${msg}`);
        this.emit('fb-error', { name: fb.name, error: msg });
      }
    }

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
    this._startedAt = null;

    // Stop overlay preprocessor
    if (this.overlayPreprocessor) {
      this.overlayPreprocessor.stop();
      this.overlayPreprocessor = null;
    }

    // Stop all ffmpeg processes
    for (const proc of this.processes) {
      proc.stop();
    }
    this.processes = [];

    // End all Facebook live broadcasts
    for (const manager of this.fbManagers) {
      try {
        await manager.endBroadcast();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error ending FB live: ${msg}`);
      }
    }
    this.fbManagers = [];

    // Close all Instagram sessions
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
