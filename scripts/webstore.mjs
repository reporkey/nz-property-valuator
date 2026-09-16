import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function deploy({ token, publisher, item, version, archive, statusOnly = false,
  fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!token || !publisher || !item) throw new Error('Chrome Web Store authentication/configuration is missing');
  const resource = `publishers/${encodeURIComponent(publisher)}/items/${encodeURIComponent(item)}`;
  async function request(action, body, upload = false) {
    const response = await fetchImpl(`https://chromewebstore.googleapis.com/${upload ? 'upload/' : ''}v2/${resource}:${action}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': upload ? 'application/zip' : 'application/json' }) },
      body, signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Chrome Web Store ${action} failed (HTTP ${response.status}); check the dashboard and API access`);
    return response.json();
  }
  const status = await request('fetchStatus');
  if (statusOnly) return status;
  // Warnings and takedowns can require a corrected package. Let the store
  // review that submission; its API still enforces publishing restrictions.
  const pending = status.submittedItemRevisionStatus;
  const published = status.publishedItemRevisionStatus;
  const hasVersion = revision => revision?.distributionChannels?.some(c => c.crxVersion === version);
  // A rerun after a successful submission is a read-only success.
  if ((published?.state === 'PUBLISHED' && hasVersion(published)) ||
      (pending?.state === 'PENDING_REVIEW' && hasVersion(pending))) {
    return { state: hasVersion(published) ? published.state : pending.state, version, unchanged: true };
  }
  if (pending && !['REJECTED', 'CANCELLED'].includes(pending.state)) {
    throw new Error('Another submission is active; finish it in the dashboard before releasing');
  }
  const uploaded = await request('upload', archive, true);
  if (uploaded.crxVersion && uploaded.crxVersion !== version) throw new Error('Uploaded version does not match this release');
  let state = uploaded.uploadState;
  for (let i = 0; ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'].includes(state) && i < 24; i++) {
    await sleep(5000);
    state = (await request('fetchStatus')).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') throw new Error(`Package upload did not succeed: ${state}`);
  const result = await request('publish', JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }));
  if (!['PENDING_REVIEW', 'PUBLISHED'].includes(result.state)) {
    throw new Error(`Unexpected submission state: ${result.state}`);
  }
  return { state: result.state, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { version } = JSON.parse(readFileSync('manifest.json'));
    const statusOnly = process.argv.includes('--status');
    const result = await deploy({
      token: process.env.CWS_ACCESS_TOKEN, publisher: process.env.CWS_PUBLISHER_ID,
      item: process.env.CWS_EXTENSION_ID, version, statusOnly,
      archive: statusOnly ? undefined : readFileSync(`dist/nz-property-valuator-${version}.zip`),
    });
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Chrome Web Store result (${version}):\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nPENDING_REVIEW means submitted, not yet live.\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
