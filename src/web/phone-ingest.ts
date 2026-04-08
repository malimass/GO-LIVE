import { WebSocketServer, WebSocket } from 'ws';
import { spawn, type ChildProcess } from 'child_process';
import type { Server } from 'http';
import { logger } from '../logging/logger.js';
import type { Config } from '../config/index.js';
import type { DistributionManager } from '../distribution/manager.js';

export interface PhoneIngestHealth {
  fps: number;
  bitrate: string;
  speed: string;
  uptime: number;
}

export interface PhoneIngestStatus {
  connected: boolean;
  startedAt: string | null;
  health: PhoneIngestHealth | null;
}

export class PhoneIngestManager {
  private wss: WebSocketServer | null = null;
  private activeConnection: WebSocket | null = null;
  private ffmpegProcess: ChildProcess | null = null;
  private startTime: number = 0;
  private lastHealth: PhoneIngestHealth | null = null;
  private stderrBuffer: string[] = [];
  private inputFormat: string = 'webm';
  private config: Config;
  private distribution: DistributionManager;

  constructor(config: Config, distribution: DistributionManager) {
    this.config = config;
    this.distribution = distribution;
  }

  attach(server: Server): void {
    this.wss = new WebSocketServer({
      server,
      path: '/ws/phone-ingest',
      verifyClient: (info, done) => {
        const url = new URL(info.req.url || '', 'http://localhost');
        const token = url.searchParams.get('token');

        if (token !== this.config.rtmpIngestKey) {
          done(false, 401, 'Unauthorized');
          return;
        }
        done(true);
      },
    });

    this.wss.on('connection', (ws: WebSocket) => {
      if (this.activeConnection) {
        ws.close(4001, 'Another phone is already streaming');
        return;
      }

      if (this.distribution.isLive) {
        ws.close(4002, 'Another source is already live');
        return;
      }

      logger.info('[Phone] WebSocket connected, waiting for init message');
      this.activeConnection = ws;
      this.startTime = Date.now();
      this.lastHealth = null;
      this.stderrBuffer = [];
      this.inputFormat = 'webm';

      let initialized = false;

      ws.on('message', (data: Buffer) => {
        // First message is JSON init with mimeType
        if (!initialized) {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'init' && msg.mimeType) {
              this.inputFormat = msg.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
              logger.info(`[Phone] Client format: ${msg.mimeType} -> ffmpeg input: ${this.inputFormat}`);
              this.startFfmpeg();
              initialized = true;
              return;
            }
          } catch {
            // Not JSON — treat as media data, start with default format
            this.startFfmpeg();
            initialized = true;
          }
        }

        if (this.ffmpegProcess?.stdin?.writable) {
          this.ffmpegProcess.stdin.write(data);
        }
      });

      ws.on('close', () => {
        logger.info('[Phone] WebSocket disconnected');
        this.cleanup();
      });

      ws.on('error', (err) => {
        logger.error(`[Phone] WebSocket error: ${err.message}`);
        this.cleanup();
      });
    });

    logger.info('[Phone] WebSocket ingest ready on /ws/phone-ingest');
  }

  private startFfmpeg(): void {
    const rtmpTarget = `rtmp://127.0.0.1:${this.config.rtmpPort}/live/${this.config.rtmpIngestKey}`;

    // For mp4 (Safari/iOS): input is fragmented mp4, video is already H.264 so we can copy
    // For webm (Chrome/Android): input is webm/VP8, need to re-encode to H.264
    const isMP4 = this.inputFormat === 'mp4';

    const args = [
      '-f', isMP4 ? 'mp4' : 'webm',
      ...(isMP4 ? ['-frag_type', 'every_frame'] : []),
      '-i', 'pipe:0',
      ...(isMP4
        ? ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
           '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '1500k', '-g', '30',
           '-c:a', 'aac', '-b:a', '128k', '-ar', '44100']),
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpTarget,
    ];

    this.ffmpegProcess = spawn('ffmpeg', args, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString();
      this.parseHealth(line);
      this.stderrBuffer.push(line.trim());
      if (this.stderrBuffer.length > 20) this.stderrBuffer.shift();
    });

    this.ffmpegProcess.on('close', (code) => {
      const lastLines = this.stderrBuffer.filter(l => l.length > 0).join('\n');
      if (code !== 0 && code !== null) {
        logger.error(`[Phone] ffmpeg exited with code ${code}. Output:\n${lastLines}`);
      } else {
        logger.info('[Phone] ffmpeg exited normally');
      }
      this.ffmpegProcess = null;

      if (this.activeConnection?.readyState === WebSocket.OPEN) {
        this.activeConnection.close(4003, 'ffmpeg process ended');
      }
      this.activeConnection = null;
    });

    this.ffmpegProcess.on('error', (err) => {
      logger.error(`[Phone] ffmpeg error: ${err.message}`);
      this.ffmpegProcess = null;
    });

    logger.info(`[Phone] ffmpeg started -> ${rtmpTarget}`);
  }

  private parseHealth(line: string): void {
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
    }
  }

  private cleanup(): void {
    if (this.ffmpegProcess) {
      this.ffmpegProcess.stdin?.end();
      setTimeout(() => {
        if (this.ffmpegProcess) {
          this.ffmpegProcess.kill('SIGTERM');
          setTimeout(() => {
            if (this.ffmpegProcess) {
              this.ffmpegProcess.kill('SIGKILL');
              this.ffmpegProcess = null;
            }
          }, 5000);
        }
      }, 2000);
    }
    this.activeConnection = null;
    this.lastHealth = null;
  }

  disconnect(): void {
    if (this.activeConnection) {
      this.activeConnection.close(4000, 'Server shutting down');
    }
    this.cleanup();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  get isConnected(): boolean {
    return this.activeConnection !== null;
  }

  get status(): PhoneIngestStatus {
    return {
      connected: this.isConnected,
      startedAt: this.startTime && this.isConnected ? new Date(this.startTime).toISOString() : null,
      health: this.lastHealth,
    };
  }
}
