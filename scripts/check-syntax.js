#!/usr/bin/env node
// Syntax-checks every .js file under src/ using `node --check`.
// Used by `npm run check` and CI — catches broken syntax before it merges.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'src');

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectJsFiles(full));
    } else if (entry.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const files = collectJsFiles(ROOT);
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✗ ${file}`);
    console.error(e.stderr?.toString() || e.message);
  }
}

console.log(`\nSyntax check: ${files.length - failed}/${files.length} files OK`);

if (failed > 0) {
  console.error(`${failed} file(s) failed syntax check.`);
  process.exit(1);
}
