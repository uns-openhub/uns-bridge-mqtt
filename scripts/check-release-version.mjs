import { readFile } from 'node:fs/promises';

const tag = process.argv.slice(2).find((argument) => argument !== '--') ?? process.env.GITHUB_REF_NAME;
if (!tag) {
  throw new Error('Provide a release tag, for example: pnpm run check-release-version -- v2.0.0');
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (tag.replace(/^v/, '') !== packageJson.version) {
  throw new Error(`Release tag '${tag}' does not match package.json.version '${packageJson.version}'.`);
}
if (packageJson.unsDatahub?.kind !== 'addon' || typeof packageJson.unsDatahub.controllerCompatibility !== 'string') {
  throw new Error('package.json.unsDatahub must declare an add-on controller compatibility range.');
}

console.log(`Release metadata is valid for '${tag}'.`);
