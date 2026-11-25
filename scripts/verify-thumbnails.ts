// Verifies that no image can make a preview cost more memory than Relay can spare. Each image is
// made, then rendered by the real render worker, in a process of its own that reports its memory:
//   1. images built to exhaust memory or time (a 25,000,000-pixel-wide 16-bit PNG, a 50 MP 4:4:4
//      progressive JPEG, a JPEG with 2,000 scans, large GIF and AVIF of each kind, and a 16 MP AVIF
//      cropped to 64 × 64) are refused from their headers, quickly and cheaply;
//   2. the most costly images still previewed in each format render within the memory budget and
//      Relay's time limit.
// HEIC needs an encoder this script doesn't have; pass HEIC files (or any others) to measure them too.
// Memory is counted differently on macOS; run it in the Docker image for the figures that matter:
//   docker run --rm --network none --memory 768m -v "$PWD/scripts:/app/scripts:ro" \
//     -v "$PWD/server:/app/server:ro" <relay image> node scripts/verify-thumbnails.ts --dir /tmp
//
// Usage: npm run verify:thumbnails -- [--budget 420MiB] [--dir <parent>] [--keep] [files...]
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { crc32, createDeflate } from "node:zlib";
import sharp from "sharp";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    budget: { type: "string", default: "420MiB" },
    dir: { type: "string", default: tmpdir() },
    keep: { type: "boolean", default: false },
    make: { type: "string" },
    render: { type: "string" },
  },
});
const mib = (bytes: number) => Math.round(bytes / 1024 ** 2);

/** Deflated zeros, fed in slices so hundreds of megabytes of them never sit in memory at once. */
async function deflateZeros(length: number) {
  const slice = Buffer.alloc(16 * 1024 ** 2);
  function* zeros() {
    for (let left = length; left > 0; left -= slice.length) yield slice.subarray(0, Math.min(left, slice.length));
  }
  const parts: Buffer[] = [];
  await pipeline(zeros(), createDeflate({ level: 9 }), async (deflated: AsyncIterable<Buffer>) => {
    for await (const part of deflated) parts.push(part);
  });
  return Buffer.concat(parts);
}

/** A PNG of zero pixels written directly, so shapes no encoder would make take no time to build. */
async function png(width: number, height: number, depth: 8 | 16, channels: 3 | 4, interlace = false) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const frame = Buffer.alloc(4 + body.length + 4);
    frame.writeUInt32BE(data.length, 0);
    body.copy(frame, 4);
    frame.writeUInt32BE(crc32(body) >>> 0, 4 + body.length);
    return frame;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = channels === 4 ? 6 : 2;
  header[12] = interlace ? 1 : 0;
  // Enough zero rows for every pass; a decoder stops when it has what it needs.
  const pixels = await deflateZeros((1 + width * channels * (depth / 8)) * height * (interlace ? 2 : 1));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const flat = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp({
    create: { width, height, channels, background: { r: 30, g: 120, b: 200, alpha: 0.5 } },
    limitInputPixels: false,
  });
const noisy = (width: number, height: number, sigma = 40) =>
  sharp({
    create: { width, height, channels: 3, background: "#000", noise: { type: "gaussian", mean: 128, sigma } },
    limitInputPixels: false,
  });

/** A progressive JPEG with its last scan repeated, as many times as asked. */
async function rescanned(copies: number) {
  const jpeg = await flat(4000, 4000).jpeg({ progressive: true }).toBuffer();
  const scan = jpeg.lastIndexOf(Buffer.from([0xff, 0xda]));
  const end = jpeg.length - 2;
  return Buffer.concat([
    jpeg.subarray(0, end),
    ...Array<Buffer>(copies).fill(jpeg.subarray(scan, end)),
    jpeg.subarray(end),
  ]);
}

/**
 * An AVIF from sharp with a crop (`clap`) added to its image, so it reports the cropped size while
 * its whole frame is decoded. Built for sharp's layout: one image item, one-byte property indexes.
 */
