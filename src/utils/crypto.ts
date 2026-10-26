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

/** Return the SHA-1 digest of bytes as hex using Web Crypto. */
export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytesToArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}

function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = Uint32Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32),
);

/** Return the MD5 digest of bytes as hex without Node crypto. */
export function md5Hex(bytes: Uint8Array): string {
  const originalLength = bytes.byteLength;
  const paddedLength = (((originalLength + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[originalLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, (originalLength * 8) >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(originalLength / 0x20000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const word = view.getUint32(offset + g * 4, true);
      f = (f + a + MD5_K[index]! + word) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, MD5_SHIFTS[index]!)) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, a0, true);
  digestView.setUint32(4, b0, true);
  digestView.setUint32(8, c0, true);
  digestView.setUint32(12, d0, true);
  return bytesToHex(digest);
}
