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

const BROWSER_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
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
   * Extract user access token from Facebook HTML page.
   * Facebook embeds the token in the page when authenticated via cookies.
   */
  private async extractAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    const response = await fetch('https://www.facebook.com/dialog/oauth?client_id=124024574287414&redirect_uri=https://www.facebook.com/connect/login_success.html&scope=pages_manage_posts,pages_read_engagement&response_type=token', {
      headers: {
        ...BROWSER_HEADERS,
        'Cookie': this.cookieStr,
      },
      redirect: 'manual',
    });

    // If we got a redirect, the token might be in the Location header
    const location = response.headers.get('location') || '';
    logger.info(`[FB:${this.pageName}] OAuth redirect status=${response.status}, location=${location.substring(0, 200)}`);

    const tokenFromLocation = location.match(/access_token=([^&]+)/);
    if (tokenFromLocation) {
      this.accessToken = decodeURIComponent(tokenFromLocation[1]);
      logger.info(`[FB:${this.pageName}] Access token extracted from OAuth redirect`);
      return this.accessToken;
    }

    // If not in redirect, check the response body
    const html = await response.text();

    // Follow the redirect manually if needed
    if (location && !tokenFromLocation) {
      const followResponse = await fetch(location, {
        headers: {
          ...BROWSER_HEADERS,
          'Cookie': this.cookieStr,
        },
        redirect: 'manual',
      });
      const followLocation = followResponse.headers.get('location') || '';
      const followHtml = await followResponse.text();

      const tokenFromFollow = followLocation.match(/access_token=([^&]+)/) ||
                              followHtml.match(/access_token=([^&"]+)/);
      if (tokenFromFollow) {
        this.accessToken = decodeURIComponent(tokenFromFollow[1]);
        logger.info(`[FB:${this.pageName}] Access token extracted from follow redirect`);
        return this.accessToken;
      }
    }

    // Try to extract from the initial HTML body
    const tokenPatterns: [RegExp, string][] = [
      [/access_token=([^&"\\]+)/, 'URL param'],
      [/"accessToken":"([^"]+)"/, 'accessToken JSON'],
      [/"access_token":"([^"]+)"/, 'access_token JSON'],
      [/EAAG\w{20,}/, 'EAAG token'],
    ];

    for (const [pattern, label] of tokenPatterns) {
      const match = html.match(pattern);
      if (match) {
        this.accessToken = match[1] || match[0];
        logger.info(`[FB:${this.pageName}] Access token extracted via "${label}" (length: ${this.accessToken.length})`);
        return this.accessToken;
      }
    }

    logger.warn(`[FB:${this.pageName}] Could not extract access token via OAuth. Trying page HTML fallback...`);

    // Fallback: extract from the main Facebook page
    return this.extractTokenFromPage();
  }

  /**
   * Fallback: extract access token from a Facebook page load
   */
  private async extractTokenFromPage(): Promise<string> {
    const response = await fetch(`https://www.facebook.com/${this.pageId}/`, {
      headers: {
        ...BROWSER_HEADERS,
        'Cookie': this.cookieStr,
      },
      redirect: 'follow',
    });

    const html = await response.text();
    logger.info(`[FB:${this.pageName}] Page fetch: status=${response.status}, length=${html.length}`);

    // Look for access token in the page HTML
    const patterns: [RegExp, string][] = [
      [/"accessToken":"(EAAG[^"]+)"/, 'page accessToken'],
      [/"access_token":"(EAAG[^"]+)"/, 'page access_token'],
      [/EAAG[\w]{30,}/, 'page EAAG literal'],
    ];

    for (const [pattern, label] of patterns) {
      const match = html.match(pattern);
      if (match) {
        this.accessToken = match[1] || match[0];
        logger.info(`[FB:${this.pageName}] Token from page via "${label}" (length: ${this.accessToken.length})`);
        return this.accessToken;
      }
    }

    // Log what we found for debugging
    const eaIdx = html.indexOf('EAA');
    if (eaIdx >= 0) {
      const snippet = html.substring(Math.max(0, eaIdx - 20), eaIdx + 80);
      logger.warn(`[FB:${this.pageName}] Found "EAA" in page but no pattern matched. Snippet: ${snippet}`);
    } else {
      logger.warn(`[FB:${this.pageName}] No access token found in page HTML.`);
    }

    throw new Error(`Could not extract access token for ${this.pageName}`);
  }

  /**
   * Create a live broadcast using Graph API with extracted access token
   */
  async createBroadcast(): Promise<FbStreamKeyResult> {
    logger.info(`[FB:${this.pageName}] Creating live via cookie auth`);

    const token = await this.extractAccessToken();

    // First get page access token (user token -> page token)
    let pageToken = token;
    try {
      const pageTokenResponse = await fetch(
        `https://graph.facebook.com/v21.0/${this.pageId}?fields=access_token&access_token=${encodeURIComponent(token)}`,
        { headers: { 'User-Agent': USER_AGENT } },
      );
      if (pageTokenResponse.ok) {
        const pageData = await pageTokenResponse.json() as Record<string, string>;
        if (pageData.access_token) {
          pageToken = pageData.access_token;
          logger.info(`[FB:${this.pageName}] Got page access token`);
        }
      }
    } catch (err) {
      logger.warn(`[FB:${this.pageName}] Could not get page token, using user token: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Create live video
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
      throw new Error(`No stream URL in Graph API response for ${this.pageName}`);
    }

    this.liveVideoId = data.id as string;

    // Parse RTMP URL
    const rtmpMatch = streamUrl.match(/^(rtmps?:\/\/[^/]+\/rtmp\/)(.+)$/);
    let url: string;
    let key: string;

    if (rtmpMatch) {
      url = rtmpMatch[1];
      key = rtmpMatch[2];
    } else {
      url = streamUrl;
      key = '';
    }

    logger.info(`[FB:${this.pageName}] Live created (id: ${this.liveVideoId})`);
    return { url, key };
  }

  async endBroadcast(): Promise<void> {
    if (!this.liveVideoId) return;

    logger.info(`[FB:${this.pageName}] Ending live (id: ${this.liveVideoId})`);

    try {
      const token = this.accessToken;
      if (!token) {
        logger.warn(`[FB:${this.pageName}] No access token to end broadcast`);
        return;
      }

      const params = new URLSearchParams({
        end_live_video: 'true',
        access_token: token,
      });

      await fetch(
        `https://graph.facebook.com/v21.0/${this.liveVideoId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
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
