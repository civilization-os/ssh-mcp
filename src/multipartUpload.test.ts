import { Readable, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  MultipartUploadError,
  streamMultipartFile,
} from "./multipartUpload.js";

function multipartBody(boundary: string, file: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="fixture.bin"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function chunk(buffer: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
  }
  return chunks;
}

describe("streamMultipartFile", () => {
  it("streams binary bytes without text transcoding or trimming", async () => {
    const boundary = "ssh-mcp-test-boundary";
    const expected = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0d, 0x0a, 0x20, 0x20]);
    const source = Readable.from(chunk(multipartBody(boundary, expected), 7));
    const destination = new PassThrough();
    const received: Buffer[] = [];
    destination.on("data", data => received.push(Buffer.from(data)));

    const result = await streamMultipartFile(
      source,
      { "content-type": `multipart/form-data; boundary=${boundary}` },
      () => destination,
    );

    expect(Buffer.concat(received)).toEqual(expected);
    expect(result).toEqual({
      bytesWritten: expected.length,
      filename: "fixture.bin",
      mimeType: "application/octet-stream",
    });
  });

  it("rejects files over the configured byte limit", async () => {
    const boundary = "ssh-mcp-limit-boundary";
    const source = Readable.from([multipartBody(boundary, Buffer.from("12345"))]);
    const destination = new PassThrough();
    destination.resume();

    await expect(streamMultipartFile(
      source,
      { "content-type": `multipart/form-data; boundary=${boundary}` },
      () => destination,
      4,
    )).rejects.toMatchObject<Partial<MultipartUploadError>>({ statusCode: 413 });
  });

  it("rejects malformed uploads without creating a destination", async () => {
    let destinationCreated = false;
    await expect(streamMultipartFile(
      Readable.from([Buffer.from("not multipart")]),
      { "content-type": "text/plain" },
      () => {
        destinationCreated = true;
        return new PassThrough();
      },
    )).rejects.toMatchObject<Partial<MultipartUploadError>>({ statusCode: 400 });
    expect(destinationCreated).toBe(false);
  });
});
