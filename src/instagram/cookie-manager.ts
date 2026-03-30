import { encrypt, decrypt } from '../crypto/aes.js';
import type { Cookie } from 'playwright';

export class CookieManager {
  private encryptionKey: Buffer;

  constructor(encryptionKey: Buffer) {
    this.encryptionKey = encryptionKey;
  }

  encryptCookies(cookies: Cookie[]): string {
    const json = JSON.stringify(cookies);
    return encrypt(json, this.encryptionKey);
  }

  decryptCookies(encrypted: string): Cookie[] {
    const json = decrypt(encrypted, this.encryptionKey);
    return JSON.parse(json) as Cookie[];
  }
}
