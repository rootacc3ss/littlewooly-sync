// ObjectBackend over S3, built for "any S3-compatible provider".
//
// Uses the Node HTTP handler (desktop-only) so requests bypass the Electron renderer's
// fetch/CORS path that breaks iDrive e2 / Filebase / Mega S4 / self-hosted MinIO. Supports
// path-style vs virtual-hosted addressing, custom request headers (auth proxies), S3
// conditional create (If-None-Match) for immutable objects + manifest CAS, and a
// testConnection() sanity check.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ObjectBackend, ObjectInfo, PutOptions, PreconditionFailedError } from "./backend";
import type { S3Config } from "../types";

function statusOf(e: unknown): number | undefined {
  const meta = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata;
  const name = (e as { name?: string })?.name;
  if (meta?.httpStatusCode) return meta.httpStatusCode;
  if (name === "NotFound" || name === "NoSuchKey") return 404;
  return undefined;
}

export class S3Backend implements ObjectBackend {
  private client: S3Client;
  private bucket: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region || "us-east-1",
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      requestHandler: new NodeHttpHandler(),
    });

    if (cfg.customHeaders && Object.keys(cfg.customHeaders).length > 0) {
      const headers = cfg.customHeaders;
      this.client.middlewareStack.add(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (next: any) => async (args: any) => {
          if (args.request?.headers) Object.assign(args.request.headers, headers);
          return next(args);
        },
        { step: "build", name: "lwsCustomHeaders" },
      );
    }
  }

  async put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ...(opts?.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
        }),
      );
    } catch (e) {
      if (statusOf(e) === 412) throw new PreconditionFailedError(key);
      throw e;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      // SdkStream helper (Node + browser): collects the stream into bytes.
      return await (
        res.Body as { transformToByteArray(): Promise<Uint8Array> }
      ).transformToByteArray();
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, size: res.ContentLength ?? 0 };
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Quick reachability + auth check. Throws with a useful message on failure. */
  async testConnection(): Promise<void> {
    await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
  }

  /**
   * Probe whether the backend honors conditional create (If-None-Match: *). Some
   * S3-compatible stores silently ignore it; the manifest CAS degrades gracefully when
   * this returns false, but we warn the user.
   */
  async probeConditionalPut(): Promise<boolean> {
    const key = "meta/.lws-cas-probe";
    const body = new Uint8Array([1]);
    await this.put(key, body); // ensure it exists
    try {
      await this.put(key, body, { ifNoneMatch: true });
      return false; // should have thrown; backend ignores the precondition
    } catch (e) {
      return e instanceof PreconditionFailedError;
    } finally {
      await this.delete(key).catch(() => {});
    }
  }
}
