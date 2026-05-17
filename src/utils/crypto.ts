/** Derive a deterministic 32-byte seed from bot secret for webhook challenge signing. */
export function createBotSeed(secret: string): Uint8Array {
  const source = stringToBytes(secret);
  if (source.length === 0) {
    throw new Error("QQ adapter secret cannot be empty.");
  }
  const seed = new Uint8Array(32);
  for (let i = 0; i < seed.length; i += 1) {
    seed[i] = source[i % source.length]!;
  }
  return seed;
}

/** Convert a UTF-8 string to Uint8Array. */
export function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Convert a hex string to Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex string: ${hex}`);
    }
    bytes[i] = byte;
  }
  return bytes;
}

/** Convert a Uint8Array to a hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Convert base64 text to bytes without depending on Node Buffer. */
export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Copy bytes into a plain ArrayBuffer for Web APIs that reject SharedArrayBuffer. */
export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** Convert bytes to base64 without depending on Node Buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Return the SHA-256 digest of bytes as hex using Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}

/** Concatenate two Uint8Arrays. */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
