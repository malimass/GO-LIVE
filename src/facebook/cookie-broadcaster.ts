import { logger } from '../logging/logger.js';
import type { Cookie } from 'playwright';

export interface FbStreamKeyResult {
  url: string;
  key: string;
}

interface FbGraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
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

export class FacebookCookieBroadcaster {
  private pageId: string;
  private pageName: string;
  private cookies: Cookie[];
  private title: string;
  private description: string;
  private liveVideoId: string | null = null;
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
   * Fetch fb_dtsg CSRF token from Facebook
   */
  private async fetchDtsg(): Promise<string> {
    if (this.fbDtsg) return this.fbDtsg;

    const response = await fetch('https://www.facebook.com/', {
      headers: {
        'Cookie': this.cookieStr,
        'User-Agent': USER_AGENT,
      },
    });

    const html = await response.text();

    // Log response status and size for debugging
    logger.info(`[FB:${this.pageName}] fb_dtsg fetch: status=${response.status}, html length=${html.length}`);

    // Try multiple known patterns for fb_dtsg extraction
    const patterns: [RegExp, string][] = [
      [/"DTSGInitialData".*?"token":"([^"]+)"/, 'DTSGInitialData'],
      [/\["DTSGInitialData",\[\],\{"token":"([^"]+)"/, 'DTSGInitialData array'],
      [/"DTSGInitData".*?"token":"([^"]+)"/, 'DTSGInitData'],
      [/{"name":"fb_dtsg","value":"([^"]+)"}/, 'JSON name-value'],
      [/name="fb_dtsg" value="([^"]+)"/, 'form input'],
      [/"dtsg":\{"token":"([^"]+)"/, 'dtsg.token'],
      [/fb_dtsg["'\s:=]+["']([^"']+)["']/, 'generic fb_dtsg'],
    ];

    for (const [pattern, label] of patterns) {
      const match = html.match(pattern);
      if (match) {
        this.fbDtsg = match[1];
        logger.info(`[FB:${this.pageName}] fb_dtsg extracted via "${label}" pattern`);
        return this.fbDtsg;
      }
    }

    // Log a snippet around "dtsg" if present to help debug
    const dtsgIdx = html.indexOf('dtsg');
    if (dtsgIdx >= 0) {
      const snippet = html.substring(Math.max(0, dtsgIdx - 30), dtsgIdx + 120);
      logger.warn(`[FB:${this.pageName}] Found "dtsg" in HTML but no pattern matched. Snippet: ${snippet}`);
    } else {
      logger.warn(`[FB:${this.pageName}] No "dtsg" found in HTML at all. Cookies may be expired or invalid.`);
    }

    throw new Error(`Could not extract fb_dtsg for ${this.pageName}`);
  }

  /**
   * Create a live broadcast and get the stream key via Graph API with cookie auth
   */
  async createBroadcast(): Promise<FbStreamKeyResult> {
    logger.info(`[FB:${this.pageName}] Creating live via cookie auth`);

    const dtsg = await this.fetchDtsg();

    // Use Facebook's Graph API with cookie authentication (acting as page admin)
    const params = new URLSearchParams({
      title: this.title,
      description: this.description,
      status: 'LIVE_NOW',
      fb_dtsg: dtsg,
    });

    const response = await fetch(
      `https://graph.facebook.com/v25.0/${this.pageId}/live_videos`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': this.cookieStr,
          'User-Agent': USER_AGENT,
          'Origin': 'https://www.facebook.com',
          'Referer': 'https://www.facebook.com/',
        },
        body: params.toString(),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      logger.error(`[FB:${this.pageName}] API error ${response.status}: ${text.substring(0, 500)}`);
      throw new Error(`Facebook API error ${response.status} for ${this.pageName}`);
    }

    const data = await response.json() as Record<string, unknown>;

    const streamUrl = (data.secure_stream_url || data.stream_url) as string;
    if (!streamUrl) {
      // If Graph API with cookies doesn't return stream URL, try internal API
      return this.createBroadcastInternal(dtsg);
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

    logger.info(`[FB:${this.pageName}] Live created via cookie auth (id: ${this.liveVideoId})`);
    return { url, key };
  }

  /**
   * Fallback: use Facebook's internal GraphQL API to create the broadcast
   */
  private async createBroadcastInternal(dtsg: string): Promise<FbStreamKeyResult> {
    logger.info(`[FB:${this.pageName}] Trying internal GraphQL API`);

    const variables = JSON.stringify({
      input: {
        composer_entry_point: 'inline_composer',
        composer_source_surface: 'timeline',
        idempotence_token: `live_${Date.now()}_${Math.random().toString(36).substring(2)}`,
        source: 'owner',
        actor_id: this.pageId,
        client_mutation_id: '1',
      },
    });

    const params = new URLSearchParams({
      fb_dtsg: dtsg,
      variables,
      doc_id: '6830942790271498', // LiveVideoCreateMutation
    });

    const response = await fetch('https://www.facebook.com/api/graphql/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': this.cookieStr,
        'User-Agent': USER_AGENT,
        'X-FB-Friendly-Name': 'LiveVideoCreateMutation',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Facebook GraphQL error ${response.status}: ${text.substring(0, 500)}`);
    }

    const data = await response.json() as FbGraphQLResponse;

    if (data.errors?.length) {
      throw new Error(`GraphQL error: ${data.errors[0].message}`);
    }

    // Extract stream URL from GraphQL response
    const liveVideo = (data.data as Record<string, Record<string, Record<string, string>>>)?.live_video_create?.live_video;
    if (!liveVideo) {
      throw new Error(`Unexpected GraphQL response for ${this.pageName}`);
    }

    const streamUrl = (liveVideo.secure_stream_url || liveVideo.stream_url || liveVideo.dash_ingest_url) as string;
    this.liveVideoId = liveVideo.id as string;

    if (!streamUrl) {
      throw new Error(`No stream URL in GraphQL response for ${this.pageName}`);
    }

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

    logger.info(`[FB:${this.pageName}] Live created via GraphQL (id: ${this.liveVideoId})`);
    return { url, key };
  }

  async endBroadcast(): Promise<void> {
    if (!this.liveVideoId) return;

    logger.info(`[FB:${this.pageName}] Ending live (id: ${this.liveVideoId})`);

    try {
      const dtsg = await this.fetchDtsg();

      const params = new URLSearchParams({
        end_live_video: 'true',
        fb_dtsg: dtsg,
      });

      await fetch(
        `https://graph.facebook.com/v25.0/${this.liveVideoId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': this.cookieStr,
            'User-Agent': USER_AGENT,
            'Origin': 'https://www.facebook.com',
            'Referer': 'https://www.facebook.com/',
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
