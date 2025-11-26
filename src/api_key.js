export class APIKeyManager {
  constructor(secret) {
    this.secret = secret;
  }

  _encode(text) {
    const encoder = new TextEncoder();
    return encoder.encode(text);
  }

  _decode(buffer) {
    const decoder = new TextDecoder();
    return decoder.decode(buffer);
  }

  async _importKey(secret) {
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      this._encode(secret),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: this._encode("salt"),
        iterations: 100000,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    return key;
  }

  async _encrypt(value) {
    const key = await this._importKey(this.secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv
      },
      key,
      this._encode(value)
    );
    return { iv, encrypted };
  }

  async _decrypt(encrypted, iv) {
    const key = await this._importKey(this.secret);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv
      },
      key,
      encrypted
    );
    return this._decode(decrypted);
  }

  async saveAPIKey(provider, apiKeyOrObject) {
    const payload = typeof apiKeyOrObject === "string" ? { apiKey: apiKeyOrObject } : apiKeyOrObject || {};
    const json = JSON.stringify(payload);
    const { iv, encrypted } = await this._encrypt(json);
    const storageValue = {
      iv: Array.from(iv),
      encrypted: Array.from(new Uint8Array(encrypted))
    };
    localStorage.setItem(provider, JSON.stringify(storageValue));
  }

  async getAPIKey(provider) {
    const creds = await this.getCredentials(provider);
    if (!creds) return null;
    return creds.apiKey || null;
  }

  async getCredentials(provider) {
    const storageValue = localStorage.getItem(provider);
    if (!storageValue) {
      return null;
    }
    const { iv, encrypted } = JSON.parse(storageValue);
    const decrypted = await this._decrypt(
      new Uint8Array(encrypted),
      new Uint8Array(iv)
    );
    try {
      return JSON.parse(decrypted);
    } catch (e) {
      return null;
    }
  }

  deleteAPIKey(provider) {
    localStorage.removeItem(provider);
  }

  apiKeyExists(provider) {
    return localStorage.getItem(provider) !== null;
  }
}
