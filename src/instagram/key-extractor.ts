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

function normalizeCookies(cookies: Record<string, unknown>[]): Cookie[] {
  return cookies.map((c) => {
    const sameSite = String(c.sameSite || 'Lax');
    let normalizedSameSite: 'Strict' | 'Lax' | 'None' = 'Lax';
    if (sameSite.toLowerCase() === 'strict') normalizedSameSite = 'Strict';
    else if (sameSite.toLowerCase() === 'none' || sameSite === 'no_restriction' || sameSite === 'unspecified') normalizedSameSite = 'None';
    else normalizedSameSite = 'Lax';

    return {
      name: String(c.name || ''),
      value: String(c.value || ''),
      domain: String(c.domain || ''),
      path: String(c.path || '/'),
      expires: typeof c.expirationDate === 'number' ? c.expirationDate : (typeof c.expires === 'number' ? c.expires : -1),
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: normalizedSameSite,
    } as Cookie;
  }).filter((c) => c.name && c.domain);
}

export class InstagramKeyExtractor {
  private username: string;
  private cookies: Cookie[];
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(username: string, cookies: Cookie[] | Record<string, unknown>[]) {
    this.username = username;
    this.cookies = normalizeCookies(cookies as Record<string, unknown>[]);
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
      locale: 'it-IT',
    });

    await this.context.addCookies(this.cookies);
    this.page = await this.context.newPage();

    // Navigate to Instagram
    logger.info(`[IG:${this.username}] Navigating to Instagram`);
    await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle' });
    await randomDelay(2000, 4000);

    // Check if redirected to login
    if (this.page.url().includes('/accounts/login')) {
      await this.cleanup();
      throw new Error(`Cookies expired for ${this.username} — login page detected`);
    }

    // Navigate to Live Producer
    logger.info(`[IG:${this.username}] Opening Live Producer`);
    await this.page.goto('https://www.instagram.com/live/producer/', { waitUntil: 'networkidle' });
    await randomDelay(3000, 5000);

    logger.info(`[IG:${this.username}] Waiting for stream key elements`);

    try {
      // Strategy 1: Find all text on the page containing rtmp URL
      let streamUrl = '';
      let streamKey = '';

      // Look for rtmp URL in the page text or input values
      const allInputs = await this.page.$$('input, textarea');
      for (const input of allInputs) {
        const val = await input.inputValue().catch(() => '');
        const placeholder = await input.getAttribute('placeholder').catch(() => '');
        const ariaLabel = await input.getAttribute('aria-label').catch(() => '');

        if (val.includes('rtmp')) {
          streamUrl = val;
          logger.info(`[IG:${this.username}] Found stream URL in input`);
        } else if (streamUrl && !streamKey && val.length > 10) {
          // The key is usually the next input after the URL
          streamKey = val;
          logger.info(`[IG:${this.username}] Found stream key in input`);
        }

        // Check aria labels / placeholders for stream key hints
        const label = (ariaLabel || placeholder || '').toLowerCase();
        if (label.includes('stream key') || label.includes('chiave') || label.includes('streaming key')) {
          if (val) {
            streamKey = val;
            logger.info(`[IG:${this.username}] Found stream key via label: ${label}`);
          }
        }
        if (label.includes('stream url') || label.includes('url dello streaming') || label.includes('server url')) {
          if (val) {
            streamUrl = val;
            logger.info(`[IG:${this.username}] Found stream URL via label: ${label}`);
          }
        }
      }

      // Strategy 2: Look for the URL in page text content
      if (!streamUrl || !streamKey) {
        const pageText = await this.page.evaluate('document.body.innerText') as string;

        // Extract rtmp URL from page text
        const rtmpMatch = pageText.match(/(rtmps?:\/\/[^\s]+)/);
        if (rtmpMatch && !streamUrl) {
          streamUrl = rtmpMatch[1];
          logger.info(`[IG:${this.username}] Found stream URL in page text`);
        }

        // Look for the key pattern (long string with ? and parameters)
        const keyMatch = pageText.match(/(\d{10,}\?[^\s]+)/);
        if (keyMatch && !streamKey) {
          streamKey = keyMatch[1];
          logger.info(`[IG:${this.username}] Found stream key in page text`);
        }
      }

      // Strategy 3: Look in spans/divs that might contain copyable text
      if (!streamUrl || !streamKey) {
        const elements = await this.page.$$('span, div, p');
        for (const el of elements) {
          const text = await el.innerText().catch(() => '');
          if (text.includes('rtmp') && !streamUrl) {
            streamUrl = text.trim();
          }
          // Key pattern: starts with numbers, has ? and params
          if (/^\d{10,}\?/.test(text.trim()) && !streamKey) {
            streamKey = text.trim();
          }
        }
      }

      if (!streamUrl || !streamKey) {
        // Save page content for debugging
        const html = await this.page.content();
        const pageText = await this.page.evaluate('document.body.innerText') as string;
        logger.error(`[IG:${this.username}] Could not extract stream key.`);
        logger.debug(`[IG:${this.username}] Page text: ${pageText.substring(0, 3000)}`);
        await this.cleanup();
        throw new Error(`Could not extract stream key for ${this.username}`);
      }

      logger.info(`[IG:${this.username}] Stream key extracted successfully`);
      return { url: streamUrl, key: streamKey };

    } catch (err) {
      if (err instanceof Error && err.message.includes('Could not extract')) {
        throw err;
      }
      logger.error(`[IG:${this.username}] Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      await this.cleanup();
      throw err;
    }
  }

  async endLive(): Promise<void> {
    logger.info(`[IG:${this.username}] Ending live session`);

    if (this.page) {
      try {
        const endSelectors = [
          'button:has-text("End live")',
          'button:has-text("End Live")',
          'button:has-text("Termina")',
          'button:has-text("Fine")',
          'button:has-text("End")',
        ];

        for (const selector of endSelectors) {
          try {
            await this.page.click(selector, { timeout: 3000 });
            await randomDelay(1000, 2000);
            break;
          } catch {
            continue;
          }
        }
      } catch {
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
