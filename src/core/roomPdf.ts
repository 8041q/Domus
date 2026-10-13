export const ROOM_PDF_VIEWS = ['top', 'front', 'right', 'back', 'left'] as const;
export interface PdfSnapshot { jpeg: Uint8Array; width: number; height: number }

/** A self-contained room report with embedded JPEG pages, no network dependency. */
export function buildRoomPdf(snapshots: PdfSnapshot[], reportPages: PdfSnapshot[] = []): Uint8Array {
  if (snapshots.length !== ROOM_PDF_VIEWS.length) throw new Error('All five room views are required.');
  const pages = [...reportPages, ...snapshots];
  const encode = (text: string) => new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const offsets = [0];
  const append = (chunk: string | Uint8Array) => { const bytes = typeof chunk === 'string' ? encode(chunk) : chunk; chunks.push(bytes); length += bytes.length; };
  const object = (id: number, text: string, stream?: Uint8Array) => {
    offsets[id] = length;
    append(`${id} 0 obj\n${text}`);
    if (stream) { append('\nstream\n'); append(stream); append('\nendstream'); }
    append('\nendobj\n');
  };
  append('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`);
  pages.forEach((snapshot, i) => {
    if (!snapshot.width || !snapshot.height || snapshot.jpeg[0] !== 0xff || snapshot.jpeg[1] !== 0xd8) throw new Error('Invalid room snapshot.');
    const page = 3 + i * 3;
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.89 595.28] /Resources << /XObject << /View ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`);
    const content = encode('q 841.89 0 0 595.28 0 0 cm /View Do Q');
    object(page + 1, `<< /Length ${content.length} >>`, content);
    object(page + 2, `<< /Type /XObject /Subtype /Image /Width ${snapshot.width} /Height ${snapshot.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${snapshot.jpeg.length} >>`, snapshot.jpeg);
  });
  const start = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach((offset) => append(`${String(offset).padStart(10, '0')} 00000 n \n`));
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
  const result = new Uint8Array(length);
  let cursor = 0;
  chunks.forEach((chunk) => { result.set(chunk, cursor); cursor += chunk.length; });
  return result;
}

export function jpegBytes(canvas: HTMLCanvasElement): Uint8Array {
  const binary = atob(canvas.toDataURL('image/jpeg', 0.94).split(',')[1]);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
