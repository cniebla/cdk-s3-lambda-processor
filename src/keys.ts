import { INCOMING_PREFIX, PROCESSED_PREFIX } from "./constants";

/** S3 event keys are URL-encoded; spaces may appear as `+`. */
export function decodeS3Key(rawKey: string): string {
  return decodeURIComponent(rawKey.replace(/\+/g, " "));
}

export function normalizeEtag(etag?: string): string | undefined {
  if (!etag) {
    return undefined;
  }
  return etag.replaceAll('"', "");
}

export function isIncomingObjectKey(key: string): boolean {
  return (
    key.startsWith(INCOMING_PREFIX) &&
    key.length > INCOMING_PREFIX.length &&
    !key.endsWith("/")
  );
}

export function isProcessedObjectKey(key: string): boolean {
  return key.startsWith(PROCESSED_PREFIX);
}

/**
 * incoming/sunset.jpg -> processed/sunset.jpg.json
 * incoming/album/pic.png -> processed/album/pic.png.json
 */
export function toProcessedKey(incomingKey: string): string {
  const relative = incomingKey.startsWith(INCOMING_PREFIX)
    ? incomingKey.slice(INCOMING_PREFIX.length)
    : incomingKey;
  return `${PROCESSED_PREFIX}${relative}.json`;
}
