declare module "heic-decode" {
  type Decoded = {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };
  type MetadataImage = {
    width: number;
    height: number;
    decode(): Promise<Decoded>;
  };
  type ImageCollection = MetadataImage[] & { dispose(): void };
  /** Decodes the primary image of a HEIC/HEIF file to RGBA pixels. */
  const decode: {
    (input: { buffer: Uint8Array }): Promise<Decoded>;
    all(input: { buffer: Uint8Array }): Promise<ImageCollection>;
  };
  export default decode;
}
