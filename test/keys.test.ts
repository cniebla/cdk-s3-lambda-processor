import {
  decodeS3Key,
  isIncomingObjectKey,
  isProcessedObjectKey,
  normalizeEtag,
  toProcessedKey,
} from "../src/keys";

describe("S3 key helpers", () => {
  test("maps incoming object to processed JSON sidecar key", () => {
    expect(toProcessedKey("incoming/sunset.jpg")).toBe("processed/sunset.jpg.json");
    expect(toProcessedKey("incoming/album/pic.png")).toBe("processed/album/pic.png.json");
  });

  test("decodes URL-encoded S3 event keys", () => {
    expect(decodeS3Key("incoming/my%20photo.png")).toBe("incoming/my photo.png");
    expect(decodeS3Key("incoming/my+photo.png")).toBe("incoming/my photo.png");
  });

  test("classifies prefixes so processed writes cannot loop", () => {
    expect(isIncomingObjectKey("incoming/sunset.png")).toBe(true);
    expect(isIncomingObjectKey("incoming/")).toBe(false);
    expect(isIncomingObjectKey("processed/sunset.png.json")).toBe(false);
    expect(isProcessedObjectKey("processed/sunset.png.json")).toBe(true);
    expect(isProcessedObjectKey("incoming/sunset.png")).toBe(false);
  });

  test("strips quotes from etags", () => {
    expect(normalizeEtag('"abc123"')).toBe("abc123");
    expect(normalizeEtag("abc123")).toBe("abc123");
    expect(normalizeEtag(undefined)).toBeUndefined();
  });
});
