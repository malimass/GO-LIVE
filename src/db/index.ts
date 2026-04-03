import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from '../logging/logger.js';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'go-live.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    logger.info(`Database initialized at ${DB_PATH}`);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  // Migrations for existing DBs
  try { db.exec(`ALTER TABLE instagram_accounts ADD COLUMN live_title TEXT NOT NULL DEFAULT 'LIVE'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE instagram_accounts ADD COLUMN audience TEXT NOT NULL DEFAULT 'public'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE facebook_destinations ADD COLUMN page_id TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE facebook_destinations ADD COLUMN page_access_token TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE facebook_destinations ADD COLUMN live_title TEXT NOT NULL DEFAULT 'LIVE'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE facebook_destinations ADD COLUMN mode TEXT NOT NULL DEFAULT 'api'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE facebook_destinations ADD COLUMN cookies_enc TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE facebook_destinations ADD COLUMN live_description TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facebook_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      rtmp_url TEXT NOT NULL DEFAULT 'rtmps://live-api-s.facebook.com:443/rtmp/',
      stream_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS instagram_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      cookies_enc TEXT,
      live_title TEXT NOT NULL DEFAULT 'LIVE',
      audience TEXT NOT NULL DEFAULT 'public',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_cookie_update TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// Settings helpers
export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
}

// Facebook helpers
export interface FacebookRow {
  id: number;
  name: string;
  rtmp_url: string;
  stream_key: string;
  page_id: string;
  page_access_token: string;
  live_title: string;
  mode: 'api' | 'stream_key' | 'cookie';
  cookies_enc: string | null;
  enabled: number;
}

export function getFacebookDestinations(): FacebookRow[] {
  return getDb().prepare('SELECT * FROM facebook_destinations ORDER BY id').all() as FacebookRow[];
}

export interface UpsertFacebookParams {
  id?: number | null;
  name: string;
  mode: 'api' | 'stream_key' | 'cookie';
  pageId?: string;
  pageAccessToken?: string;
  rtmpUrl?: string;
  streamKey?: string;
  liveTitle?: string;
  liveDescription?: string;
}

export function upsertFacebook(params: UpsertFacebookParams): void {
  const { id, name, mode, liveTitle } = params;
  const title = liveTitle || 'LIVE';
  const pageId = params.pageId || '';
  const pageAccessToken = params.pageAccessToken || '';
  const rtmpUrl = params.rtmpUrl || 'rtmps://live-api-s.facebook.com:443/rtmp/';
  const streamKey = params.streamKey || '';

  if (id) {
    getDb().prepare("UPDATE facebook_destinations SET name = ?, mode = ?, page_id = ?, page_access_token = ?, rtmp_url = ?, stream_key = ?, live_title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, mode, pageId, pageAccessToken, rtmpUrl, streamKey, title, id);
  } else {
    getDb().prepare('INSERT INTO facebook_destinations (name, mode, page_id, page_access_token, rtmp_url, stream_key, live_title) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, mode, pageId, pageAccessToken, rtmpUrl, streamKey, title);
  }
}

export function updateFacebookCookies(id: number, cookiesEnc: string): void {
  getDb().prepare("UPDATE facebook_destinations SET cookies_enc = ?, updated_at = datetime('now') WHERE id = ?").run(cookiesEnc, id);
}

export function deleteFacebook(id: number): void {
  getDb().prepare('DELETE FROM facebook_destinations WHERE id = ?').run(id);
}

// Instagram helpers
export interface InstagramRow {
  id: number;
  name: string;
  username: string;
  cookies_enc: string | null;
  enabled: number;
  last_cookie_update: string | null;
}

export function getInstagramAccounts(): InstagramRow[] {
  return getDb().prepare('SELECT * FROM instagram_accounts ORDER BY id').all() as InstagramRow[];
}

export function upsertInstagram(id: number | null, name: string, username: string, liveTitle?: string, audience?: string): void {
  const title = liveTitle || 'LIVE';
  const aud = audience || 'public';
  if (id) {
    getDb().prepare("UPDATE instagram_accounts SET name = ?, username = ?, live_title = ?, audience = ?, updated_at = datetime('now') WHERE id = ?").run(name, username, title, aud, id);
  } else {
    getDb().prepare('INSERT INTO instagram_accounts (name, username, live_title, audience) VALUES (?, ?, ?, ?)').run(name, username, title, aud);
  }
}

export function updateInstagramCookies(id: number, cookiesEnc: string): void {
  getDb().prepare("UPDATE instagram_accounts SET cookies_enc = ?, last_cookie_update = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(cookiesEnc, id);
}

export function deleteInstagram(id: number): void {
  getDb().prepare('DELETE FROM instagram_accounts WHERE id = ?').run(id);
}