function withCrop(avif: Buffer, width: number, height: number) {
  const children = (start: number, end: number) => {
    const list: { type: string; start: number; end: number }[] = [];
    for (let i = start; i < end; i += avif.readUInt32BE(i))
      list.push({ type: avif.toString("latin1", i + 4, i + 8), start: i, end: i + avif.readUInt32BE(i) });
    return list;
  };
  const find = (list: ReturnType<typeof children>, type: string) => list.find((box) => box.type === type)!;
  const meta = find(children(0, avif.length), "meta");
  const metaKids = children(meta.start + 12, meta.end);
  const iprp = find(metaKids, "iprp");
  const iprpKids = children(iprp.start + 8, iprp.end);
  const ipma = find(iprpKids, "ipma");
  const properties = children(find(iprpKids, "ipco").start + 8, find(iprpKids, "ipco").end).length;
  // Version 0, one-byte indexes, one item.
  if (avif[ipma.start + 8] || avif[ipma.start + 11] & 1 || avif.readUInt32BE(ipma.start + 12) !== 1)
    throw new Error("unexpected AVIF layout");
  // Clean aperture: the crop's width and height as fractions, centred.
  const clap = Buffer.alloc(40);
  clap.writeUInt32BE(40, 0);
  clap.write("clap", 4, "latin1");
  [width, 1, height, 1, 0, 1, 0, 1].forEach((value, i) => clap.writeUInt32BE(value, 8 + i * 4));
  const box = (head: Buffer, ...parts: Buffer[]) => {
    const whole = Buffer.concat([head, ...parts]);
    whole.writeUInt32BE(whole.length, 0);
    return whole;
  };
  const rebuilt = (kids: ReturnType<typeof children>, replace: (kid: (typeof kids)[number]) => Buffer | null) =>
    kids.map((kid) => replace(kid) ?? avif.subarray(kid.start, kid.end));
  // The one item's association list gains the new property, marked essential.
  const ipmaNew = box(Buffer.from(avif.subarray(ipma.start, ipma.end)), Buffer.from([0x80 | (properties + 1)]));
  ipmaNew[18]++;
  const grown = clap.length + 1;
  const iloc = Buffer.from(avif.subarray(find(metaKids, "iloc").start, find(metaKids, "iloc").end));
  // Every item's data is in mdat, after meta, so each offset moves by what meta grew.
  const version = iloc[8];
  const offsetSize = iloc[12] >> 4;
  const lengthSize = iloc[12] & 15;
  const baseSize = iloc[13] >> 4;
  const indexSize = version ? iloc[13] & 15 : 0;
  let at = 16;
  const shift = (size: number) => {
    if (size === 4) iloc.writeUInt32BE(iloc.readUInt32BE(at) + grown, at);
    if (size === 8) iloc.writeBigUInt64BE(iloc.readBigUInt64BE(at) + BigInt(grown), at);
  };
  if (version > 1) throw new Error("unexpected AVIF layout");
  for (let items = iloc.readUInt16BE(14); items > 0; items--) {
    // Item id, construction method (version 1), data reference.
    at += 2 + (version ? 2 : 0) + 2;
    const based = baseSize && (baseSize === 4 ? iloc.readUInt32BE(at) : Number(iloc.readBigUInt64BE(at)));
    if (based) shift(baseSize);
    at += baseSize;
    let extents = iloc.readUInt16BE(at);
    at += 2;
    for (; extents > 0; extents--) {
      at += indexSize;
      if (!based) shift(offsetSize);
      at += offsetSize + lengthSize;
    }
  }
  const iprpNew = box(
    Buffer.from(avif.subarray(iprp.start, iprp.start + 8)),
    ...rebuilt(iprpKids, (kid) =>
      kid.type === "ipco" ? box(Buffer.from(avif.subarray(kid.start, kid.end)), clap) : kid === ipma ? ipmaNew : null,
    ),
  );
  const metaNew = box(
    Buffer.from(avif.subarray(meta.start, meta.start + 12)),
    ...rebuilt(metaKids, (kid) => (kid === iprp ? iprpNew : kid.type === "iloc" ? iloc : null)),
  );
  return Buffer.concat(rebuilt(children(0, avif.length), (kid) => (kid.type === "meta" ? metaNew : null)));
}

