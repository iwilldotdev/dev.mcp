import { createHash } from "node:crypto";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type ImageInspection = {
  sha256: string;
  mime: string;
  byteLength: number;
  width?: number;
  height?: number;
};

export function inspectImage(data: Buffer, mime = "application/octet-stream"): ImageInspection {
  const sha256 = createHash("sha256").update(data).digest("hex");
  const inspection: ImageInspection = { sha256, mime, byteLength: data.length };
  if (data.length >= 24 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    inspection.mime = "image/png";
    inspection.width = data.readUInt32BE(16);
    inspection.height = data.readUInt32BE(20);
  } else if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    inspection.mime = "image/jpeg";
  }
  return inspection;
}
