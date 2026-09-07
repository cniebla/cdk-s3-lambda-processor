import ExifReader from "exifreader";
import type { ImageInfo } from "./types";

const SUPPORTED_FORMATS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
]);

const SELECTED_EXIF_TAGS = [
  "Make",
  "Model",
  "Software",
  "DateTime",
  "DateTimeOriginal",
  "DateTimeDigitized",
  "Orientation",
  "ImageWidth",
  "ImageHeight",
  "Image Width",
  "Image Height",
  "XResolution",
  "YResolution",
  "ResolutionUnit",
  "ColorSpace",
  "ExposureTime",
  "FNumber",
  "ISOSpeedRatings",
  "ISOSpeedRating",
  "ISO",
  "FocalLength",
  "FocalLengthIn35mmFilm",
  "Flash",
  "WhiteBalance",
  "ExposureProgram",
  "MeteringMode",
  "LensModel",
  "LensMake",
  "GPSLatitude",
  "GPSLongitude",
  "GPSAltitude",
] as const;

const SKIP_EXIF_TAGS = new Set([
  "MakerNote",
  "UserComment",
  "thumbnail",
  "Thumbnail",
  "Images",
  "ApplicationNotes",
]);

export interface MetadataExtraction {
  supported: boolean;
  image?: ImageInfo;
  exif?: Record<string, string | number | boolean>;
  notes: string[];
}

export function sniffImageFormat(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
      return "gif";
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "bmp";
  }
  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))
  ) {
    return "tiff";
  }
  return undefined;
}

interface Dimensions {
  width: number;
  height: number;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

function pngDimensions(buffer: Buffer): Dimensions | undefined {
  if (buffer.length < 24) {
    return undefined;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) {
    return undefined;
  }
  return { width, height };
}

function jpegDimensions(buffer: Buffer): Dimensions | undefined {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      return undefined;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) {
      return undefined;
    }
    const marker = buffer[offset]!;
    offset += 1;
    if (marker === 0xda || marker === 0xd9) {
      return undefined;
    }
    if (offset + 2 > buffer.length) {
      return undefined;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2) {
      return undefined;
    }
    const sof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (sof && offset + 7 <= buffer.length) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) {
        return undefined;
      }
      return { width, height };
    }
    offset += segmentLength;
  }
  return undefined;
}

function gifDimensions(buffer: Buffer): Dimensions | undefined {
  if (buffer.length < 10) {
    return undefined;
  }
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (width === 0 || height === 0) {
    return undefined;
  }
  return { width, height };
}

function bmpDimensions(buffer: Buffer): Dimensions | undefined {
  if (buffer.length < 26) {
    return undefined;
  }
  const headerSize = buffer.readUInt32LE(14);
  let width: number;
  let height: number;
  if (headerSize === 12 && buffer.length >= 22) {
    width = buffer.readUInt16LE(18);
    height = buffer.readUInt16LE(20);
  } else {
    width = buffer.readInt32LE(18);
    height = Math.abs(buffer.readInt32LE(22));
  }
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

function webpDimensions(buffer: Buffer): Dimensions | undefined {
  if (buffer.length < 30) {
    return undefined;
  }
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    const width = readUInt24LE(buffer, 24) + 1;
    const height = readUInt24LE(buffer, 27) + 1;
    return { width, height };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    if (buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      if (width === 0 || height === 0) {
        return undefined;
      }
      return { width, height };
    }
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return undefined;
}

function tiffDimensions(buffer: Buffer): Dimensions | undefined {
  if (buffer.length < 8) {
    return undefined;
  }
  const little = buffer[0] === 0x49;
  const readU16 = (offset: number) =>
    little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const readU32 = (offset: number) =>
    little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const ifdOffset = readU32(4);
  if (ifdOffset + 2 > buffer.length) {
    return undefined;
  }
  const entryCount = readU16(ifdOffset);
  let width: number | undefined;
  let height: number | undefined;
  for (let i = 0; i < entryCount; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > buffer.length) {
      break;
    }
    const tag = readU16(entry);
    const type = readU16(entry + 2);
    const valueOffset = entry + 8;
    const value =
      type === 3 ? readU16(valueOffset) : type === 4 ? readU32(valueOffset) : undefined;
    if (tag === 256) width = value;
    if (tag === 257) height = value;
    if (width && height) {
      return { width, height };
    }
  }
  if (width && height) {
    return { width, height };
  }
  return undefined;
}

export function readImageDimensions(
  buffer: Buffer,
  format?: string,
): Dimensions | undefined {
  switch (format) {
    case "png":
      return pngDimensions(buffer);
    case "jpeg":
      return jpegDimensions(buffer);
    case "gif":
      return gifDimensions(buffer);
    case "bmp":
      return bmpDimensions(buffer);
    case "webp":
      return webpDimensions(buffer);
    case "tiff":
      return tiffDimensions(buffer);
    default:
      return undefined;
  }
}

function serializeExifValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) {
    return value.join(", ");
  }
  return undefined;
}

function collectSelectedExif(buffer: Buffer): {
  exif?: Record<string, string | number | boolean>;
  notes: string[];
} {
  const notes: string[] = [];
  try {
    const tags = ExifReader.load(buffer);
    const selected: Record<string, string | number | boolean> = {};

    for (const name of SELECTED_EXIF_TAGS) {
      const tag = tags[name];
      if (!tag || SKIP_EXIF_TAGS.has(name)) {
        continue;
      }
      const serialized =
        serializeExifValue(tag.description) ?? serializeExifValue(tag.value);
      if (serialized !== undefined && serialized !== "") {
        selected[name] = serialized;
      }
    }

    if (Object.keys(selected).length === 0) {
      return { notes };
    }
    return { exif: selected, notes };
  } catch {
    return { notes };
  }
}

export function extractImageMetadata(buffer: Buffer): MetadataExtraction {
  const notes: string[] = [];
  const sniffed = sniffImageFormat(buffer);
  const format = sniffed === "jpeg" ? "jpeg" : sniffed;
  const dimensions = readImageDimensions(buffer, sniffed);
  const formatKey = format?.toLowerCase();
  const supported = formatKey !== undefined && SUPPORTED_FORMATS.has(formatKey);

  if (!supported) {
    notes.push(
      sniffed
        ? `Detected format "${sniffed}" is not in the supported image set.`
        : "Object is not a supported image (JPEG, PNG, GIF, WebP, BMP, TIFF).",
    );
  }

  const { exif, notes: exifNotes } = collectSelectedExif(buffer);
  notes.push(...exifNotes);

  const image: ImageInfo = {};
  if (dimensions?.width) image.width = dimensions.width;
  if (dimensions?.height) image.height = dimensions.height;
  if (format) {
    image.format = format;
    image.type = format === "jpeg" ? "jpeg" : format;
  }
  if (typeof exif?.Orientation === "string" || typeof exif?.Orientation === "number") {
    image.orientation = exif.Orientation;
  }

  const hasImageFields = Object.keys(image).length > 0;
  if (supported && (image.width === undefined || image.height === undefined)) {
    notes.push("Width/height could not be determined from image headers.");
  }

  return {
    supported,
    image: hasImageFields ? image : undefined,
    exif,
    notes,
  };
}
