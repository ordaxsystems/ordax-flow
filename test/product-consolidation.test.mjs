import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

// The retired standalone product must not become a hidden runtime dependency.
test('desktop and Flow entrypoints never depend on ordax-gpt packages or executors', () => {
  const paths = [
    'package.json',
    'desktop/main.mjs',
    'desktop/embedded-worker.mjs',
    'src/store.mjs',
    'src/continuation-context.mjs',
    'src/relay/relay.mjs',
    'apps/flow-client/app.mjs',
    'apps/flow-hub/app.mjs'
  ];
  for (const rel of paths) {
    assert.doesNotMatch(
      read(rel),
      /@ordax-gpt(?:\\/|\\b)|ordaxsystems\\/ordax-gpt|ordax-gpt\\/(?:apps|packages)/,
      rel + ' must use this repo\'s owned contracts, not a parallel GPT engine'
    );
  }
});

test('existing Gratis installation identity and local state path stay stable until a tested migration', () => {
  const pkg = JSON.parse(read('package.json'));
  const main = read('desktop/main.mjs');
  assert.equal(pkg.build.appId, 'br.com.ordax.gratis');
  assert.match(main, /const userRoot = path\\.join\\(localAppData, 'OrdaX', 'Gratis'\\)/);
  assert.match(main, /new Store\\(path\\.join\\(dataRoot, 'ordax-gratis\\.sqlite'\\)\\)/);
});
