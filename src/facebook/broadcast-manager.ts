import { logger } from '../logging/logger.js';

export interface FbStreamKeyResult {
  url: string;
  key: string;
}

interface FbCreateLiveResponse {
  id: string;
  stream_url: string;
  secure_stream_url: string;
}

const FB_GRAPH_URL = 'https://graph.facebook.com/v25.0';

export class FacebookBroadcastManager {
  private pageId: string;
  private pageName: string;
  private accessToken: string;
  private title: string;
  private liveVideoId: string | null = null;

  constructor(pageId: string, pageName: string, accessToken: string, title?: string) {
    this.pageId = pageId;
    this.pageName = pageName;
    this.accessToken = accessToken;
    this.title = title || 'LIVE';
  }

  async createBroadcast(): Promise<FbStreamKeyResult> {
    logger.info(`[FB:${this.pageName}] Creating live video via Graph API`);

    const params = new URLSearchParams({
      title: this.title,
      status: 'LIVE_NOW',
      access_token: this.accessToken,
    });

    const response = await fetch(`${FB_GRAPH_URL}/${this.pageId}/live_videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(`[FB:${this.pageName}] API error ${response.status}: ${text.substring(0, 500)}`);
      throw new Error(`Facebook API error ${response.status} for ${this.pageName}`);
    }

    const data = await response.json() as FbCreateLiveResponse;

    if (!data.secure_stream_url && !data.stream_url) {
      logger.error(`[FB:${this.pageName}] No stream URL in response: ${JSON.stringify(data).substring(0, 500)}`);
      throw new Error(`No stream URL returned for ${this.pageName}`);
    }

    this.liveVideoId = data.id;
    const streamUrl = data.secure_stream_url || data.stream_url;

    // Parse: rtmps://host:443/rtmp/KEY?params
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

    logger.info(`[FB:${this.pageName}] Live video created (id: ${this.liveVideoId})`);

    return { url, key };
  }

  /**
   * Find a live video in PREVIEW status (created by permanent stream key)
   * and transition it to LIVE_NOW.
   */
  async goLiveOnStreamKey(): Promise<void> {
    logger.info(`[FB:${this.pageName}] Looking for preview live to auto-start...`);

    // Fetch live videos in PREVIEW or SCHEDULED_UNPUBLISHED status
    const params = new URLSearchParams({
      source: 'owner',
      broadcast_status: JSON.stringify(['PREVIEW', 'SCHEDULED_UNPUBLISHED']),
      fields: 'id,title,status',
      access_token: this.accessToken,
    });

    const response = await fetch(`${FB_GRAPH_URL}/${this.pageId}/live_videos?${params}`);

    if (!response.ok) {
      const text = await response.text();
      logger.error(`[FB:${this.pageName}] Failed to fetch live videos: ${text.substring(0, 500)}`);
      throw new Error(`Failed to fetch live videos for ${this.pageName}`);
    }

    const data = await response.json() as { data: Array<{ id: string; title: string; status: string }> };

    if (!data.data || data.data.length === 0) {
      logger.warn(`[FB:${this.pageName}] No preview live found — the stream key may not be active yet`);
      return;
    }

    // Pick the most recent one (first in the list)
    const liveVideo = data.data[0];
    this.liveVideoId = liveVideo.id;

    logger.info(`[FB:${this.pageName}] Found preview live (id: ${liveVideo.id}, status: ${liveVideo.status}), transitioning to LIVE_NOW...`);

    // Transition to LIVE_NOW
    const goLiveParams = new URLSearchParams({
      status: 'LIVE_NOW',
      access_token: this.accessToken,
    });

    const goLiveResp = await fetch(`${FB_GRAPH_URL}/${liveVideo.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: goLiveParams.toString(),
    });

    if (!goLiveResp.ok) {
      const text = await goLiveResp.text();
      logger.error(`[FB:${this.pageName}] Failed to go live: ${text.substring(0, 500)}`);
      throw new Error(`Failed to transition to LIVE_NOW for ${this.pageName}`);
    }

    logger.info(`[FB:${this.pageName}] Auto-started! Live is now public (id: ${liveVideo.id})`);
  }

  async endBroadcast(): Promise<void> {
    if (!this.liveVideoId) return;

    logger.info(`[FB:${this.pageName}] Ending live video (id: ${this.liveVideoId})`);

    try {
      const params = new URLSearchParams({
        end_live_video: 'true',
        access_token: this.accessToken,
      });

      await fetch(`${FB_GRAPH_URL}/${this.liveVideoId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      logger.info(`[FB:${this.pageName}] Live ended`);
    } catch (err) {
      logger.warn(`[FB:${this.pageName}] Error ending live: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.liveVideoId = null;
  }
}
