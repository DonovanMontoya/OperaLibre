import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { patchFilePicker } from './patch.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'file-picker-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'ios/Plugin'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@capawesome/capacitor-file-picker', version: '8.1.1' }));
  await writeFile(path.join(root, 'Package.swift'), 'path: "ios/Plugin")');
  await writeFile(path.join(root, 'CapawesomeCapacitorFilePicker.podspec'), "  s.ios.deployment_target = '15.0'");
  return root;
}

test('packages one SDK manifest for SPM and CocoaPods and is idempotent', async t => {
  const root = await fixture(t);
  await patchFilePicker(root);
  const files = ['Package.swift', 'CapawesomeCapacitorFilePicker.podspec', 'ios/Plugin/PrivacyInfo.xcprivacy'];
  const before = await Promise.all(files.map(file => readFile(path.join(root, file), 'utf8')));
  assert.match(before[0], /resources: \[.process\("PrivacyInfo.xcprivacy"\)\]/);
  assert.match(before[1], /s.resource_bundles = /);
  assert.equal(before[2], await readFile(new URL('./PrivacyInfo.xcprivacy', import.meta.url), 'utf8'));
  await patchFilePicker(root);
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(root, file), 'utf8'))), before);
});

test('requires a fresh audit for dependency upgrades', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@capawesome/capacitor-file-picker', version: '8.2.0' }));
  await assert.rejects(patchFilePicker(root), /Re-audit/);
});

test('preserves an unexpected upstream manifest', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'ios/Plugin/PrivacyInfo.xcprivacy');
  await writeFile(file, 'upstream manifest');
  await assert.rejects(patchFilePicker(root), /refusing to overwrite/);
  assert.equal(await readFile(file, 'utf8'), 'upstream manifest');
});

test('rejects packaging drift before making changes', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'CapawesomeCapacitorFilePicker.podspec'), 'changed packaging');
  await assert.rejects(patchFilePicker(root), /unexpected/);
  assert.equal(await readFile(path.join(root, 'Package.swift'), 'utf8'), 'path: "ios/Plugin")');
  await assert.rejects(readFile(path.join(root, 'ios/Plugin/PrivacyInfo.xcprivacy')), { code: 'ENOENT' });
});
