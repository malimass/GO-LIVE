import { getFacebookDestinations, getInstagramAccounts, getDb } from '../db/index.js';

export interface FacebookDestination {
  name: string;
  pageId: string;
  pageAccessToken: string;
  liveTitle: string;
}

export interface InstagramAccount {
  name: string;
  username: string;
  cookiesEnc: string;
  liveTitle: string;
  audience: string;
}

export interface Config {
  rtmpIngestKey: string;
  rtmpPort: number;
  encryptionKey: Buffer;
  dashboardPassword: string;
  port: number;
  nodeEnv: string;
  facebook: FacebookDestination[];
  instagram: InstagramAccount[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function loadConfig(): Config {
  const encKeyHex = requireEnv('ENCRYPTION_KEY');
  if (encKeyHex.length !== 64) {
    console.error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    process.exit(1);
  }

  // Initialize DB
  getDb();

  return {
    rtmpIngestKey: requireEnv('RTMP_INGEST_KEY'),
    rtmpPort: parseInt(optionalEnv('RTMP_PORT', '1935'), 10),
    encryptionKey: Buffer.from(encKeyHex, 'hex'),
    dashboardPassword: requireEnv('DASHBOARD_PASSWORD'),
    port: parseInt(optionalEnv('PORT', '3000'), 10),
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    facebook: loadFacebookFromDb(),
    instagram: loadInstagramFromDb(),
  };
}

export function loadFacebookFromDb(): FacebookDestination[] {
  return getFacebookDestinations()
    .filter((row) => row.enabled && row.page_id && row.page_access_token)
    .map((row) => ({
      name: row.name,
      pageId: row.page_id,
      pageAccessToken: row.page_access_token,
      liveTitle: row.live_title || 'LIVE',
    }));
}

export function loadInstagramFromDb(): InstagramAccount[] {
  return getInstagramAccounts()
    .filter((row) => row.enabled && row.cookies_enc)
    .map((row) => ({
      name: row.name,
      username: row.username,
      cookiesEnc: row.cookies_enc!,
      liveTitle: (row as any).live_title || 'LIVE',
      audience: (row as any).audience || 'public',
    }));
}

export function reloadDestinations(config: Config): void {
  config.facebook = loadFacebookFromDb();
  config.instagram = loadInstagramFromDb();
}
