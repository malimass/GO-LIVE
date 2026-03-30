import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from '../logging/logger.js';

export interface FfmpegHealth {
  fps: number;
  bitrate: string;
  speed: string;
  uptime: number;
}

export interface DestinationConfig {
  name: string;
  rtmpUrl: string;
  streamKey: string;
}

export type ProcessStatus = 'idle' | 'running' | 'error' | 'stopped';

export class FfmpegProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private _status: ProcessStatus = 'idle';
  private startTime = 0;
  private lastHealth: FfmpegHealth | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  readonly maxRetries = 3;
  readonly destination: DestinationConfig;
  private inputUrl: string;

  constructor(inputUrl: string, destination: DestinationConfig) {
    super();
    this.inputUrl = inputUrl;
    this.destination = destination;
  }

  get status(): ProcessStatus {
    return this._status;
  }

  get health(): FfmpegHealth | null {
    return this.lastHealth;
  }

  start(): void {
    if (this.process) {
      logger.warn(`[${this.destination.name}] Already running, skipping start`);
      return;
    }

    const outputUrl = `${this.destination.rtmpUrl}${this.destination.streamKey}`;

    const args = [
      '-rw_timeout', '10000000',
      '-i', this.inputUrl,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      outputUrl,
    ];

    logger.info(`[${this.destination.name}] Starting ffmpeg relay`);

    this.process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this._status = 'running';
    this.startTime = Date.now();

    this.process.stderr?.on('data', (data: Buffer) => {
      const line = data.toString();
      this.parseHealth(line);
    });

    this.process.on('close', (code) => {
      this.process = null;

      if (this._status === 'stopped') {
        logger.info(`[${this.destination.name}] Stopped gracefully`);
        return;
      }

      if (code !== 0) {
        logger.error(`[${this.destination.name}] Exited with code ${code}`);
        this._status = 'error';
        this.attemptRestart();
      }
    });

    this.process.on('error', (err) => {
      logger.error(`[${this.destination.name}] Process error: ${err.message}`);
      this._status = 'error';
      this.process = null;
      this.attemptRestart();
    });
  }

  stop(): void {
    this._status = 'stopped';
    this.retryCount = 0;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.process) {
      this.process.kill('SIGTERM');
      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
          this.process = null;
        }
      }, 5000);
    }
  }

  resetRetries(): void {
    this.retryCount = 0;
  }

  private attemptRestart(): void {
    if (this.retryCount >= this.maxRetries) {
      logger.error(`[${this.destination.name}] Max retries (${this.maxRetries}) reached — giving up`);
      this._status = 'error';
      this.emit('failed', this.destination.name);
      return;
    }

    this.retryCount++;
    const delay = Math.pow(3, this.retryCount) * 5000; // 5s, 15s, 45s
    logger.info(`[${this.destination.name}] Retry ${this.retryCount}/${this.maxRetries} in ${delay / 1000}s`);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, delay);
  }

  private parseHealth(line: string): void {
    // Parse ffmpeg stderr progress line
    const fpsMatch = line.match(/fps=\s*([\d.]+)/);
    const bitrateMatch = line.match(/bitrate=\s*([\d.]+\w+\/s)/);
    const speedMatch = line.match(/speed=\s*([\d.]+x)/);

    if (fpsMatch || bitrateMatch || speedMatch) {
      this.lastHealth = {
        fps: fpsMatch ? parseFloat(fpsMatch[1]) : (this.lastHealth?.fps ?? 0),
        bitrate: bitrateMatch ? bitrateMatch[1] : (this.lastHealth?.bitrate ?? '0kbits/s'),
        speed: speedMatch ? speedMatch[1] : (this.lastHealth?.speed ?? '0x'),
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
      };
      this.emit('health', this.lastHealth);
    }
  }
}