const refused: Record<string, () => Promise<Buffer>> = {
  "png-25000000x2-rgba16.png": () => png(25_000_000, 2, 16, 4),
  "png-interlaced-7071x7071-rgba16.png": () => png(7071, 7071, 16, 4, true),
  "jpeg-progressive-50mp-444.jpg": () =>
    flat(7071, 7071).jpeg({ progressive: true, chromaSubsampling: "4:4:4" }).toBuffer(),
  "jpeg-2000-scans.jpg": () => rescanned(2000),
  "gif-50mp.gif": () => flat(7071, 7071).gif().toBuffer(),
  // An 8-bit 4:2:0 AVIF may be larger than any other kind; just past that, and the other kinds at 12 MP.
  "avif-14mp-8bit.avif": () => flat(4320, 3240).avif({ effort: 0, chromaSubsampling: "4:2:0" }).toBuffer(),
  "avif-12mp-8bit-444.avif": () => flat(4000, 3000).avif({ effort: 0 }).toBuffer(),
  "avif-12mp-10bit.avif": () =>
    flat(4000, 3000).avif({ effort: 0, bitdepth: 10, chromaSubsampling: "4:2:0" }).toBuffer(),
  "avif-12mp-8bit-alpha.avif": () => flat(4000, 3000, 4).avif({ effort: 0, chromaSubsampling: "4:2:0" }).toBuffer(),
  // 16 MP: encoding a larger frame takes more memory than the container has.
  "avif-16mp-cropped-to-64x64.avif": async () =>
    withCrop(await flat(4000, 4000).avif({ effort: 0 }).toBuffer(), 64, 64),
};
const allowed: Record<string, () => Promise<Buffer>> = {
  "jpeg-progressive-34mp-444.jpg": () =>
    noisy(5800, 5800).jpeg({ progressive: true, quality: 60, chromaSubsampling: "4:4:4" }).toBuffer(),
  "png-16384x3051-rgba16.png": () => png(16_384, 3051, 16, 4),
  "png-interlaced-7071x7071-rgba8.png": () => flat(7071, 7071, 4).png({ progressive: true }).toBuffer(),
  "gif-26mp.gif": () => noisy(5100, 5100).gif({ effort: 1, colours: 16 }).toBuffer(),
  "avif-8.6mp-lossless-12bit.avif": () =>
    noisy(3400, 2540, 8).avif({ effort: 0, lossless: true, bitdepth: 12 }).toBuffer(),
  "avif-8.6mp-12bit-alpha.avif": () =>
    noisy(3400, 2540, 8).ensureAlpha(0.5).avif({ effort: 0, quality: 90, bitdepth: 12 }).toBuffer(),
  "avif-13mp-8bit.avif": () =>
    noisy(4192, 3120, 30).avif({ effort: 0, quality: 90, chromaSubsampling: "4:2:0" }).toBuffer(),
};

type Measured = { code: string; message?: string; ms: number; peakMiB: number; renderMiB: number };

/** One render, in this process alone, so the memory it adds is the render's. */
async function renderOne(source: string, dir: string): Promise<Measured> {
  const format = /\.hei[cf]$/i.test(source) ? "heif" : "image";
  const worker = new Worker(new URL("../server/modules/downloads/thumbnail-worker.ts", import.meta.url), {
    // As thumbnails.ts starts its workers.
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 16, stackSizeMb: 4 },
  });
  const peak = () => mib(process.resourceUsage().maxRSS * 1024);
  const job = (id: number, file: string, decoder: string) =>
    new Promise<{ ok: boolean; code?: string; message?: string }>((resolve, reject) => {
      worker.once("error", reject);
      const answered = (message: { id: number; ok: boolean; decoding?: true }) => {
        if (message.id !== id || message.decoding) return;
        worker.off("message", answered);
        resolve(message);
      };
      worker.on("message", answered);
      worker.postMessage({ id, source: file, target: join(dir, `out-${id}.webp`), format: decoder, width: 2048 });
    });
  // A tiny image first, so the worker and its decoders are loaded before the render is measured.
  const warm = join(dir, "warm.png");
  await writeFile(warm, await png(8, 8, 8, 3));
  await job(1, warm, "image");
  const base = peak();
  const started = Date.now();
  const message = await job(2, source, format).catch((error: Error) => ({
    ok: false,
    code: "WORKER_ERROR",
    message: error.message,
  }));
  const ms = Date.now() - started;
  await worker.terminate();
  return {
    ...(message.ok ? { code: "OK" } : { code: message.code ?? "?", message: message.message?.slice(0, 80) }),
    ms,
    peakMiB: peak(),
    renderMiB: peak() - base,
  };
}

