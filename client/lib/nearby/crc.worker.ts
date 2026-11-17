import { crc32 } from "./zip";

// Works out a received file's CRC-32 away from the page, so a large one doesn't freeze it.

self.onmessage = async ({ data: file }: MessageEvent<Blob>) => {
  try {
    let crc = 0;
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = crc32(value, crc);
    }
    self.postMessage({ crc });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
