import { chromium, type Browser, type BrowserContext, type Page, type Cookie } from 'playwright';
import { logger } from '../logging/logger.js';

export interface StreamKeyResult {
  url: string;
  key: string;
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InstagramKeyExtractor {
  private username: string;
  private cookies: Cookie[];
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(username: string, cookies: Cookie[]) {
    this.username = username;
    this.cookies = cookies;
  }

  async extractStreamKey(): Promise<StreamKeyResult> {
    logger.info(`[IG:${this.username}] Launching browser`);

    this.browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });

    // Load cookies
    await this.context.addCookies(this.cookies);
    this.page = await this.context.newPage();

    // Navigate to Instagram
    logger.info(`[IG:${this.username}] Navigating to Instagram`);
    await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle' });
    await randomDelay(2000, 4000);

    // Check if redirected to login (cookies expired)
    if (this.page.url().includes('/accounts/login')) {
      await this.cleanup();
      throw new Error(`Cookies expired for ${this.username} — login page detected`);
    }

    // Navigate to Live Producer
    logger.info(`[IG:${this.username}] Opening Live Producer`);
    await this.page.goto('https://www.instagram.com/live/producer/', { waitUntil: 'networkidle' });
    await randomDelay(2000, 5000);

    // Check for errors or restrictions
    const pageContent = await this.page.content();
    if (pageContent.includes('Page Not Found') || pageContent.includes('unavailable')) {
      const htmlSnippet = pageContent.substring(0, 500);
      logger.error(`[IG:${this.username}] Live Producer not available. Page: ${htmlSnippet}`);
      await this.cleanup();
      throw new Error(`Live Producer unavailable for ${this.username}`);
    }

    // Wait for stream URL and key to appear
    logger.info(`[IG:${this.username}] Waiting for stream key elements`);

    try {
      // Instagram Live Producer shows "Stream URL" and "Stream key" fields
      // Try multiple selectors for robustness
      const streamUrlSelectors = [
        'input[aria-label*="Stream URL" i]',
        'input[placeholder*="rtmp" i]',
        '[data-testid="stream-url"] input',
        'text=Stream URL >> .. >> input',
      ];

      const streamKeySelectors = [
        'input[aria-label*="Stream key" i]',
        'input[type="password"]',
        '[data-testid="stream-key"] input',
        'text=Stream key >> .. >> input',
      ];

      let streamUrl = '';
      let streamKey = '';

      // Try each selector for stream URL
      for (const selector of streamUrlSelectors) {
        try {
          const el = await this.page.waitForSelector(selector, { timeout: 5000 });
          if (el) {
            streamUrl = await el.inputValue() || await el.getAttribute('value') || '';
            if (streamUrl) break;
          }
        } catch {
          continue;
        }
      }

      // Try each selector for stream key
      for (const selector of streamKeySelectors) {
        try {
          const el = await this.page.waitForSelector(selector, { timeout: 5000 });
          if (el) {
            streamKey = await el.inputValue() || await el.getAttribute('value') || '';
            if (streamKey) break;
          }
        } catch {
          continue;
        }
      }

      if (!streamUrl || !streamKey) {
        // Fallback: try to find by intercepting network requests
        logger.warn(`[IG:${this.username}] Could not find stream fields via selectors, trying alternative methods`);

        // Try clicking any "Go Live" or "Start" button first
        const goLiveSelectors = [
          'button:has-text("Go live")',
          'button:has-text("Go Live")',
          'button:has-text("Start")',
          '[role="button"]:has-text("Go")',
        ];

        for (const selector of goLiveSelectors) {
          try {
            await this.page.click(selector, { timeout: 3000 });
            await randomDelay(3000, 5000);
            break;
          } catch {
            continue;
          }
        }

        // Try selectors again after clicking
        for (const selector of streamUrlSelectors) {
          try {
            const el = await this.page.waitForSelector(selector, { timeout: 5000 });
            if (el) {
              streamUrl = await el.inputValue() || await el.getAttribute('value') || '';
              if (streamUrl) break;
            }
          } catch {
            continue;
          }
        }

        for (const selector of streamKeySelectors) {
          try {
            const el = await this.page.waitForSelector(selector, { timeout: 5000 });
            if (el) {
              streamKey = await el.inputValue() || await el.getAttribute('value') || '';
              if (streamKey) break;
            }
          } catch {
            continue;
          }
        }
      }

      if (!streamUrl || !streamKey) {
        // Last resort: dump page for debugging
        const html = await this.page.content();
        logger.error(`[IG:${this.username}] Failed to extract stream key. Page HTML saved for debugging.`);
        logger.debug(`[IG:${this.username}] Page HTML (first 2000 chars): ${html.substring(0, 2000)}`);
        await this.cleanup();
        throw new Error(`Could not extract stream key for ${this.username}`);
      }

      logger.info(`[IG:${this.username}] Stream key extracted successfully`);

      return { url: streamUrl, key: streamKey };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Could not extract')) {
        throw err;
      }
      logger.error(`[IG:${this.username}] Unexpected error during key extraction`);
      await this.cleanup();
      throw err;
    }
  }

  async endLive(): Promise<void> {
    logger.info(`[IG:${this.username}] Ending live session`);

    if (this.page) {
      try {
        // Try to click "End Live" button
        const endSelectors = [
          'button:has-text("End live")',
          'button:has-text("End Live")',
          'button:has-text("End")',
          '[role="button"]:has-text("End")',
        ];

        for (const selector of endSelectors) {
          try {
            await this.page.click(selector, { timeout: 3000 });
            await randomDelay(1000, 2000);

            // Confirm end
            const confirmSelectors = [
              'button:has-text("End live video")',
              'button:has-text("End Live Video")',
              'button:has-text("Confirm")',
            ];
            for (const confirm of confirmSelectors) {
              try {
                await this.page.click(confirm, { timeout: 2000 });
                break;
              } catch {
                continue;
              }
            }
            break;
          } catch {
            continue;
          }
        }
      } catch (err) {
        logger.warn(`[IG:${this.username}] Could not click End Live button`);
      }
    }

    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close();
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      this.page = null;
    } catch {
      // Ignore cleanup errors
    }
  }
}
