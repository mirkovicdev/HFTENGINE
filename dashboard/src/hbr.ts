/** Loader for hftengine session recordings (.hbr) written by runner/src/record.rs.
 *
 * Layout: "HFTREC01" | u32 header length | JSON header | pad to 8 | little-endian arrays.
 */

export type TypedArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int8Array
  | Uint8Array;

export interface ArrayDesc {
  name: string;
  dtype: "f64" | "f32" | "i32" | "u32" | "i8" | "u8";
  shape: number[];
  offset: number;
  length: number;
}

export interface Hbr {
  meta: Record<string, any>;
  arrays: Map<string, { data: TypedArray; shape: number[] }>;
}

const CTORS = {
  f64: Float64Array,
  f32: Float32Array,
  i32: Int32Array,
  u32: Uint32Array,
  i8: Int8Array,
  u8: Uint8Array,
} as const;

export function parseHbr(buf: ArrayBuffer): Hbr {
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
  if (magic !== "HFTREC01") throw new Error(`not an hbr file (magic ${magic})`);
  const hlen = new DataView(buf).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hlen)));
  let start = 12 + hlen;
  start += (8 - (start % 8)) % 8;
  const arrays = new Map<string, { data: TypedArray; shape: number[] }>();
  for (const a of header.arrays as ArrayDesc[]) {
    const C = CTORS[a.dtype];
    const n = a.length / C.BYTES_PER_ELEMENT;
    const abs = start + a.offset;
    // arrays are 8-byte aligned in the file, so a view without copying is valid
    const data = new C(buf, abs, n) as TypedArray;
    arrays.set(a.name, { data, shape: a.shape });
  }
  return { meta: header.meta, arrays };
}

export async function fetchHbr(url: string, onProgress?: (loaded: number, total: number) => void): Promise<Hbr> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  if (!res.body || !onProgress) return parseHbr(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return parseHbr(out.buffer);
}
