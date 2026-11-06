import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import opentype from 'three/examples/jsm/libs/opentype.module.js';

const mark = JSON.parse(await readFile(new URL('../src/brand/mark.json', import.meta.url), 'utf8'));
const output = new URL('../public/brand/', import.meta.url);
await mkdir(output, { recursive: true });
const fontBytes = await readFile(new URL('../src/assets/fonts/ibm-plex-sans/semibold.ttf', import.meta.url));
const font = opentype.parse(fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength));
const text = (value, x, baseline, size, colour) => `<path fill="${colour}" d="${font.getPath(value, x, baseline, size).toPathData(3)}"/>`;
const polygon = (points, fill, rounded = false) => `<polygon points="${points.map(p => p.join(',')).join(' ')}" fill="${fill}"${rounded ? ` stroke="${fill}" stroke-width="5" stroke-linejoin="round"` : ''}/>`;
function symbol({ ink = mark.ink, paper = mark.paper, micro = false } = {}) {
  return polygon(mark.outline, ink, true) + polygon(mark.left, paper) +
    (micro ? [mark.microWindow] : mark.panes).map(points => polygon(points, paper)).join('');
}
const svg = (width, height, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>\n`;
const icon = ({ rounded = true, maskable = false, micro = false } = {}) => svg(256, 256,
  `<rect width="256" height="256" rx="${rounded ? 56 : 0}" fill="${mark.yellow}"/>` +
  `<g transform="translate(128 128) scale(${maskable ? .66 : .82}) translate(-128 -128)">${symbol({ micro })}</g>`);
const monoSymbol = ink => `<mask id="cut"><rect width="256" height="256" fill="white"/>${polygon(mark.left, 'black')}${mark.panes.map(p => polygon(p, 'black')).join('')}</mask><g mask="url(#cut)">${polygon(mark.outline, ink, true)}</g>`;
const wordmark = (dark = false) => svg(960, 256,
  `<g transform="translate(0 16) scale(.875)">${dark ? monoSymbol(mark.paper) : symbol()}</g>` +
  text('Domus', 260, 177, 148, dark ? mark.paper : mark.ink));
const social = svg(1200, 630, `<rect width="1200" height="630" fill="#f5f5f7"/>` +
  `<rect x="64" y="64" width="1072" height="502" rx="40" fill="${mark.yellow}"/>` +
  `<g transform="translate(104 155) scale(1.25)">${symbol()}</g>` +
  text('Domus', 460, 337, 132, mark.ink) + text('Room planner', 467, 404, 36, mark.ink));

const vectors = {
  'logo-mark.svg': svg(256, 256, symbol()),
  // Cutout monochrome versions stay transparent on any background.
  'logo-mono-dark.svg': svg(256, 256, monoSymbol(mark.ink)),
  'logo-mono-light.svg': svg(256, 256, monoSymbol(mark.paper)),
  'app-icon.svg': icon(),
  'favicon.svg': icon({ micro: true }),
  'wordmark.svg': wordmark(),
  'wordmark-light.svg': wordmark(true),
  'social-card.svg': social,
};
for (const [name, content] of Object.entries(vectors)) await writeFile(new URL(name, output), content);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (name, content, width, height = width) => {
    await page.setViewportSize({ width, height });
    await page.setContent(`<html><body style="margin:0;background:transparent">${content.replace(/width="\d+" height="\d+"/, `width="${width}" height="${height}"`)}</body></html>`);
    return page.screenshot({ path: new URL(name, output).pathname, omitBackground: true });
  };
  for (const size of [16, 32, 48, 180, 192, 512, 1024]) {
    await render(size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`, icon({ rounded: size !== 180, micro: size === 16 }), size);
  }
  for (const size of [192, 512]) await render(`icon-maskable-${size}.png`, icon({ rounded: false, maskable: true }), size);
  for (const name of ['logo-mark', 'logo-mono-dark', 'logo-mono-light']) await render(`${name}.png`, vectors[`${name}.svg`], 1024);
  for (const name of ['wordmark', 'wordmark-light']) await render(`${name}.png`, vectors[`${name}.svg`], 960, 256);
  await render('social-card.png', social, 1200, 630);

  // ICO embeds real PNG images at each size; old clients can choose their native size.
  const sizes = [16, 32, 48], images = await Promise.all(sizes.map(size => readFile(new URL(`icon-${size}.png`, output))));
  const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + i * 16; header[entry] = size; header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += images[i].length;
  });
  await writeFile(new URL('../favicon.ico', output), Buffer.concat([header, ...images]));

  const preview = new URL('../private/branding/', import.meta.url); await mkdir(preview, { recursive: true });
  await page.setViewportSize({ width: 1200, height: 760 });
  const image = name => `data:image/svg+xml;base64,${Buffer.from(vectors[name]).toString('base64')}`;
  await page.setContent(`<html><style>body{margin:0;padding:48px;background:#f5f5f7;font-family:system-ui;color:#20201e}h1{font-size:16px;margin:0 0 32px}main{display:grid;grid-template-columns:1fr 1fr;gap:24px}.card{border-radius:24px;background:white;padding:32px;height:240px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:24px}.dark{background:#18181b}.tile{background:#facc15}.sizes{height:120px;align-items:center;justify-content:flex-start}.sizes span{font-size:12px;color:#71717a;display:grid;justify-items:center;gap:10px}</style><h1>DOMUS / Logo & icon family</h1><main><div class="card"><img width="440" src="${image('wordmark.svg')}"></div><div class="card dark"><img width="440" src="${image('wordmark-light.svg')}"></div><div class="card tile"><img width="190" src="${image('logo-mark.svg')}"></div><div class="card"><img width="150" src="${image('app-icon.svg')}"><img width="100" src="${image('logo-mono-dark.svg')}"><span style="background:#18181b;padding:12px;border-radius:16px"><img width="72" src="${image('logo-mono-light.svg')}"></span></div><div class="card sizes" style="grid-column:span 2">${[16,32,48,64].map(size => `<span><img width="${size}" height="${size}" src="${image(size === 16 ? 'favicon.svg' : 'app-icon.svg')}">${size}px</span>`).join('')}<span style="margin-left:auto;font-size:14px">Yellow #FACC15 · Charcoal #20201E · White #FFFFFF</span></div></main>`);
  await page.screenshot({ path: new URL('brand-preview.png', preview).pathname });
} finally { await browser.close(); }
console.log('Generated Domus brand assets in public/brand, favicon.ico, and private/branding/brand-preview.png.');
