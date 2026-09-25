// 类型检查用的本地桩（真实运行时由 docx / pdf-lib 提供）
declare module 'docx' {
  export class Document {
    constructor(opts: unknown)
  }
  export class Packer {
    static toBuffer(doc: Document | unknown): Promise<Buffer>
  }
  export class Paragraph {
    constructor(opts: unknown)
  }
  export class TextRun {
    constructor(opts: unknown)
  }
  export class Footer {
    constructor(opts: unknown)
  }
  export class Header {
    constructor(opts: unknown)
  }
  export class Table {
    constructor(opts: unknown)
  }
  export class TableRow {
    constructor(opts: unknown)
  }
  export class TableCell {
    constructor(opts: unknown)
  }
  export class ImageRun {
    constructor(opts: unknown)
  }
  export class PageBreak {}
  export class PageNumber {
    static CURRENT: unknown
    static TOTAL_PAGES: unknown
  }
  export const HeadingLevel: Record<string, unknown>
  export const AlignmentType: Record<string, string>
  export const BorderStyle: Record<string, string>
  export const WidthType: Record<string, string>
  export const ShadingType: Record<string, string>
  export const TextDirection: Record<string, string>
}

declare module 'pdf-lib' {
  export interface PDFPage {
    getSize(): { width: number; height: number }
    drawText(text: string, opts?: unknown): void
    drawImage(img: unknown, opts?: unknown): void
    drawRectangle(opts?: unknown): void
  }
  export class PDFDocument {
    static create(): Promise<PDFDocument>
    static load(bytes: Uint8Array | ArrayBuffer): Promise<PDFDocument>
    getPageCount(): number
    getPages(): PDFPage[]
    addPage(size?: [number, number] | Record<string, number>): PDFPage
    embedPng(bytes: Uint8Array | ArrayBuffer): Promise<unknown>
    embedJpg(bytes: Uint8Array | ArrayBuffer): Promise<unknown>
    embedFont(font?: unknown): Promise<unknown>
    copyPages(src: PDFDocument, indices: number[]): Promise<PDFPage[]>
    addPage(page: PDFPage): void
    save(): Promise<Uint8Array>
  }
  export const rgb: (r: number, g: number, b: number) => unknown
  export const degrees: (n: number) => unknown
  export const StandardFonts: Record<string, string>
  export function setFont(font: unknown): void
}

declare module 'multer' {
  export function memoryStorage(): unknown
  export function diskStorage(opts: unknown): unknown
  function multer(opts?: unknown): unknown
  export default multer
  export interface Multer {
    File: unknown
  }
}