if (flags.make) {
  const make = refused[flags.make] ?? allowed[flags.make];
  await writeFile(join(flags.dir, flags.make), await make());
} else if (flags.render) {
  console.log(JSON.stringify(await renderOne(flags.render, flags.dir)));
} else {
  const budget = Number(/^(\d+)MiB$/i.exec(flags.budget)?.[1] ?? NaN);
  if (!budget) throw new Error("--budget must be a size like 420MiB.");
  const work = await mkdtemp(join(flags.dir, "relay-verify-thumbnails-"));
  const failures: string[] = [];
  const self = (...args: string[]) =>
    execFileSync(process.execPath, [import.meta.filename, ...args, "--dir", work], {
      encoding: "utf8",
      timeout: 120_000,
    });

  /** Renders one file in a process of its own. `expect` is the outcome required, if any. */
  const measure = async (file: string, expect: "refused" | "rendered" | null) => {
    const name = file.split("/").pop()!;
    let result: Measured;
    try {
      result = JSON.parse(self("--render", file).trim().split("\n").pop()!) as Measured;
    } catch (error) {
      const signal = (error as { signal?: string }).signal;
      result = { code: `KILLED (${signal ?? "exit"})`, ms: 0, peakMiB: 0, renderMiB: 0 };
    }
    const size = (await stat(file)).size;
    console.log(
      [
        name.padEnd(38),
        `${String(size).padStart(10)} B`,
        result.code.padEnd(26),
        `${String(result.ms).padStart(6)} ms`,
        `${String(result.renderMiB).padStart(4)} MiB for the render`,
        `(${result.peakMiB} MiB peak)`,
      ].join("  "),
    );
    const refusal = result.code === "IMAGE_TOO_COSTLY" || result.code === "HEIF_DIMENSIONS_TOO_LARGE";
    if (expect === "refused" && !refusal)
      failures.push(`${name} was not refused: ${result.code} ${result.message ?? ""}`);
    if (expect === "rendered" && result.code !== "OK")
      failures.push(`${name} did not render: ${result.code} ${result.message ?? ""}`);
    if (result.code.startsWith("KILLED") || result.renderMiB > budget)
      failures.push(`${name} took ${result.renderMiB} MiB to render, over ${budget} MiB`);
    if (refusal && result.ms > 2000) failures.push(`${name} took ${result.ms} ms to refuse`);
    if (result.ms > 15_000) failures.push(`${name} took ${result.ms} ms, past Relay's time limit for a preview`);
  };

  try {
    for (const [group, files, expect] of [
      ["Refused from the header", refused, "refused"],
      ["Most costly still previewed", allowed, "rendered"],
    ] as const) {
      console.log(`\n${group}:`);
      for (const name of Object.keys(files)) {
        self("--make", name);
        await measure(join(work, name), expect);
        if (!flags.keep) await rm(join(work, name));
      }
    }
    if (positionals.length) {
      console.log("\nGiven files:");
      for (const file of positionals) await measure(file, null);
    }
  } finally {
    if (!flags.keep) await rm(work, { recursive: true, force: true });
    else console.log(`\nKept ${work}`);
  }
  if (failures.length) {
    console.error(`\n${failures.length} problem(s):\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log(`\nEvery image was refused or rendered as expected, each render within ${budget} MiB.`);
}
