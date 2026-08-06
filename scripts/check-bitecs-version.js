#!/usr/bin/env node
// Devoxel loads bitecs straight from a CDN (esm.sh) in 4+ separate files
// instead of via node_modules, since the project has zero build step.
// That means there is no lockfile to keep the version consistent — this
// script is the substitute: it greps every `esm.sh/bitecs@X.Y.Z` import
// and fails if any of them drift from each other or from the version
// declared in package.json's `cdnDependencies.bitecs`.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const expected = pkg.cdnDependencies?.bitecs;

if (!expected) {
  console.error('package.json is missing `cdnDependencies.bitecs` — nothing to check against.');
  process.exit(1);
}

const grepOutput = execSync(`grep -rn "esm.sh/bitecs@" src/ || true`, { cwd: ROOT, encoding: 'utf8' });

const lines = grepOutput.trim().split('\n').filter(Boolean);
const versionRe = /bitecs@([^'";]+)/;
let mismatches = 0;

for (const line of lines) {
  const match = line.match(versionRe);
  if (!match) continue;
  const [file] = line.split(':');
  const version = match[1];
  if (version !== expected) {
    mismatches++;
    console.error(`✗ ${file} pins bitecs@${version}, expected @${expected} (from package.json)`);
  }
}

console.log(`\nChecked ${lines.length} import site(s) against declared version ${expected}.`);

if (mismatches > 0) {
  console.error(`${mismatches} import(s) out of sync. Update them to @${expected}, or bump package.json.`);
  process.exit(1);
}

console.log('All bitecs CDN imports are consistent.');
