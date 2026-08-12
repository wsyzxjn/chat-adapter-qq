import { ChatError } from "chat";
import {
  DEFAULT_CHUNK_BLOCK_SIZE_BYTES,
  MD5_10M_BYTES,
} from "../constants.js";
import type {
  QQMediaUploadResponse,
  QQThreadId,
  QQUploadPartFinishRequest,
  QQUploadPrepareRequest,
  QQUploadPrepareResponse,
} from "../types.js";
import { md5Hex, sha1Hex } from "./crypto.js";
import { getUploadMediaPath, getUploadPartFinishPath, getUploadPreparePath } from "./message-payload.js";

export interface ChunkedUploadApi {
  request<T>(
    path: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
  ): Promise<T>;
  put(url: string, body: Uint8Array): Promise<void>;
}

function toPositiveInt(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function parsePrepareResponse(body: QQUploadPrepareResponse): {
  blockSize: number;
  concurrency: number;
  parts: Array<{ blockSize: number; index: number; presignedUrl: string }>;
  uploadId: string;
} {
  const source = body.data ?? body;
  const uploadId = source.upload_id?.trim();
  if (!uploadId) {
    throw new ChatError("QQ upload_prepare response is missing upload_id.", "INVALID_REQUEST");
  }

  const parts = (source.parts ?? source.part_list ?? [])
    .map((part) => ({
      blockSize: toPositiveInt(part.block_size),
      index: toPositiveInt(part.index ?? part.part_index, 0),
      presignedUrl: (part.presigned_url ?? part.url ?? "").trim(),
    }))
    .filter((part) => part.presignedUrl);
  if (parts.length === 0) {
    throw new ChatError("QQ upload_prepare response is missing presigned part URLs.", "INVALID_REQUEST");
  }

  parts.sort((left, right) => left.index - right.index);
  return {
    blockSize: toPositiveInt(source.block_size, DEFAULT_CHUNK_BLOCK_SIZE_BYTES),
    concurrency: Math.max(1, toPositiveInt(source.upload_config?.concurrency, 1)),
    parts,
    uploadId,
  };
}

function sliceParts(
  data: Uint8Array,
  blockSize: number,
  parts: Array<{ blockSize: number; index: number; presignedUrl: string }>,
): Array<{ chunk: Uint8Array; index: number; presignedUrl: string }> {
  const slices: Array<{ chunk: Uint8Array; index: number; presignedUrl: string }> = [];
  let offset = 0;
  for (const part of parts) {
    const size = part.blockSize || Math.min(blockSize, data.byteLength - offset);
    if (size <= 0 || offset >= data.byteLength) {
      throw new ChatError("QQ chunked upload part list does not match file size.", "INVALID_REQUEST");
    }
    slices.push({
      chunk: data.subarray(offset, offset + size),
      index: part.index,
      presignedUrl: part.presignedUrl,
    });
    offset += size;
  }
  if (offset !== data.byteLength) {
    throw new ChatError("QQ chunked upload parts did not consume the full file.", "INVALID_REQUEST");
  }
  return slices;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(runners);
}

/**
 * Upload local/binary media through QQ's chunked flow:
 * `upload_prepare` → part PUT → `upload_part_finish` → `POST .../files` with `upload_id`.
 */
export async function uploadLocalFileChunked(
  thread: QQThreadId,
  data: Uint8Array,
  options: {
    api: ChunkedUploadApi;
    fileName: string;
    fileType: number;
  },
): Promise<QQMediaUploadResponse> {
  const prepareRequest: QQUploadPrepareRequest = {
    file_name: options.fileName,
    file_size: String(data.byteLength),
    file_type: options.fileType,
    md5: md5Hex(data),
    md5_10m: md5Hex(data.subarray(0, Math.min(data.byteLength, MD5_10M_BYTES))),
    sha1: await sha1Hex(data),
  };
  const prepared = parsePrepareResponse(
    await options.api.request<QQUploadPrepareResponse>(getUploadPreparePath(thread), {
      body: JSON.stringify(prepareRequest),
      method: "POST",
    }),
  );
  const slices = sliceParts(data, prepared.blockSize, prepared.parts);

  await runWithConcurrency(slices, prepared.concurrency, async (part) => {
    await options.api.put(part.presignedUrl, part.chunk);
    const finishRequest: QQUploadPartFinishRequest = {
      block_size: String(part.chunk.byteLength),
      md5: md5Hex(part.chunk),
      part_index: part.index,
      upload_id: prepared.uploadId,
    };
    await options.api.request(getUploadPartFinishPath(thread), {
      body: JSON.stringify(finishRequest),
      method: "POST",
    });
  });

  return options.api.request<QQMediaUploadResponse>(getUploadMediaPath(thread), {
    body: JSON.stringify({
      file_name: options.fileName,
      file_type: options.fileType,
      srv_send_msg: false,
      upload_id: prepared.uploadId,
    }),
    method: "POST",
  });
}
