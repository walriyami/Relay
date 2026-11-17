import { crc32 } from "./zip";

// A ZIP lists each file's CRC-32. Only an archive needs it, so it's worked out when one is made, not
// as bytes arrive: that would cost every receiver time on every byte, mostly for nothing.

/** The CRC-32 of each of `files`, worked out in a worker where the browser has them. */
export async function crcsOf(files: Blob[]): Promise<number[]> {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./crc.worker.ts", import.meta.url), { type: "module" });
  } catch {
    // No workers here: the page does it, in pieces.
  }
  try {
    const crcs: number[] = [];
    for (const file of files) crcs.push(worker ? await inWorker(worker, file) : await here(file));
    return crcs;
  } finally {
    worker?.terminate();
  }
}

function inWorker(worker: Worker, file: Blob) {
  return new Promise<number>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<{ crc?: number; error?: string }>) =>
      data.crc === undefined ? reject(new Error(data.error ?? "The file couldn’t be read.")) : resolve(data.crc);
    worker.onerror = (event) => {
      event.preventDefault();
      reject(new Error(event.message || "The file couldn’t be read."));
    };
    worker.postMessage(file);
  });
}

async function here(file: Blob) {
  let crc = 0;
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = crc32(value, crc);
  }
}
