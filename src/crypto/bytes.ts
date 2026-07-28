// Bridges @types/node's generic `Uint8Array<ArrayBufferLike>` to WebCrypto's
// `BufferSource` (which requires an `ArrayBuffer`-backed view). Our byte arrays are
// always ArrayBuffer-backed at runtime, so this is a zero-copy type assertion, not a
// cast that hides a real mismatch.
export type Bytes = Uint8Array<ArrayBuffer>;

export function view(u: Uint8Array): Bytes {
  return u as Bytes;
}
