import { extractImageMetadata, sniffImageFormat } from "../src/metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 1x1 red PNG */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

describe("image metadata extraction", () => {
  test("reads width, height, and format from a PNG", () => {
    const result = extractImageMetadata(PNG_1X1);
    expect(result.supported).toBe(true);
    expect(result.image?.width).toBe(1);
    expect(result.image?.height).toBe(1);
    expect(result.image?.format).toBe("png");
    expect(result.image?.type).toBe("png");
  });

  test("sniffs PNG magic bytes", () => {
    expect(sniffImageFormat(PNG_1X1)).toBe("png");
  });

  test("marks plain text as unsupported without throwing", () => {
    const result = extractImageMetadata(Buffer.from("not an image", "utf8"));
    expect(result.supported).toBe(false);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.notes.join(" ")).toMatch(/not a supported image/i);
  });

  test("reads the checked-in sample PNG", () => {
    const sample = readFileSync(join(__dirname, "..", "samples", "sunset.png"));
    const result = extractImageMetadata(sample);
    expect(result.supported).toBe(true);
    expect(result.image?.format).toBe("png");
    expect(result.image?.width).toBe(160);
    expect(result.image?.height).toBe(96);
  });
});
