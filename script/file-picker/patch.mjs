import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

// 8.1.1 reads modificationDate in getModifiedAtFromUrl, called only by
// handleDocumentPickerResult. Document, photo and video pickers all copy the
// selected files into the app cache first: 3B52.1 covers user-selected files,
// C617.1 their app-container copies. Directory selection/copy/conversion do
// not read timestamps. The SDK sends no data to its vendor.
// https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
// Remove this repair when an audited upstream release packages its own manifest.
export async function patchFilePicker(packageDirectory) {
  const metadata = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  if (metadata.name !== '@capawesome/capacitor-file-picker' || metadata.version !== '8.1.1') {
    throw new Error('Re-audit file-picker privacy usage and packaging before upgrading from 8.1.1');
  }
  const manifest = await readFile(path.join(directory, 'PrivacyInfo.xcprivacy'), 'utf8');
  const manifestPath = path.join(packageDirectory, 'ios/Plugin/PrivacyInfo.xcprivacy');
  const existing = await readFile(manifestPath, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing !== null && existing !== manifest) {
    throw new Error('Review the existing file-picker privacy manifest; refusing to overwrite it');
  }
  const replacements = [
    ['Package.swift', 'path: "ios/Plugin")',
      'path: "ios/Plugin",\n            resources: [.process("PrivacyInfo.xcprivacy")])'],
    ['CapawesomeCapacitorFilePicker.podspec', "  s.ios.deployment_target = '15.0'",
      "  s.resource_bundles = { 'CapawesomeCapacitorFilePickerPrivacy' => ['ios/Plugin/PrivacyInfo.xcprivacy'] }\n  s.ios.deployment_target = '15.0'"],
  ];
  const updates = await Promise.all(replacements.map(async ([file, original, fixed]) => {
    const target = path.join(packageDirectory, file);
    const source = await readFile(target, 'utf8');
    if (source.includes(fixed)) return [target, source];
    if (source.split(original).length !== 2) {
      throw new Error(`Review file-picker privacy packaging: unexpected ${file}`);
    }
    return [target, source.replace(original, fixed)];
  }));
  await writeFile(manifestPath, manifest);
  for (const [target, source] of updates) await writeFile(target, source);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await patchFilePicker(path.resolve(directory, '../../node_modules/@capawesome/capacitor-file-picker'));
}
