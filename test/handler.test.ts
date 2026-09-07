import { createHash } from "node:crypto";
import type { S3Event, S3EventRecord } from "aws-lambda";
import { handleS3Event } from "../src/handler";
import { MAX_OBJECT_BYTES } from "../src/constants";
import type { ObjectStore, ProcessedSidecar, StoredObject } from "../src/types";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

class MockStore implements ObjectStore {
  objects = new Map<string, StoredObject>();
  puts: { bucket: string; key: string; body: ProcessedSidecar }[] = [];
  getCalls: string[] = [];

  async getObject(bucket: string, key: string): Promise<StoredObject> {
    this.getCalls.push(`${bucket}/${key}`);
    const obj = this.objects.get(`${bucket}/${key}`);
    if (!obj) {
      throw new Error("NoSuchKey");
    }
    return obj;
  }

  async putJson(bucket: string, key: string, body: unknown): Promise<void> {
    this.puts.push({ bucket, key, body: body as ProcessedSidecar });
  }
}

function s3Record(overrides: {
  bucket?: string;
  key: string;
  size?: number;
  eTag?: string;
}): S3EventRecord {
  return {
    eventVersion: "2.1",
    eventSource: "aws:s3",
    awsRegion: "us-west-2",
    eventTime: new Date().toISOString(),
    eventName: "ObjectCreated:Put",
    userIdentity: { principalId: "test" },
    requestParameters: { sourceIPAddress: "127.0.0.1" },
    responseElements: {
      "x-amz-request-id": "req",
      "x-amz-id-2": "id2",
    },
    s3: {
      s3SchemaVersion: "1.0",
      configurationId: "incoming-created",
      bucket: {
        name: overrides.bucket ?? "demo-bucket",
        ownerIdentity: { principalId: "owner" },
        arn: `arn:aws:s3:::${overrides.bucket ?? "demo-bucket"}`,
      },
      object: {
        key: overrides.key,
        size: overrides.size ?? 0,
        eTag: overrides.eTag ?? "etag",
        sequencer: "0",
      },
    },
  } as S3EventRecord;
}

function eventOf(...records: S3EventRecord[]): S3Event {
  return { Records: records };
}

const context = { awsRequestId: "req-123" };

