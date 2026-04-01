import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from '../logging/logger.js';

/**
 * Preprocesses the incoming RTMP stream by adding an overlay image.
 * Re-encodes video once, outputs to a local RTMP path.
 * All destination processes can then copy from this preprocessed stream.
 */
export class OverlayPreprocessor extends EventEmitter {
  private process: ChildProcess | null = null;
  private inputUrl: string;
  private outputUrl: string;
  private overlayPath: string;

  constructor(inputUrl: string, outputUrl: string, overlayPath: string) {
    super();
    this.inputUrl = inputUrl;
    this.outputUrl = outputUrl;
    this.overlayPath = overlayPath;
  }

  start(): void {
    if (this.process) return;

    logger.info('[Overlay] Starting preprocessor');

    const args = [
      '-rw_timeout', '10000000',
      '-i', this.inputUrl,
      '-i', this.overlayPath,
      '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:H-h:shortest=1',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-b:v', '2000k',
      '-maxrate', '2500k',
      '-bufsize', '4000k',
      '-g', '60',
      '-c:a', 'copy',
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      this.outputUrl,
    ];

    this.process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const stderrBuffer: string[] = [];
    this.process.stderr?.on('data', (data: Buffer) => {
      stderrBuffer.push(data.toString().trim());
      if (stderrBuffer.length > 20) stderrBuffer.shift();
    });

    this.process.on('close', (code) => {
      if (code !== 0 && code !== null) {
        const lastLines = stderrBuffer.filter(l => l.length > 0).join('\n');
        logger.error(`[Overlay] Exited with code ${code}. Output:\n${lastLines}`);
      }
      this.process = null;
      this.emit('stopped');
    });

    this.process.on('error', (err) => {
      logger.error(`[Overlay] Process error: ${err.message}`);
      this.process = null;
    });
  }

  stop(): void {
    if (!this.process) return;
    logger.info('[Overlay] Stopping preprocessor');
    this.process.kill('SIGTERM');
    setTimeout(() => {
      if (this.process) {
        this.process.kill('SIGKILL');
        this.process = null;
      }
    }, 5000);
  }

  get isRunning(): boolean {
    return this.process !== null;
  }
}
