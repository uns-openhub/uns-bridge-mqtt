import { readFile } from 'node:fs/promises';

const ref = process.env.GITHUB_REF_NAME ?? '';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expectedTag = packageJson.version;

if (ref !== expectedTag) {
  throw new Error(`Release tag ${ref} does not match package version ${packageJson.version}.`);
}

console.log(`Release tag ${ref} matches package version ${packageJson.version}.`);
