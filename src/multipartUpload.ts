import type { IncomingHttpHeaders } from "node:http";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";

export const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;

export class MultipartUploadError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "MultipartUploadError";
  }
}

export interface MultipartUploadResult {
  bytesWritten: number;
  filename: string;
  mimeType: string;
}

export function streamMultipartFile(
  source: Readable,
  headers: IncomingHttpHeaders,
  createDestination: () => Writable,
  maxFileSize = MAX_UPLOAD_SIZE,
): Promise<MultipartUploadResult> {
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers,
      limits: {
        fileSize: maxFileSize,
        files: 1,
        fields: 4,
        fieldSize: 8 * 1024,
        parts: 6,
        headerPairs: 64,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid multipart upload";
    return Promise.reject(new MultipartUploadError(message, 400));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let parserFinished = false;
    let uploadFinished = false;
    let fileSeen = false;
    let bytesWritten = 0;
    let filename = "";
    let mimeType = "application/octet-stream";
    let completionError: Error | null = null;
    let destinationStream: Writable | null = null;

    const removeSourceListeners = () => {
      source.off("aborted", onAborted);
      source.off("error", onSourceError);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      removeSourceListeners();
      source.unpipe(parser);
      source.resume();
      const failure = error instanceof Error ? error : new Error(String(error));
      if (destinationStream && !destinationStream.destroyed) destinationStream.destroy(failure);
      reject(failure);
    };

    const completeIfReady = () => {
      if (settled || !parserFinished || !uploadFinished) return;
      settled = true;
      removeSourceListeners();
      if (completionError) {
        reject(completionError);
        return;
      }
      resolve({ bytesWritten, filename, mimeType });
    };

    const onAborted = () => fail(new MultipartUploadError("Upload request was aborted", 400));
    const onSourceError = (error: Error) => fail(error);

    source.once("aborted", onAborted);
    source.once("error", onSourceError);

    parser.on("file", (fieldName, file, info) => {
      if (fieldName !== "file") {
        file.resume();
        return;
      }
      if (fileSeen) {
        file.resume();
        fail(new MultipartUploadError("Only one file can be uploaded at a time", 400));
        return;
      }

      fileSeen = true;
      filename = info.filename;
      mimeType = info.mimeType;

      let destination: Writable;
      try {
        destination = createDestination();
        destinationStream = destination;
      } catch (error) {
        file.resume();
        fail(error);
        return;
      }

      file.on("data", (chunk: Buffer) => {
        bytesWritten += chunk.length;
      });
      file.once("limit", () => {
        completionError = new MultipartUploadError(`File exceeds the ${maxFileSize}-byte upload limit`, 413);
      });

      void pipeline(file, destination)
        .then(() => {
          uploadFinished = true;
          completeIfReady();
        })
        .catch(fail);
    });

    parser.once("filesLimit", () => {
      completionError = new MultipartUploadError("Only one file can be uploaded at a time", 400);
    });
    parser.once("fieldsLimit", () => {
      completionError = new MultipartUploadError("Too many multipart fields", 400);
    });
    parser.once("partsLimit", () => {
      completionError = new MultipartUploadError("Too many multipart parts", 400);
    });
    parser.once("error", fail);
    parser.once("close", () => {
      parserFinished = true;
      if (!fileSeen) {
        fail(new MultipartUploadError("Missing file field in upload", 400));
        return;
      }
      completeIfReady();
    });

    source.pipe(parser);
  });
}
