// What a HEIF file (HEIC or AVIF) will make its decoder allocate, read from its boxes without
// decoding anything. The size a decoder reports is the size after any crop the file asks for, so a
// 64 × 64 crop of a 32768 × 32768 grid looks small while the whole grid is decoded. What decides
// the memory is the largest of everything the file declares or carries:
// - each image's `ispe` property;
// - the canvas of each grid, which lives in the grid item's own data, not in its properties;
// - for HEVC (HEIC), the picture size in each sequence parameter set, in the `hvcC` properties and
//   inside the items' coded data, because libde265 allocates a frame of that size before libheif
//   compares it with anything.
// For AVIF it also reads the AV1 streams themselves for their bit depth and chroma, since those,
// not the `av1C` property that describes them, decide what aom allocates.

export type HeifLayout = {
  /** The largest image anything in the file declares, by area. */
  width: number;
  height: number;
  /** The longest side anything in the file declares. */
  side: number;
  /** Whether an image is put together from others: a grid of tiles, an overlay, or a derived copy. */
  derived: boolean;
  /** Whether an image is an overlay of others, whose canvas these limits don't read. */
  overlay: boolean;
  /**
   * Whether the file is AV1 whose every stream is 8-bit 4:2:0 or greyscale, with no transparency
   * or other auxiliary image: what an 8-bit phone photo holds. False if anything is unclear.
   */
  eightBitAv1: boolean;
};

type Box = { type: string; body: number; end: number };

