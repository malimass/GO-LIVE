import { logger } from '../logging/logger.js';
import type { Cookie } from 'playwright';

export interface FbStreamKeyResult {
  url: string;
  key: string;
}

function normalizeCookies(cookies: Record<string, unknown>[]): Cookie[] {
  return cookies.map((c) => {
    const sameSite = String(c.sameSite || 'Lax');
    let normalizedSameSite: 'Strict' | 'Lax' | 'None' = 'Lax';
    if (sameSite.toLowerCase() === 'strict') normalizedSameSite = 'Strict';
    else if (sameSite.toLowerCase() === 'none' || sameSite === 'no_restriction' || sameSite === 'unspecified') normalizedSameSite = 'None';

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

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

export class FacebookCookieBroadcaster {
  private pageId: string;
  private pageName: string;
  private cookies: Cookie[];
  private title: string;
  private description: string;
  private liveVideoId: string | null = null;
  private accessToken: string = '';
  private fbDtsg: string = '';
  private cookieStr: string = '';

  constructor(
    pageId: string,
    pageName: string,
    cookies: Cookie[] | Record<string, unknown>[],
    title?: string,
    description?: string,
  ) {
    this.pageId = pageId;
    this.pageName = pageName;
    this.cookies = normalizeCookies(cookies as Record<string, unknown>[]);
    this.title = title || 'LIVE';
    this.description = description || '';
    this.cookieStr = this.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /**
   * Fetch a Facebook page with cookies and full browser headers
   */
  private async fetchWithCookies(url: string): Promise<{ status: number; html: string }> {
    const response = await fetch(url, {
      headers: { ...BROWSER_HEADERS, 'Cookie': this.cookieStr },
      redirect: 'follow',
    });
    const html = await response.text();
    return { status: response.status, html };
  }

  /**
   * Search HTML for access tokens using multiple patterns
   */
  private findTokenInHtml(html: string, source: string): string | null {
    const patterns: [RegExp, string][] = [
      [/"accessToken":"(EAA[^"]+)"/, 'accessToken'],
      [/"access_token":"(EAA[^"]+)"/, 'access_token'],
      [/"token":"(EAA[^"]+)"/, 'token'],
      [/access_token=(EAA[^&"\\]+)/, 'URL param'],
      [/(EAAG[\w]{30,})/, 'EAAG literal'],
      [/(EAAB[\w]{30,})/, 'EAAB literal'],
      [/(EAAd[\w]{30,})/, 'EAAd literal'],
    ];

    for (const [pattern, label] of patterns) {
      const match = html.match(pattern);
      if (match) {
        const token = match[1] || match[0];
        logger.info(`[FB:${this.pageName}] Token found in ${source} via "${label}" (length: ${token.length})`);
        return token;
      }
    }
    return null;
  }

  /**
   * Extract fb_dtsg and optionally access token from Facebook page
   */
  private async fetchDtsgAndToken(): Promise<void> {
    // Fetch main page for fb_dtsg
    const { status, html } = await this.fetchWithCookies('https://m.facebook.com/');
    logger.info(`[FB:${this.pageName}] m.facebook.com: status=${status}, length=${html.length}`);

    if (status !== 200) {
      logger.warn(`[FB:${this.pageName}] m.facebook.com response (first 500): ${html.substring(0, 500)}`);
    }

    // Extract fb_dtsg
    const dtsgPatterns: RegExp[] = [
      /"DTSGInitialData".*?"token":"([^"]+)"/,
      /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/,
      /"DTSGInitData".*?"token":"([^"]+)"/,
      /{"name":"fb_dtsg","value":"([^"]+)"}/,
      /name="fb_dtsg" value="([^"]+)"/,
      /"dtsg":\{"token":"([^"]+)"/,
    ];

    for (const pattern of dtsgPatterns) {
      const match = html.match(pattern);
      if (match) {
        this.fbDtsg = match[1];
        logger.info(`[FB:${this.pageName}] fb_dtsg extracted`);
        break;
      }
    }

    if (!this.fbDtsg) {
      throw new Error(`Could not extract fb_dtsg for ${this.pageName}`);
    }

    // Also look for tokens in this page
    const token = this.findTokenInHtml(html, 'm.facebook.com');
    if (token) {
      this.accessToken = token;
    }
  }

  /**
   * Try to extract access token from various Facebook pages
   */
  private async extractAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    // Try multiple pages that might contain access tokens
    const urls = [
      `https://business.facebook.com/latest/home?asset_id=${this.pageId}`,
      `https://business.facebook.com/content_management/?asset_id=${this.pageId}`,
      `https://www.facebook.com/pages/?category=your_pages`,
    ];

    for (const url of urls) {
      try {
        const { status, html } = await this.fetchWithCookies(url);
        logger.info(`[FB:${this.pageName}] ${new URL(url).hostname}${new URL(url).pathname}: status=${status}, length=${html.length}`);

        const token = this.findTokenInHtml(html, url);
        if (token) {
          this.accessToken = token;
          return token;
        }

        // Log what we see for debugging
        const eaaIdx = html.indexOf('EAA');
        if (eaaIdx >= 0) {
          logger.info(`[FB:${this.pageName}] Found "EAA" at index ${eaaIdx}: ${html.substring(eaaIdx, eaaIdx + 60)}`);
        }
      } catch (err) {
        logger.warn(`[FB:${this.pageName}] Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new Error(`Could not extract access token for ${this.pageName} from any source`);
  }

  /**
   * Create a live broadcast
   */
  async createBroadcast(): Promise<FbStreamKeyResult> {
    logger.info(`[FB:${this.pageName}] Creating live via cookie auth`);

    // Step 1: Get fb_dtsg and potentially an access token
    await this.fetchDtsgAndToken();

    // Step 2: If no token from initial page, try other sources
    if (!this.accessToken) {
      await this.extractAccessToken();
    }

    // Step 3: Try to get page-specific access token
    let pageToken = this.accessToken;
    try {
      const resp = await fetch(
        `https://graph.facebook.com/v21.0/${this.pageId}?fields=access_token&access_token=${encodeURIComponent(this.accessToken)}`,
        { headers: { 'User-Agent': USER_AGENT } },
      );
      if (resp.ok) {
        const data = await resp.json() as Record<string, string>;
        if (data.access_token) {
          pageToken = data.access_token;
          logger.info(`[FB:${this.pageName}] Got page access token`);
        }
      }
    } catch {
      // Use the user token directly
    }

    // Step 4: Create live video via Graph API
    const params = new URLSearchParams({
      title: this.title,
      description: this.description,
      status: 'LIVE_NOW',
      access_token: pageToken,
    });

    const response = await fetch(
      `https://graph.facebook.com/v21.0/${this.pageId}/live_videos`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: params.toString(),
      },
    );

    const text = await response.text();

    if (!response.ok) {
      logger.error(`[FB:${this.pageName}] Graph API error ${response.status}: ${text.substring(0, 500)}`);
      throw new Error(`Facebook API error ${response.status} for ${this.pageName}`);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Invalid JSON from Graph API for ${this.pageName}: ${text.substring(0, 300)}`);
    }

    const streamUrl = (data.secure_stream_url || data.stream_url) as string;
    if (!streamUrl) {
      logger.error(`[FB:${this.pageName}] No stream URL in response: ${text.substring(0, 300)}`);
      throw new Error(`No stream URL for ${this.pageName}`);
    }

    this.liveVideoId = data.id as string;
    this.accessToken = pageToken;

    const rtmpMatch = streamUrl.match(/^(rtmps?:\/\/[^/]+\/rtmp\/)(.+)$/);
    const url = rtmpMatch ? rtmpMatch[1] : streamUrl;
    const key = rtmpMatch ? rtmpMatch[2] : '';

    logger.info(`[FB:${this.pageName}] Live created (id: ${this.liveVideoId})`);
    return { url, key };
  }

  async endBroadcast(): Promise<void> {
    if (!this.liveVideoId || !this.accessToken) return;

    logger.info(`[FB:${this.pageName}] Ending live (id: ${this.liveVideoId})`);

    try {
      const params = new URLSearchParams({
        end_live_video: 'true',
        access_token: this.accessToken,
      });

      await fetch(
        `https://graph.facebook.com/v21.0/${this.liveVideoId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: params.toString(),
        },
      );

      logger.info(`[FB:${this.pageName}] Live ended`);
    } catch (err) {
      logger.warn(`[FB:${this.pageName}] Error ending live: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.liveVideoId = null;
  }
}
