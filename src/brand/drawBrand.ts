import mark from './mark.json';

/** The report uses the same geometry as the generated SVGs, without image fetches. */
export function drawBrandMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save();
  const polygon = (points: number[][], colour: string, rounded = false) => {
    ctx.beginPath();
    points.forEach(([px, py], index) => {
      const dx = x + px * size / 256, dy = y + py * size / 256;
      if (index) ctx.lineTo(dx, dy); else ctx.moveTo(dx, dy);
    });
    ctx.closePath(); ctx.fillStyle = colour; ctx.fill();
    if (rounded) {
      ctx.strokeStyle = colour; ctx.lineWidth = 5 * size / 256; ctx.lineJoin = 'round'; ctx.stroke();
    }
  };
  polygon(mark.outline, mark.ink, true);
  polygon(mark.left, mark.paper);
  mark.panes.forEach(points => polygon(points, mark.paper));
  ctx.restore();
}
