import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyVisualContract(body, paths, root) {
  const contract = /^## Визуальный контракт[^\S\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/mu.exec(body)?.[1];
  if (!contract) return;
  const routes = [...contract.matchAll(/`(\/[\w/-]*)`/gu)].map(m => m[1]);
  const sizes = [...contract.matchAll(/(\d+)\s*[×x]\s*(\d+)/gu)].map(m => m[1] + 'x' + m[2]);
  if (!routes.length || !sizes.length) return;
  const required = new Set(routes.flatMap(route => sizes.map(size => route + ' ' + size)));
  for (const file of paths.filter(p => /^evidence\/[\w-]+\/route-evidence[.]json$/u.test(p))) {
    const receipt = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    for (const [size, hash] of Object.entries(receipt.images)) {
      if (!/^\d+x\d+$/u.test(size)) throw new Error('Invalid evidence size');
      const png = readFileSync(resolve(root, dirname(file), 'implementation-' + size + '.png'));
      if (createHash('sha256').update(png).digest('hex') !== hash) throw new Error('Screenshot changed: ' + file);
      required.delete(receipt.route + ' ' + size);
    }
  }
  if (required.size) throw new Error('Capture the issue route before review: ' + [...required].join(', '));
}

export function routeImages(report, route, sizes) {
  if (!route?.startsWith('/') || route.startsWith('//') || !sizes.length ||
      sizes.some(size => !/^[1-9]\d*x[1-9]\d*$/.test(size)) || new Set(sizes).size !== sizes.length)
    throw new Error('Specify the issue route and distinct WIDTHxHEIGHT sizes.');
  if (!report.stats?.expected || report.stats.unexpected || report.stats.flaky || report.errors?.length)
    throw new Error('A successful Playwright JSON report is required.');
  const images = new Map();
  function visit(suite) {
    for (const child of suite.suites ?? []) visit(child);
    for (const spec of suite.specs ?? []) for (const test of spec.tests) {
      const result = test.results.at(-1);
      if (test.status !== 'expected' || result?.status !== 'passed') continue;
      for (const item of result.attachments ?? []) {
        if (!item.name.startsWith('ralph-route:')) continue;
        const meta = JSON.parse(item.name.slice('ralph-route:'.length));
        const size = meta.width + 'x' + meta.height;
        if (meta.route !== route || !sizes.includes(size) || images.has(size))
          throw new Error('Unexpected or duplicate screenshot: ' + meta.route + ' ' + size);
        const data = Buffer.from(item.body ?? '', 'base64');
        if (item.contentType !== 'image/png' || data.length < 33 ||
            data.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' ||
            data.readUInt32BE(16) !== meta.width || data.readUInt32BE(20) !== meta.height)
          throw new Error('Invalid PNG or viewport: ' + size);
        images.set(size, data);
      }
    }
  }
  visit(report);
  if (images.size !== sizes.length) throw new Error('Missing required route screenshots.');
  return images;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [reportFile, run, route, ...sizes] = process.argv.slice(2);
  if (process.env.RALPH_VALIDATION_SCOPE || !/^[a-z0-9][a-z0-9-]*$/.test(run ?? ''))
    throw new Error('Publish separately after validation, using a new evidence directory.');
  const images = routeImages(JSON.parse(readFileSync(reportFile, 'utf8')), route, sizes);
  const root = resolve(import.meta.dirname, '../../evidence');
  const dest = join(root, run);
  if (existsSync(dest)) throw new Error('Evidence already exists: ' + dest);
  mkdirSync(root, { recursive: true });
  const stage = mkdtempSync(join(root, '.capture-'));
  try {
    for (const [size, bytes] of images) writeFileSync(join(stage, 'implementation-' + size + '.png'), bytes);
    const hashes = Object.fromEntries([...images].map(([size, bytes]) => [size, createHash('sha256').update(bytes).digest('hex')]));
    writeFileSync(join(stage, 'route-evidence.json'), JSON.stringify({route, images: hashes}, null, 2) + '\n');
    writeFileSync(join(stage, 'README.md'), '# ' + run + '\n\nМаршрут: `' + route + '`\n\n' +
      sizes.map(size => '- [' + size + '](implementation-' + size + '.png)').join('\n') + '\n');
    renameSync(stage, dest);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}


export function writesEvidence(source) {
  return /(?:path\s*:|(?:writeFile(?:Sync)?|copyFile(?:Sync)?)\s*\()[^;{}\n]{0,160}?(?:^|[/'"`])evidence[\\/]/mu.test(source);
}
