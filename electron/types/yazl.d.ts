declare module 'yazl' {
  import type { Readable } from 'node:stream';
  export class ZipFile {
    outputStream: Readable;
    addFile(realPath: string, metadataPath: string, options?: { compress?: boolean }): void;
    addBuffer(buffer: Buffer, metadataPath: string, options?: { compress?: boolean }): void;
    end(options?: { forceZip64Format?: boolean }): void;
  }
}
