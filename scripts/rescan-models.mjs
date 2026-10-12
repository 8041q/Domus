// Ask the running server to import models using its existing ID registry/queue.
const args = process.argv.slice(2);
if (args.length > 1 || args[0] === '--help') {
  console.log('Usage: npm run models:rescan -- [server-url]\nDefault: http://localhost:5173 (preview usually uses http://localhost:4173)');
  process.exit(args[0] === '--help' ? 0 : 1);
}
try {
  const origin = new URL(args[0] ?? 'http://localhost:5173');
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('Use an HTTP or HTTPS server URL.');
  const response = await fetch(new URL('/api/model-catalogue/rescan', origin), { method: 'POST', signal: AbortSignal.timeout(120_000) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`No Domus rescan endpoint at ${origin.origin} (HTTP ${response.status}).`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Server returned HTTP ${response.status}.`);
  if (!Array.isArray(data.products) || !Array.isArray(data.issues)) throw new Error('The server returned an invalid model catalogue.');
  const available = data.products.filter(product => product.available !== false).length;
  console.log(`Model rescan complete: ${available} available, ${data.products.length - available} unavailable, ${data.issues.length} import issue(s). Open planners have been updated.`);
  for (const issue of data.issues) console.error(`${issue.file}: ${issue.message}`);
  if (data.issues.length) process.exitCode = 1;
} catch (error) {
  console.error(`Model rescan failed: ${error.message}\nStart Domus with npm run dev or npm run preview, then retry with its server URL.`);
  process.exitCode = 1;
}
