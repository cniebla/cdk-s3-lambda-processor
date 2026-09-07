import { createHash } from "node:crypto";
import type { Context, S3Event, S3EventRecord } from "aws-lambda";
import { MAX_OBJECT_BYTES } from "./constants";
import {
  decodeS3Key,
  isIncomingObjectKey,
  isProcessedObjectKey,
  normalizeEtag,
  toProcessedKey,
} from "./keys";
import { extractImageMetadata } from "./metadata";
import { createS3ObjectStore } from "./s3-store";
import type { HandlerContext, ObjectStore, ProcessedSidecar, ProcessOutcome } from "./types";

const defaultStore = createS3ObjectStore();

function log(fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveSize(
  record: S3EventRecord,
  bucket: string,
  key: string,
  store: ObjectStore,
): Promise<{ size?: number; contentType?: string; etag?: string; notes: string[] }> {
  const notes: string[] = [];
  const eventSize = record.s3.object.size;
  if (typeof eventSize === "number" && Number.isFinite(eventSize) && eventSize >= 0) {
    return { size: eventSize, etag: record.s3.object.eTag, notes };
  }

  try {
    const head = await store.headObject(bucket, key);
    if (typeof head.contentLength === "number") {
      return {
        size: head.contentLength,
        contentType: head.contentType,
        etag: head.etag ?? record.s3.object.eTag,
        notes,
      };
    }
    notes.push("Object size was missing from the event and HeadObject.");
    return { contentType: head.contentType, etag: head.etag, notes };
  } catch (error) {
    notes.push(`Could not determine object size: ${errorMessage(error)}`);
    return { etag: record.s3.object.eTag, notes };
  }
}

export async function processRecord(
  record: S3EventRecord,
  context: HandlerContext,
  store: ObjectStore,
): Promise<void> {
  const requestId = context.awsRequestId;
  const bucket = record.s3?.bucket?.name;
  const rawKey = record.s3?.object?.key;

  if (!bucket || !rawKey) {
    log({
      level: "WARN",
      requestId,
      outcome: "skipped",
      reason: "missing_bucket_or_key",
    });
    return;
  }

  const key = decodeS3Key(rawKey);

  if (isProcessedObjectKey(key)) {
    log({
      level: "INFO",
      requestId,
      key,
      outcome: "skipped",
      reason: "processed_prefix",
    });
    return;
  }

  if (!isIncomingObjectKey(key)) {
    log({
      level: "INFO",
      requestId,
      key,
      outcome: "skipped",
      reason: "not_incoming_prefix",
    });
    return;
  }

  const processedKey = toProcessedKey(key);
  const processedAt = new Date().toISOString();

  const base = {
    bucket,
    key,
    processedKey,
    processedAt,
    etag: normalizeEtag(record.s3.object.eTag),
    size: record.s3.object.size,
  };

  const writeSidecar = async (
    outcome: ProcessOutcome,
    extra: Partial<ProcessedSidecar>,
  ): Promise<void> => {
    const sidecar: ProcessedSidecar = {
      ...base,
      ...extra,
      outcome,
      notes: extra.notes ?? [],
    };
    await store.putJson(bucket, processedKey, sidecar);
  };

  try {
    const resolved = await resolveSize(record, bucket, key, store);

    if (resolved.size === undefined) {
      await writeSidecar("error", {
        notes: [
          ...resolved.notes,
          "Refusing to download an object of unknown size.",
        ],
      });
      log({
        level: "ERROR",
        requestId,
        key,
        processedKey,
        outcome: "error",
        reason: "unknown_size",
      });
      return;
    }

    if (resolved.size > MAX_OBJECT_BYTES) {
      await writeSidecar("too_large", {
        size: resolved.size,
        contentType: resolved.contentType,
        etag: normalizeEtag(resolved.etag ?? record.s3.object.eTag),
        notes: [
          `Object size ${resolved.size} bytes exceeds the ${MAX_OBJECT_BYTES} byte limit; the object was not downloaded or hashed.`,
        ],
      });
      log({
        level: "INFO",
        requestId,
        key,
        processedKey,
        outcome: "too_large",
        size: resolved.size,
      });
      return;
    }

    const stored = await store.getObject(bucket, key);
    const body = stored.body;
    const size = stored.contentLength ?? body.length;
    const contentType = stored.contentType ?? resolved.contentType;
    const etag = normalizeEtag(stored.etag ?? resolved.etag ?? record.s3.object.eTag);

    if (body.length > MAX_OBJECT_BYTES) {
      await writeSidecar("too_large", {
        size: body.length,
        contentType,
        etag,
        notes: [
          `Downloaded object is ${body.length} bytes, above the ${MAX_OBJECT_BYTES} byte limit; metadata was not parsed.`,
        ],
      });
      log({
        level: "INFO",
        requestId,
        key,
        processedKey,
        outcome: "too_large",
        size: body.length,
      });
      return;
    }

    const sha256 = createHash("sha256").update(body).digest("hex");
    const extracted = extractImageMetadata(body);

    let outcome: ProcessOutcome;
    if (!extracted.supported) {
      outcome = "unsupported";
    } else if (!extracted.image?.width || !extracted.image?.height) {
      outcome = "incomplete_metadata";
    } else {
      outcome = "ok";
    }

    await writeSidecar(outcome, {
      size,
      contentType,
      etag,
      sha256,
      image: extracted.image,
      exif: extracted.exif,
      notes: extracted.notes,
    });

    log({
      level: "INFO",
      requestId,
      key,
      processedKey,
      outcome,
      size,
      sha256,
      format: extracted.image?.format,
    });
  } catch (error) {
    const notes = [`Processing failed: ${errorMessage(error)}`];
    try {
      await writeSidecar("error", { notes });
      log({
        level: "ERROR",
        requestId,
        key,
        processedKey,
        outcome: "error",
        reason: "processing_failed",
        error: errorMessage(error),
      });
    } catch (writeError) {
      log({
        level: "ERROR",
        requestId,
        key,
        processedKey,
        outcome: "error",
        reason: "sidecar_write_failed",
        error: errorMessage(writeError),
        originalError: errorMessage(error),
      });
      throw writeError;
    }
  }
}

export async function handleS3Event(
  event: S3Event,
  context: HandlerContext,
  store: ObjectStore,
): Promise<void> {
  const records = event.Records ?? [];
  if (records.length === 0) {
    log({
      level: "INFO",
      requestId: context.awsRequestId,
      outcome: "skipped",
      reason: "empty_event",
    });
    return;
  }

  for (const record of records) {
    try {
      await processRecord(record, context, store);
    } catch (error) {
      log({
        level: "ERROR",
        requestId: context.awsRequestId,
        outcome: "error",
        reason: "record_unhandled",
        error: errorMessage(error),
      });
    }
  }
}

export async function handler(event: S3Event, context: Context): Promise<void> {
  await handleS3Event(event, context, defaultStore);
}
