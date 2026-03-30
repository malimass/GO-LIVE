export interface FacebookDestination {
  name: string;
  rtmpUrl: string;
  streamKey: string;
}

export interface InstagramAccount {
  name: string;
  username: string;
  cookiesEnc: string;
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

  const facebook: FacebookDestination[] = [];
  for (let i = 1; i <= 3; i++) {
    const rtmpUrl = process.env[`FB_PAGE_${i}_RTMP_URL`];
    const streamKey = process.env[`FB_PAGE_${i}_STREAM_KEY`];
    if (rtmpUrl && streamKey) {
      facebook.push({ name: `Facebook ${i}`, rtmpUrl, streamKey });
    }
  }

  const instagram: InstagramAccount[] = [];
  for (let i = 1; i <= 3; i++) {
    const cookiesEnc = process.env[`IG_ACCOUNT_${i}_COOKIES_ENC`];
    const username = process.env[`IG_ACCOUNT_${i}_USERNAME`] || `ig_account_${i}`;
    if (cookiesEnc) {
      instagram.push({ name: `Instagram ${i}`, username, cookiesEnc });
    }
  }

  return {
    rtmpIngestKey: requireEnv('RTMP_INGEST_KEY'),
    rtmpPort: parseInt(optionalEnv('RTMP_PORT', '1935'), 10),
    encryptionKey: Buffer.from(encKeyHex, 'hex'),
    dashboardPassword: requireEnv('DASHBOARD_PASSWORD'),
    port: parseInt(optionalEnv('PORT', '3000'), 10),
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    facebook,
    instagram,
  };
}
