export type ProcessOutcome =
  | "ok"
  | "unsupported"
  | "too_large"
  | "incomplete_metadata"
  | "error"
  | "skipped";

export interface ImageInfo {
  width?: number;
  height?: number;
  format?: string;
  type?: string;
  orientation?: number | string;
}

export interface ProcessedSidecar {
  bucket: string;
  key: string;
  processedKey: string;
  size?: number;
  contentType?: string;
  etag?: string;
  sha256?: string;
  processedAt: string;
  outcome: ProcessOutcome;
  image?: ImageInfo;
  exif?: Record<string, string | number | boolean>;
  notes: string[];
}

export interface StoredObject {
  body: Buffer;
  contentType?: string;
  contentLength?: number;
  etag?: string;
}

export interface ObjectHead {
  contentType?: string;
  contentLength?: number;
  etag?: string;
}

export interface ObjectStore {
  headObject(bucket: string, key: string): Promise<ObjectHead>;
  getObject(bucket: string, key: string): Promise<StoredObject>;
  putJson(bucket: string, key: string, body: unknown): Promise<void>;
}

export interface HandlerContext {
  awsRequestId: string;
}
