// Small HEIC files put together box by box, for testing what Relay reads from a HEIC's header.
// The image data is one flat 512 × 512 HEVC tile (x265), so whatever the header says, the files
// are a few hundred bytes.

const unit = (base64: string) => Buffer.from(base64, "base64");
/** The tile's video, sequence and picture parameter sets, and its one slice. */
const TILE = {
  vps: unit("QAEMAf//BAgAAAMAn6gAAAMAAFq6AkA="),
  sps: unit("QgEBBAgAAAMAn6gAAAMAAFqgBAIAgFlupJMrwFoCAAADAAIAAAMAMhA="),
  pps: unit("RAHBcrBiQA=="),
  slice: unit(
    "KAGvcQW7FqShEOvu+8J8//vCfeOPI9M7Weh8BeAtA2gBm6ZTKFAVILkSQAAACniTA4RYAAADAAADAjaHAAADAAADAAAoIAAAAwAAAwAAErAAAAMAAAMAAXsAAAMAAAMACOgAAAMAAAMAHDA=",
  ),
};

const u8 = (v: number) => Buffer.from([v]);
const u16 = (v: number) => Buffer.from([v >> 8, v & 255]);
const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
};
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]);
};
const full = (type: string, version: number, flags: number, ...parts: Buffer[]) =>
  box(type, u8(version), Buffer.from([(flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);

/**
 * An HEVC sequence parameter set for a picture of this size, written as an encoder would, with
 * `subLayers` extra temporal sub-layers each saying it has a profile and a level.
 */
export function hevcSps(width: number, height: number, subLayers = 0) {
  const bits: number[] = [];
  const put = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push(Math.floor(value / 2 ** i) % 2);
  };
  const ue = (value: number) => {
    const code = value + 1;
    const length = Math.floor(Math.log2(code));
    put(0, length);
    put(code, length + 1);
  };
  put(0, 4); // sps_video_parameter_set_id
  put(subLayers, 3);
  put(1, 1);
  // profile_tier_level: Main profile, level 3.1.
  put(1, 8);
  put(0x60000000, 32);
  put(0b1001, 4);
  put(0, 44);
  put(93, 8);
  for (let i = 0; i < subLayers; i++) put(0b11, 2);
  if (subLayers) put(0, 2 * (8 - subLayers));
  for (let i = 0; i < subLayers; i++) {
    put(0, 88);
    put(93, 8);
  }
  ue(0); // sps_seq_parameter_set_id
  ue(1); // 4:2:0
  ue(width);
  ue(height);
  put(1, 1); // the end of the parameter set, padded to a byte
  while (bits.length % 8) bits.push(0);
  const payload: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    const byte = parseInt(bits.slice(i, i + 8).join(""), 2);
    // Emulation prevention: no two zero bytes followed by a byte below 4.
    if (payload.length >= 2 && !payload.at(-1) && !payload.at(-2) && byte < 4) payload.push(3);
    payload.push(byte);
  }
  return Buffer.from([0x42, 0x01, ...payload]);
}

export type HeicOptions = {
  /** The tile's (or the single image's) `ispe`; null for none. 512 × 512 unless given. */
  ispe?: [number, number] | null;
  /** A grid of the tile, `columns` × `rows`, on a canvas of its own size and with its own `ispe`. */
  grid?: { columns: number; rows: number; canvas?: [number, number]; ispe?: [number, number]; inIdat?: boolean };
  /** A clean-aperture crop on the image shown. */
  clap?: [number, number];
  /** The sequence parameter set in the tile's `hvcC`, instead of the tile's own. */
  sps?: Buffer;
  /** Parameter sets carried in the tile's data, ahead of its slice. */
  inband?: Buffer[];
  /** An overlay item as well. */
  overlay?: boolean;
  /** Tiles listed ahead of the grid, with their data where the grid's is. */
  tilesShareGrid?: boolean;
  /** The first item located, or described, a second time. */
  twice?: "iloc" | "iinf";
};

export function heic(options: HeicOptions = {}) {
  const ispe = options.ispe === undefined ? [512, 512] : options.ispe;
  const grid = options.grid;
  const tiles = grid ? grid.columns * grid.rows : 1;
  const tileIds = Array.from({ length: tiles }, (_, i) => (grid ? i + 2 : 1));
  const nal = (n: Buffer) => [u32(n.length), n];
  const tileData = Buffer.concat([...(options.inband ?? []), TILE.slice].flatMap(nal));
  const canvas = grid?.canvas ?? [512 * (grid?.columns ?? 1), 512 * (grid?.rows ?? 1)];
  const wide = canvas[0] > 65535 || canvas[1] > 65535;
  const gridData = Buffer.concat([
    u8(0),
    u8(wide ? 1 : 0),
    u8((grid?.rows ?? 1) - 1),
    u8((grid?.columns ?? 1) - 1),
    ...(wide ? [u32(canvas[0]), u32(canvas[1])] : [u16(canvas[0]), u16(canvas[1])]),
  ]);
  const hvcC = box(
    "hvcC",
    ...[u8(1), u8(1), u32(0x60000000), Buffer.alloc(6), u8(93), u16(0xf000), u8(0xfc), u8(0xfd)],
    ...[u8(0xf8), u8(0xf8), u16(0), u8(0x0f), u8(3)],
    ...[
      [32, TILE.vps],
      [33, options.sps ?? TILE.sps],
      [34, TILE.pps],
    ].flatMap(([type, n]) => [u8(0x80 | (type as number)), u16(1), u16((n as Buffer).length), n as Buffer]),
  );
  const ispeBox = (size: [number, number]) => full("ispe", 0, 0, u32(size[0]), u32(size[1]));
  const clap = (size: [number, number]) =>
    box("clap", u32(size[0]), u32(1), u32(size[1]), u32(1), u32(0), u32(1), u32(0), u32(1));

  const properties = [hvcC];
  if (ispe) properties.push(ispeBox(ispe as [number, number]));
  const tileProperties = properties.map((_, i) => i + 1);
  const shownProperties: number[] = grid ? [] : tileProperties;
  if (grid?.ispe) shownProperties.push(properties.push(ispeBox(grid.ispe)));
  if (options.clap) shownProperties.push(properties.push(clap(options.clap)));

  const meta = (mdat: number) => {
    const idat = grid?.inIdat;
    const location = (id: number, method: number, offset: number, length: number) => [
      u16(id),
      u16(method),
      u16(0),
      u16(1),
      u32(offset),
      u32(length),
    ];
    const tileOffset = mdat + (grid && !idat ? gridData.length : 0);
    const gridLocation = (id: number) => location(id, idat ? 1 : 0, idat ? 0 : mdat, gridData.length);
    const items = [
      ...(grid ? [gridLocation(1)] : []),
      ...tileIds.map((id) =>
        options.tilesShareGrid ? gridLocation(id) : location(id, 0, tileOffset, tileData.length),
      ),
    ];
    if (options.twice === "iloc") items.push(items[0]);
    const infe = (id: number, type: string) => full("infe", 2, 0, u16(id), u16(0), Buffer.from(type, "latin1"), u8(0));
    const entries = [
      ...(grid ? [infe(1, "grid")] : []),
      ...(grid ? tileIds.map((id) => infe(id, "hvc1")) : [infe(1, "hvc1")]),
    ];
    if (options.tilesShareGrid) entries.push(entries.shift()!);
    if (options.twice === "iinf") entries.push(entries[0]);
    if (options.overlay) entries.push(infe(1000, "iovl"));
    const association = (id: number, list: number[]) => [u16(id), u8(list.length), ...list.map((p) => u8(0x80 | p))];
    return full(
      "meta",
      0,
      0,
      full("hdlr", 0, 0, u32(0), Buffer.from("pict", "latin1"), Buffer.alloc(12), u8(0)),
      full("pitm", 0, 0, u16(1)),
      // Version 1, four-byte offsets and lengths, with a construction method for each item.
      full("iloc", 1, 0, u8(0x44), u8(0x00), u16(items.length), ...items.flat()),
      ...(grid?.inIdat ? [box("idat", gridData)] : []),
      full("iinf", 0, 0, u16(entries.length), ...entries),
      ...(grid ? [full("iref", 0, 0, box("dimg", u16(1), u16(tiles), ...tileIds.map(u16)))] : []),
      box(
        "iprp",
        box("ipco", ...properties),
        full(
          "ipma",
          0,
          0,
          u32(grid ? tiles + 1 : 1),
          ...(grid
            ? [...association(1, shownProperties), ...tileIds.flatMap((id) => association(id, tileProperties))]
            : association(1, shownProperties)),
        ),
      ),
    );
  };
  const ftyp = box("ftyp", Buffer.from("heic", "latin1"), u32(0), Buffer.from("mif1heic", "latin1"));
  const size = ftyp.length + meta(0).length;
  const payload = grid && !grid.inIdat ? Buffer.concat([gridData, tileData]) : tileData;
  return Buffer.concat([ftyp, meta(size + 8), box("mdat", payload)]);
}
