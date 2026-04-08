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
  private fbAutoStartManagers: FacebookBroadcastManager[] = [];
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
        if (fb.mode === 'stream_key' || fb.mode === 'stream_key_auto') {
          // Static stream key — send video via permanent key
          const useProxy = fbDestinations.length > 0 && !!process.env.SOCKS5_PROXY;
          logger.info(`[FB:${fb.name}] Using permanent stream key${fb.mode === 'stream_key_auto' ? ' (auto-start enabled)' : ''}${useProxy ? ' (via proxy)' : ''}`);
          fbDestinations.push({
            name: fb.name,
            rtmpUrl: fb.rtmpUrl,
            streamKey: fb.streamKey,
            useProxy,
          });

          if (fb.mode === 'stream_key_auto') {
            // Store a manager to auto-start via API (no endBroadcast — FB auto-ends when stream stops)
            const manager = new FacebookBroadcastManager(fb.pageId, fb.name, fb.pageAccessToken, fb.liveTitle);
            this.fbAutoStartManagers.push(manager);
          }
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
            useProxy: fbDestinations.length > 0 && !!process.env.SOCKS5_PROXY,
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
            useProxy: fbDestinations.length > 0 && !!process.env.SOCKS5_PROXY,
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

    // Wait for ffmpeg to connect and send first frames, then auto-start broadcasts
    const needsDelayedStart = this.igExtractors.length > 0 || this.fbAutoStartManagers.length > 0;
    if (needsDelayedStart) {
      setTimeout(async () => {
        // Auto-start Facebook stream_key_auto broadcasts
        for (const manager of this.fbAutoStartManagers) {
          try {
            await manager.goLiveOnStreamKey();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to auto-start FB broadcast: ${msg}`);
          }
        }

        // Start Instagram broadcasts
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

    // End all Facebook live broadcasts (with 10s timeout each)
    const fbEndPromises = this.fbManagers.map((manager) =>
      Promise.race([
        manager.endBroadcast(),
        new Promise<void>((resolve) => setTimeout(() => {
          logger.warn('Timeout ending FB live — skipping');
          resolve();
        }, 10000)),
      ]).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error ending FB live: ${msg}`);
      })
    );
    await Promise.all(fbEndPromises);
    this.fbManagers = [];
    this.fbAutoStartManagers = [];

    // Close all Instagram sessions (with 10s timeout each)
    const igEndPromises = this.igExtractors.map((extractor) =>
      Promise.race([
        extractor.endLive(),
        new Promise<void>((resolve) => setTimeout(() => {
          logger.warn('Timeout ending IG live — skipping');
          resolve();
        }, 10000)),
      ]).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error ending IG live: ${msg}`);
      })
    );
    await Promise.all(igEndPromises);
    this.igExtractors = [];

    this.emit('stopped');
  }
}
