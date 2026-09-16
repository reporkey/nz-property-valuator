import { readFileSync, lstatSync, mkdirSync, mkdtempSync, copyFileSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Explicit allowlist: credentials, development files and screenshots never ship.
export const files = [
  'manifest.json', 'addressMatcher.js', 'background.js', 'content.js',
  'panel.css', 'popup.html', 'popup.js',
  'sites/trademe.js', 'sites/oneroof.js', 'sites/realestate.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
].sort();

const manifest = JSON.parse(readFileSync('manifest.json'));
const pkg = JSON.parse(readFileSync('package.json'));
const lock = JSON.parse(readFileSync('package-lock.json'));
const version = manifest.version;
if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version) ||
    version.split('.').some(n => Number(n) > 65535) || !version.split('.').some(Number)) {
  throw new Error('Invalid Chrome extension version');
}
if ([pkg.version, lock.version, lock.packages[''].version].some(v => v !== version)) {
  throw new Error('manifest.json, package.json and package-lock.json versions must match');
}
if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF !== `refs/tags/v${version}`) {
  throw new Error('Release tag must match the manifest version');
}
const referenced = [manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap(s => [...s.js, ...(s.css || [])]),
  ...manifest.web_accessible_resources.flatMap(r => r.resources)];
for (const file of referenced) {
  if (!files.includes(file)) throw new Error(`Manifest resource missing from release allowlist: ${file}`);
}
const stage = mkdtempSync(resolve(tmpdir(), 'nz-valuator-package-'));
const timestamp = new Date('2020-01-01T00:00:00Z');
for (const file of files) {
  if (!lstatSync(file).isFile()) throw new Error(`Release input must be a regular file: ${file}`);
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file]);
  mkdirSync(dirname(resolve(stage, file)), { recursive: true });
  copyFileSync(file, resolve(stage, file));
  utimesSync(resolve(stage, file), timestamp, timestamp);
}
const filename = `nz-property-valuator-${version}.zip`;
// Always create a new archive; updating an old ZIP could preserve stale entries.
execFileSync('zip', ['-X', '-q', resolve(stage, filename), ...files], { cwd: stage, env: { ...process.env, TZ: 'UTC' } });
execFileSync('unzip', ['-t', resolve(stage, filename)]);
const entries = execFileSync('unzip', ['-Z1', resolve(stage, filename)], { encoding: 'utf8' }).trim().split('\n').sort();
if (JSON.stringify(entries) !== JSON.stringify(files)) throw new Error('Unexpected ZIP contents');
mkdirSync('dist', { recursive: true });
copyFileSync(resolve(stage, filename), resolve('dist', filename));
const hash = createHash('sha256').update(readFileSync(resolve('dist', filename))).digest('hex');
writeFileSync(resolve('dist', `${filename}.sha256`), `${hash}  ${filename}\n`);
console.log(`Packaged ${filename}: ${files.length} files, SHA256 ${hash}`);