/** The boxes inside [start, end) of an ISO media file. Throws if one doesn't fit. */
function* boxes(data: Buffer, start: number, end: number): Generator<Box> {
  let i = start;
  while (i + 8 <= end) {
    let size = data.readUInt32BE(i);
    let header = 8;
    if (size === 1) {
      if (i + 16 > end) throw new RangeError("box too short");
      size = Number(data.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) size = end - i;
    if (size < header || i + size > end) throw new RangeError("box overruns its parent");
    yield { type: data.toString("latin1", i + 4, i + 8), body: i + header, end: i + size };
    i += size;
  }
}

/** Reads big-endian unsigned integers of any byte width within [at, end). */
class Reader {
  private readonly data: Buffer;
  private readonly end: number;
  at: number;
  constructor(data: Buffer, at: number, end: number) {
    this.data = data;
    this.at = at;
    this.end = end;
  }
  uint(bytes: number) {
    if (this.at + bytes > this.end) throw new RangeError("box too short");
    let value = 0;
    for (let i = 0; i < bytes; i++) value = value * 256 + this.data[this.at + i];
    this.at += bytes;
    return value;
  }
}

/** Reads bits, most significant first, as HEVC's parameter sets are written. */
class Bits {
  private readonly bytes: number[];
  private at = 0;
  constructor(bytes: number[]) {
    this.bytes = bytes;
  }
  bit() {
    if (this.at >= this.bytes.length * 8) throw new RangeError("parameter set too short");
    const bit = (this.bytes[this.at >> 3] >> (7 - (this.at & 7))) & 1;
    this.at++;
    return bit;
  }
  read(count: number) {
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 2 + this.bit();
    return value;
  }
  skip(count: number) {
    this.at += count;
  }
  /** An Exp-Golomb coded number, ue(v). */
  ue() {
    let zeros = 0;
    while (!this.bit()) if (++zeros > 31) throw new RangeError("number too long");
    return 2 ** zeros - 1 + this.read(zeros);
  }
}

const HEVC_SPS = 33;
/** Enough of a parameter set for every field up to the picture size, however many sub-layers it has. */
const SPS_PREFIX_BYTES = 192;

/**
 * The picture size in an HEVC sequence parameter set (H.265 7.3.2.2), or null if the unit is
 * something else, or for a layer libde265 skips.
 */
function spsSize(nal: Buffer): [number, number] | null {
  if (nal.length < 2 || ((nal[0] >> 1) & 0x3f) !== HEVC_SPS) return null;
  if (((nal[0] & 1) << 5) | (nal[1] >> 3)) return null;
  // The payload without its emulation prevention bytes (a 3 after two zero bytes).
  const bytes: number[] = [];
  let zeros = 0;
  for (let i = 2; i < nal.length && bytes.length < SPS_PREFIX_BYTES; i++) {
    if (zeros >= 2 && nal[i] === 3) {
      zeros = 0;
      continue;
    }
    bytes.push(nal[i]);
    zeros = nal[i] === 0 ? zeros + 1 : 0;
  }
  const bits = new Bits(bytes);
  bits.skip(4); // sps_video_parameter_set_id
  const subLayers = bits.read(3); // sps_max_sub_layers_minus1
  bits.skip(1); // sps_temporal_id_nesting_flag
  // profile_tier_level: the general profile and level, then what each sub-layer says it has.
  bits.skip(96);
  const present: [number, number][] = [];
  for (let i = 0; i < subLayers; i++) present.push([bits.bit(), bits.bit()]);
  if (subLayers > 0) bits.skip(2 * (8 - subLayers));
  for (const [profile, level] of present) bits.skip(profile * 88 + level * 8);
  bits.ue(); // sps_seq_parameter_set_id
  if (bits.ue() === 3) bits.skip(1); // chroma_format_idc, separate_colour_plane_flag
  return [bits.ue(), bits.ue()];
}

/** The NAL units of an HEVC item's data, each with a four-byte length as libheif reads them. */
function* nalUnits(data: Buffer) {
  for (let i = 0; i + 4 <= data.length;) {
    const size = data.readUInt32BE(i);
    i += 4;
    yield data.subarray(i, Math.min(i + size, data.length));
    i += size;
  }
}

/** The parameter sets an `hvcC` property carries for its image. */
function* configurationUnits(data: Buffer, box: Box) {
  const r = new Reader(data, box.body + 22, box.end);
  const arrays = r.uint(1);
  for (let a = 0; a < arrays; a++) {
    r.uint(1); // array_completeness and NAL_unit_type
    const count = r.uint(2);
    for (let n = 0; n < count; n++) {
      const length = r.uint(2);
      if (r.at + length > box.end) throw new RangeError("parameter set overruns its box");
      yield data.subarray(r.at, r.at + length);
      r.at += length;
    }
  }
}

type Extent = { start: number; end: number };

/**
 * Where each item's data is (the `iloc` box): byte ranges in the file or in `idat`. Null for an item
 * whose data is elsewhere (another file, or other items' data), which these limits can't read.
 */
function itemLocations(data: Buffer, iloc: Box, idat: Box | undefined) {
  const r = new Reader(data, iloc.body, iloc.end);
  const version = r.uint(1);
  r.uint(3);
  if (version > 2) throw new RangeError("unknown iloc version");
  const sizes = r.uint(1);
  const more = r.uint(1);
  const [offsetSize, lengthSize, baseSize] = [sizes >> 4, sizes & 15, more >> 4];
  const indexSize = version ? more & 15 : 0;
  const count = r.uint(version < 2 ? 2 : 4);
  const items = new Map<number, Extent[] | null>();
  for (let n = 0; n < count; n++) {
    const id = r.uint(version < 2 ? 2 : 4);
    const method = version ? r.uint(2) & 15 : 0;
    const external = r.uint(2) !== 0;
    const base = r.uint(baseSize);
    const extentCount = r.uint(2);
    const source =
      external || method > 1
        ? null
        : method === 0
          ? { start: 0, end: data.length }
          : idat
            ? { start: idat.body, end: idat.end }
            : null;
    let extents: Extent[] | null = source ? [] : null;
    for (let e = 0; e < extentCount; e++) {
      r.uint(indexSize);
      const offset = r.uint(offsetSize);
      const length = r.uint(lengthSize);
      if (!source || !extents) continue;
      const start = source.start + base + offset;
      // A length of 0 means the rest of the source.
      const end = length ? start + length : source.end;
      if (end > source.end || start > end) extents = null;
      else extents.push({ start, end });
    }
    items.set(id, extents);
  }
  return items;
}

const AV1_SEQUENCE_HEADER = 1;

/** The OBUs of an AV1 stream, each with its size (AV1 5.3), as libheif hands them to aom. */
function* obus(data: Buffer) {
  for (let i = 0; i < data.length;) {
    const header = data[i++];
    if (header & 4) i++; // obu_extension_flag: one more header byte
    let size = data.length - i;
    if (header & 2) {
      // obu_has_size_field: a LEB128 number
      size = 0;
      for (let b = 0; b < 8; b++) {
        if (i >= data.length) throw new RangeError("OBU too short");
        const byte = data[i++];
        size += (byte & 0x7f) * 2 ** (7 * b);
        if (!(byte & 0x80)) break;
      }
    }
    yield { type: (header >> 3) & 15, payload: data.subarray(i, Math.min(i + size, data.length)) };
    i += size;
  }
}

/**
 * Whether an AV1 sequence header (AV1 5.5) describes 8-bit 4:2:0 or greyscale pictures: Main
 * profile without high bit depth, and not the 4:4:4 sRGB form. Fields are skipped up to the
 * colour configuration, as aom reads them.
 */
function av1EightBit(payload: Buffer) {
  const bits = new Bits([...payload.subarray(0, 512)]);
  const profile = bits.read(3);
  bits.skip(1); // still_picture
  const reduced = bits.bit() === 1;
  if (!reduced) {
    // Not reduced_still_picture_header: timing, decoder models and operating points.
    let decoderModel = false;
    let delayLength = 0;
    if (bits.bit()) {
      // timing_info
      bits.skip(64);
      if (bits.bit()) {
        // num_ticks_per_picture_minus_1, uvlc()
        let zeros = 0;
        while (!bits.bit()) if (++zeros > 32) throw new RangeError("number too long");
        bits.skip(zeros);
      }
      decoderModel = bits.bit() === 1;
      if (decoderModel) {
        delayLength = bits.read(5) + 1;
        bits.skip(32 + 5 + 5);
      }
    }
    const initialDisplayDelay = bits.bit() === 1;
    const operatingPoints = bits.read(5) + 1;
    for (let i = 0; i < operatingPoints; i++) {
      bits.skip(12); // operating_point_idc
      if (bits.read(5) > 7) bits.skip(1); // seq_level_idx, seq_tier
      if (decoderModel && bits.bit()) bits.skip(2 * delayLength + 1);
      if (initialDisplayDelay && bits.bit()) bits.skip(4);
    }
  } else bits.skip(5); // seq_level_idx
  const widthBits = bits.read(4) + 1;
  const heightBits = bits.read(4) + 1;
  bits.skip(widthBits + heightBits); // max_frame_width_minus_1, max_frame_height_minus_1
  if (!reduced && bits.bit()) bits.skip(4 + 3); // frame_id_numbers_present_flag and their lengths
  bits.skip(3); // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
  if (!reduced) {
    bits.skip(4); // interintra and masked compound, warped motion, dual filter
    const orderHint = bits.bit() === 1;
    if (orderHint) bits.skip(2); // enable_jnt_comp, enable_ref_frame_mvs
    // seq_choose_screen_content_tools, else seq_force_screen_content_tools
    const screenContent = bits.bit() ? 2 : bits.bit();
    if (screenContent > 0 && !bits.bit()) bits.skip(1); // seq_choose_integer_mv, seq_force_integer_mv
    if (orderHint) bits.skip(3); // order_hint_bits_minus_1
  }
  bits.skip(3); // enable_superres, enable_cdef, enable_restoration
  // color_config
  if (profile !== 0 || bits.bit()) return false; // 4:4:4 or 4:2:2 profiles, or high_bitdepth
  if (bits.bit()) return true; // mono_chrome
  if (bits.bit()) {
    // color_primaries, transfer_characteristics, matrix_coefficients: BT.709, sRGB and identity is 4:4:4.
    const [primaries, transfer, matrix] = [bits.read(8), bits.read(8), bits.read(8)];
    if (primaries === 1 && transfer === 13 && matrix === 0) return false;
  }
  return true;
}

const DERIVED_ITEMS = new Set(["grid", "iovl", "iden"]);
/** NAL units and OBUs walked in all of a file's items. A photo's tiles have a few each. */
const MAX_UNITS = 100_000;

/**
 * Walks a HEIF file's boxes without decoding it: the largest image it declares or carries, and
 * whether any image is derived from others. Null if the file's structure is damaged, if image data
 * these limits need is out of reach, or if the file reads the same data over and over.
 */
export function heifLayout(data: Buffer): HeifLayout | null {
  try {
    // Only the boxes up to meta are read: what follows is the image data.
    let meta: Box | undefined;
    for (const box of boxes(data, 0, data.length)) {
      if (box.type !== "meta") continue;
      meta = box;
      break;
    }
    if (!meta) return null;
    const found: Record<string, Box> = {};
    // meta, iinf, infe, iloc and ispe are full boxes: a version byte and three bytes of flags come first.
    for (const box of boxes(data, meta.body + 4, meta.end)) found[box.type] ??= box;

    const types = new Map<number, string>();
    if (found.iinf) {
      const first = found.iinf.body + (data[found.iinf.body] === 0 ? 6 : 8);
      for (const entry of boxes(data, first, found.iinf.end)) {
        const version = data[entry.body];
        if (entry.type !== "infe" || version < 2) continue;
        const r = new Reader(data, entry.body + 4, entry.end);
        const id = r.uint(version === 2 ? 2 : 4);
        r.uint(2); // item_protection_index
        types.set(id, data.toString("latin1", r.at, r.at + 4));
      }
    }

    let [width, height, side] = [0, 0, 0];
    const declare = (w: number, h: number) => {
      if (w * h > width * height) [width, height] = [w, h];
      side = Math.max(side, w, h);
    };
    const declareSps = (nal: Buffer) => {
      const size = spsSize(nal);
      if (size) declare(...size);
    };

    const all = new Set(types.values());
    // Cleared by anything that isn't plainly an 8-bit AV1 stream.
    let eightBitAv1 = all.has("av01") && !all.has("hvc1");
    let av1Headers = 0;
    let units = 0;
    const av1Stream = (stream: Buffer) => {
      for (const obu of obus(stream)) {
        if (++units > MAX_UNITS) throw new RangeError("too many units");
        if (obu.type !== AV1_SEQUENCE_HEADER) continue;
        av1Headers++;
        if (!av1EightBit(obu.payload)) eightBitAv1 = false;
      }
    };

    const ipco = found.iprp && [...boxes(data, found.iprp.body, found.iprp.end)].find((box) => box.type === "ipco");
    if (ipco) {
      for (const property of boxes(data, ipco.body, ipco.end)) {
        if (property.type === "ispe" && property.body + 12 <= property.end)
          declare(data.readUInt32BE(property.body + 4), data.readUInt32BE(property.body + 8));
        else if (property.type === "hvcC") for (const nal of configurationUnits(data, property)) declareSps(nal);
        // Transparency, depth and the like are images of their own, with their own costs.
        else if (property.type === "auxC") eightBitAv1 = false;
        else if (property.type === "av1C" && eightBitAv1) {
          // configOBUs, ahead of the item's own data.
          try {
            av1Stream(data.subarray(property.body + 4, property.end));
          } catch {
            eightBitAv1 = false;
          }
        }
      }
    }

    const needsData = [...types].filter(([, type]) => type === "grid" || type === "hvc1");
    const av1Items = eightBitAv1 ? [...types].filter(([, type]) => type === "av01") : [];
    if (needsData.length || av1Items.length) {
      const locations = found.iloc ? itemLocations(data, found.iloc, found.idat) : new Map<number, null>();
      // Items sharing the same bytes are read once; beyond that, a file's items can't hold more
      // than the file does.
      const read = new Set<string>();
      let budget = data.length;
      const itemData = (id: number) => {
        const extents = locations.get(id);
        if (!extents) return null;
        const key = extents.map((e) => `${e.start}-${e.end}`).join(",");
        if (read.has(key)) return Buffer.alloc(0);
        read.add(key);
        for (const e of extents) budget -= e.end - e.start;
        if (budget < 0) return null;
        return extents.length === 1
          ? data.subarray(extents[0].start, extents[0].end)
          : Buffer.concat(extents.map((e) => data.subarray(e.start, e.end)));
      };
      for (const [id, type] of needsData) {
        const item = itemData(id);
        if (!item) return null;
        if (!item.length) continue;
        if (type === "grid") {
          // version, flags, rows - 1, columns - 1, then the canvas: 16 bits a side, or 32 if flags say so.
          const r = new Reader(item, 0, item.length);
          r.uint(1);
          const wide = r.uint(1) & 1 ? 4 : 2;
          r.uint(2);
          declare(r.uint(wide), r.uint(wide));
        } else {
          for (const nal of nalUnits(item)) {
            if (++units > MAX_UNITS) return null;
            declareSps(nal);
          }
        }
      }
      for (const [id] of av1Items) {
        try {
          const item = itemData(id);
          if (item) av1Stream(item);
          else eightBitAv1 = false;
        } catch {
          eightBitAv1 = false;
        }
      }
    }

    return width && height
      ? {
          width,
          height,
          side,
          derived: [...DERIVED_ITEMS].some((type) => all.has(type)),
          overlay: all.has("iovl"),
          eightBitAv1: eightBitAv1 && av1Headers > 0,
        }
      : null;
  } catch {
    return null;
  }
}
