import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ObjectStore, StoredObject } from "./types";

export function createS3ObjectStore(client: S3Client = new S3Client({})): ObjectStore {
  return {
    async getObject(bucket: string, key: string): Promise<StoredObject> {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const bytes = response.Body ? await response.Body.transformToByteArray() : new Uint8Array();
      return {
        body: Buffer.from(bytes),
        contentType: response.ContentType,
        contentLength: response.ContentLength,
        etag: response.ETag,
      };
    },

    async putJson(bucket: string, key: string, body: unknown): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(body, null, 2),
          ContentType: "application/json; charset=utf-8",
        }),
      );
    },
  };
}
