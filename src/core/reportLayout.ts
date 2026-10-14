import { setCanvasFont } from './reportFonts';

/** Word wrapping with a character fallback for long, unbroken identifiers. */
export function wrapReportText(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, width: number): string[] {
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      if (line && ctx.measureText(`${line} ${word}`).width <= width) { line += ` ${word}`; continue; }
      if (line) { result.push(line); line = ''; }
      for (const character of word) {
        if (line && ctx.measureText(line + character).width > width) { result.push(line); line = ''; }
        line += character;
      }
    }
    result.push(line);
  }
  return result;
}

export function reportFont(ctx: CanvasRenderingContext2D, size = 24, bold = false) {
  setCanvasFont(ctx, size, bold ? 500 : 400, bold); ctx.fillStyle = '#27272a';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
}

export function reportHeading(ctx: CanvasRenderingContext2D, roomName: string, subtitle: string) {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1800, 1273);
  reportFont(ctx, 34, true);
  let title = roomName;
  while (title && ctx.measureText(title + (title === roomName ? '' : '…')).width > 1660) title = title.slice(0, -1);
  ctx.fillText(title + (title === roomName ? '' : '…'), 70, 42);
  reportFont(ctx, 24); ctx.fillStyle = '#71717a'; ctx.fillText(subtitle, 70, 98);
}

export function reportFooter(ctx: CanvasRenderingContext2D, date: string, page: number, total: number) {
  reportFont(ctx, 20); ctx.fillStyle = '#71717a'; ctx.fillText(`Domus · Exported ${date}`, 70, 1200);
  ctx.textAlign = 'right'; ctx.fillText(`${page} / ${total}`, 1730, 1200);
}

export class ReportDocument {
  readonly pages: HTMLCanvasElement[] = [];
  private ctx!: CanvasRenderingContext2D;
  private y = 0;
  private readonly bottom = 1145;
  constructor(private roomName: string, private createCanvas = () => document.createElement('canvas')) { this.newPage(); }
  private newPage() {
    const canvas = this.createCanvas(); canvas.width = 1800; canvas.height = 1273;
    this.pages.push(canvas); this.ctx = canvas.getContext('2d')!;
    reportHeading(this.ctx, this.roomName, this.pages.length === 1 ? 'Room summary' : 'Room details · continued'); this.y = 165;
  }
  private space(height: number) { if (this.y + height > this.bottom) this.newPage(); }
  section(title: string, firstBlockHeight = 65) {
    this.space(56 + firstBlockHeight); reportFont(this.ctx, 28, true); this.ctx.fillText(title, 70, this.y); this.y += 56;
  }
  field(label: string, value: string) {
    reportFont(this.ctx); const lines = wrapReportText(this.ctx, value, 1240);
    const height = lines.length * 32 + 18; this.space(height);
    reportFont(this.ctx, 23, true); this.ctx.fillText(label, 70, this.y);
    reportFont(this.ctx); lines.forEach((line, i) => this.ctx.fillText(line, 460, this.y + i * 32)); this.y += height;
  }
  paragraph(text: string) {
    reportFont(this.ctx, 23);
    for (const line of wrapReportText(this.ctx, text, 1660)) {
      this.space(32); reportFont(this.ctx, 23); this.ctx.fillText(line, 70, this.y); this.y += 32;
    }
    this.y += 18;
  }
  table(title: string, headers: string[], widths: number[], rows: string[][]) {
    if (widths.reduce((sum, width) => sum + width, 0) !== 1660 || headers.length !== widths.length) throw new Error('Invalid report table columns.');
    const prepare = (cells: string[], bold = false) => {
      reportFont(this.ctx, 23, bold);
      const lines = cells.map((cell, i) => wrapReportText(this.ctx, cell, widths[i] - 32));
      return { lines, height: Math.max(...lines.map((cell) => cell.length)) * 31 + 28 };
    };
    const preparedRows = rows.map(cells => prepare(cells));
    const heading = prepare(headers, true), first = preparedRows[0] ?? { height: 0 };
    const total = heading.height + preparedRows.reduce((sum, row) => sum + row.height, 0);
    // Small schedules should remain a single block rather than leaving one row
    // on the next page. Long schedules still paginate with repeated headers.
    const keepTogether = rows.length <= 6 && 56 + total + 24 <= this.bottom - 165;
    this.section(title, keepTogether ? total + 24 : heading.height + first.height);
    const draw = (row: ReturnType<typeof prepare>, fill: string, bold: boolean) => {
      let x = 70; const top = this.y;
      this.ctx.fillStyle = fill; this.ctx.fillRect(x, top, 1660, row.height);
      reportFont(this.ctx, 23, bold); this.ctx.strokeStyle = '#dedee3'; this.ctx.lineWidth = 1;
      row.lines.forEach((lines, i) => {
        this.ctx.strokeRect(x, top, widths[i], row.height);
        lines.forEach((line, j) => this.ctx.fillText(line, x + 16, top + 14 + j * 31)); x += widths[i];
      });
      this.y += row.height;
    };
    draw(heading, '#e9e9ee', true);
    preparedRows.forEach((row, index) => {
      if (this.y + row.height > this.bottom) { this.newPage(); this.section(`${title} · continued`, heading.height + row.height); draw(heading, '#e9e9ee', true); }
      draw(row, index % 2 === 0 ? '#ffffff' : '#f5f5f8', false);
    });
    this.y += 24;
  }
}
