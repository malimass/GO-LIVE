import { logger } from '../logging/logger.js';
import type { Cookie } from 'playwright';

export interface StreamKeyResult {
  url: string;
  key: string;
}

interface IgCreateLiveResponse {
  broadcast_id: string;
  upload_url: string;
  status: string;
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
  private title: string;
  private audience: string;
  private broadcastId: string | null = null;
  private csrfToken: string = '';
  private sessionId: string = '';
  private userId: string = '';

  constructor(username: string, cookies: Cookie[] | Record<string, unknown>[], title?: string, audience?: string) {
    this.username = username;
    this.cookies = normalizeCookies(cookies as Record<string, unknown>[]);
    this.title = title || 'LIVE';
    this.audience = audience || 'public';

    // Extract needed values from cookies
    for (const c of this.cookies) {
      if (c.name === 'csrftoken') this.csrfToken = c.value;
      if (c.name === 'sessionid') this.sessionId = c.value;
      if (c.name === 'ds_user_id') this.userId = c.value;
    }
  }

  async extractStreamKey(): Promise<StreamKeyResult> {
    logger.info(`[IG:${this.username}] Extracting stream key via API`);

    if (!this.csrfToken || !this.sessionId) {
      throw new Error(`Missing csrftoken or sessionid cookie for ${this.username}`);
    }

    // Build cookie string
    const cookieStr = this.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    // Call Instagram's create live API
    const response = await fetch('https://www.instagram.com/api/v1/live/create/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieStr,
        'X-CSRFToken': this.csrfToken,
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://www.instagram.com/live/producer/',
        'Origin': 'https://www.instagram.com',
      },
      body: `preview_height=1080&preview_width=1920&source=2&broadcast_type=RTMP_SWAP_ENABLED&internal_only=0&audience=${encodeURIComponent(this.audience)}&title=${encodeURIComponent(this.title)}`,
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(`[IG:${this.username}] API error ${response.status}: ${text.substring(0, 500)}`);

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Cookies expired for ${this.username}`);
      }
      throw new Error(`Instagram API error ${response.status} for ${this.username}`);
    }

    const data = await response.json() as IgCreateLiveResponse;

    if (data.status !== 'ok' || !data.upload_url) {
      logger.error(`[IG:${this.username}] Unexpected API response: ${JSON.stringify(data).substring(0, 500)}`);
      throw new Error(`Failed to create live for ${this.username}`);
    }

    this.broadcastId = data.broadcast_id;

    // Parse upload_url: rtmps://host:443/rtmp/BROADCAST_ID?params
    const uploadUrl = data.upload_url;
    const rtmpUrlMatch = uploadUrl.match(/^(rtmps?:\/\/[^/]+\/rtmp\/)(.+)$/);

    let streamUrl: string;
    let streamKey: string;

    if (rtmpUrlMatch) {
      streamUrl = rtmpUrlMatch[1];
      streamKey = rtmpUrlMatch[2];
    } else {
      // Fallback: use the full URL as-is
      streamUrl = uploadUrl;
      streamKey = '';
    }

    logger.info(`[IG:${this.username}] Stream key extracted via API (broadcast: ${this.broadcastId})`);

    return { url: streamUrl, key: streamKey };
  }

  async startBroadcast(): Promise<void> {
    if (!this.broadcastId) return;

    logger.info(`[IG:${this.username}] Starting broadcast (Go Live)...`);

    const cookieStr = this.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const response = await fetch(`https://www.instagram.com/api/v1/live/${this.broadcastId}/start/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieStr,
        'X-CSRFToken': this.csrfToken,
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://www.instagram.com/live/producer/',
        'Origin': 'https://www.instagram.com',
      },
      body: '',
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(`[IG:${this.username}] Start broadcast error ${response.status}: ${text.substring(0, 500)}`);
      return;
    }

    const data = await response.json() as Record<string, unknown>;
    logger.info(`[IG:${this.username}] Broadcast started! Status: ${data.status}`);
  }

  async endLive(): Promise<void> {
    if (!this.broadcastId) return;

    logger.info(`[IG:${this.username}] Ending live (broadcast: ${this.broadcastId})`);

    try {
      const cookieStr = this.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

      await fetch(`https://www.instagram.com/api/v1/live/${this.broadcastId}/end_broadcast/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookieStr,
          'X-CSRFToken': this.csrfToken,
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': 'https://www.instagram.com/live/producer/',
          'Origin': 'https://www.instagram.com',
        },
        body: 'end_after_copyright_warning=false',
      });

      logger.info(`[IG:${this.username}] Live ended`);
    } catch (err) {
      logger.warn(`[IG:${this.username}] Error ending live: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.broadcastId = null;
  }
}