describe("handler", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  test("writes processed JSON sidecar for a PNG under incoming/", async () => {
    const store = new MockStore();
    store.objects.set("demo-bucket/incoming/sunset.png", {
      body: PNG_1X1,
      contentType: "image/png",
      contentLength: PNG_1X1.length,
      etag: '"abc"',
    });

    await handleS3Event(
      eventOf(s3Record({ key: "incoming/sunset.png", size: PNG_1X1.length, eTag: '"abc"' })),
      context,
      store,
    );

    expect(store.getCalls).toEqual(["demo-bucket/incoming/sunset.png"]);
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]?.key).toBe("processed/sunset.png.json");

    const sidecar = store.puts[0]?.body;
    expect(sidecar?.outcome).toBe("ok");
    expect(sidecar?.bucket).toBe("demo-bucket");
    expect(sidecar?.key).toBe("incoming/sunset.png");
    expect(sidecar?.size).toBe(PNG_1X1.length);
    expect(sidecar?.contentType).toBe("image/png");
    expect(sidecar?.etag).toBe("abc");
    expect(sidecar?.sha256).toBe(createHash("sha256").update(PNG_1X1).digest("hex"));
    expect(sidecar?.processedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(sidecar?.image?.width).toBe(1);
    expect(sidecar?.image?.height).toBe(1);
    expect(sidecar?.image?.format).toBe("png");
  });

  test("ignores keys under processed/ so events cannot loop", async () => {
    const store = new MockStore();
    await handleS3Event(
      eventOf(s3Record({ key: "processed/sunset.png.json", size: 12 })),
      context,
      store,
    );
    expect(store.getCalls).toEqual([]);
    expect(store.puts).toEqual([]);
  });

  test("does not write under incoming/ for non-incoming keys", async () => {
    const store = new MockStore();
    await handleS3Event(eventOf(s3Record({ key: "other/file.png", size: 10 })), context, store);
    expect(store.puts).toEqual([]);
  });

  test("rejects oversize objects with a processed JSON and does not download", async () => {
    const store = new MockStore();
    const size = MAX_OBJECT_BYTES + 1;
    await handleS3Event(
      eventOf(s3Record({ key: "incoming/huge.jpg", size })),
      context,
      store,
    );

    expect(store.getCalls).toEqual([]);
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]?.key).toBe("processed/huge.jpg.json");
    expect(store.puts[0]?.body.outcome).toBe("too_large");
    expect(store.puts[0]?.body.notes.join(" ")).toMatch(/exceeds/);
    expect(store.puts[0]?.body.sha256).toBeUndefined();
  });

  test("writes unsupported sidecar for non-image objects and does not throw", async () => {
    const store = new MockStore();
    const body = Buffer.from("this is not an image", "utf8");
    store.objects.set("demo-bucket/incoming/notes.txt", {
      body,
      contentType: "text/plain",
      contentLength: body.length,
      etag: "txt",
    });

    await expect(
      handleS3Event(
        eventOf(s3Record({ key: "incoming/notes.txt", size: body.length })),
        context,
        store,
      ),
    ).resolves.toBeUndefined();

    expect(store.puts[0]?.key).toBe("processed/notes.txt.json");
    expect(store.puts[0]?.body.outcome).toBe("unsupported");
    expect(store.puts[0]?.body.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(store.puts[0]?.body.notes.length).toBeGreaterThan(0);
  });

  test("overwrites processed JSON for the same incoming key", async () => {
    const store = new MockStore();
    store.objects.set("demo-bucket/incoming/sunset.png", {
      body: PNG_1X1,
      contentType: "image/png",
      contentLength: PNG_1X1.length,
    });
    const evt = eventOf(s3Record({ key: "incoming/sunset.png", size: PNG_1X1.length }));
    await handleS3Event(evt, context, store);
    await handleS3Event(evt, context, store);
    expect(store.puts).toHaveLength(2);
    expect(store.puts[0]?.key).toBe("processed/sunset.png.json");
    expect(store.puts[1]?.key).toBe("processed/sunset.png.json");
  });

  test("decodes URL-encoded incoming keys before writing the sidecar", async () => {
    const store = new MockStore();
    store.objects.set("demo-bucket/incoming/my photo.png", {
      body: PNG_1X1,
      contentType: "image/png",
      contentLength: PNG_1X1.length,
    });

    await handleS3Event(
      eventOf(s3Record({ key: "incoming/my%20photo.png", size: PNG_1X1.length })),
      context,
      store,
    );

    expect(store.getCalls).toEqual(["demo-bucket/incoming/my photo.png"]);
    expect(store.puts[0]?.key).toBe("processed/my photo.png.json");
    expect(store.puts[0]?.body.key).toBe("incoming/my photo.png");
  });

  test("refuses to download when the S3 event omits object size", async () => {
    const store = new MockStore();
    store.objects.set("demo-bucket/incoming/sunset.png", {
      body: PNG_1X1,
      contentType: "image/png",
      contentLength: PNG_1X1.length,
    });
    const rec = s3Record({ key: "incoming/sunset.png" });
    delete (rec.s3.object as { size?: number }).size;

    await handleS3Event(eventOf(rec), context, store);

    expect(store.getCalls).toEqual([]);
    expect(store.puts[0]?.key).toBe("processed/sunset.png.json");
    expect(store.puts[0]?.body.outcome).toBe("error");
    expect(store.puts[0]?.body.notes.join(" ")).toMatch(/did not include object size/i);
  });

  test("writes an error sidecar when GetObject fails and still succeeds", async () => {
    const store = new MockStore();
    await expect(
      handleS3Event(
        eventOf(s3Record({ key: "incoming/missing.png", size: 100 })),
        context,
        store,
      ),
    ).resolves.toBeUndefined();
    expect(store.puts[0]?.body.outcome).toBe("error");
    expect(store.puts[0]?.key).toBe("processed/missing.png.json");
  });
});
