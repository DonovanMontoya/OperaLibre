import assert from "node:assert/strict";
import test from "node:test";
import {
  fileExtension,
  isSupportedAudioFileName,
  storedMediaExtension,
  storedMediaExtensionChanged
} from "../src/mediaFiles.ts";

test("file extensions are read off the name and lowercased", () => {
  assert.equal(fileExtension("Dune [B002V1OF70].m4b", "mp3"), "m4b");
  assert.equal(fileExtension("TRACK.M4B", "mp3"), "m4b");
  assert.equal(fileExtension("track.m4b?token=abc#t=1", "mp3"), "m4b");
  assert.equal(fileExtension("no-extension", "mp3"), "mp3");
  assert.equal(fileExtension(null, "mp3"), "mp3");
  assert.equal(fileExtension(undefined, "mp3"), "mp3");
});

test("m4b is stored as m4a so iOS can type it", () => {
  // `.m4b` resolves to com.apple.protected-mpeg-4-audio-b, which has no MIME
  // type, so a stored audiobook is served as application/octet-stream.
  assert.equal(storedMediaExtension("m4b"), "m4a");
  assert.equal(storedMediaExtension("M4B"), "m4a");
  assert.ok(storedMediaExtensionChanged("m4b"));
});

test("audiobook files are recognised by name, whatever iOS calls their type", () => {
  // iOS reports no MIME type for a `.m4b`, so the name is all there is to go on.
  assert.ok(isSupportedAudioFileName("Dune [B002V1OF70].m4b"));
  assert.ok(isSupportedAudioFileName("PART 01.M4A"));
  assert.ok(isSupportedAudioFileName("chapter.mp3"));
  assert.ok(!isSupportedAudioFileName("cover.jpg"));
  assert.ok(!isSupportedAudioFileName("book.aax"));
  assert.ok(!isSupportedAudioFileName("no-extension"));
  assert.ok(!isSupportedAudioFileName(null));
});

test("every other audio extension is stored unchanged", () => {
  for (const extension of ["m4a", "mp3", "mp4", "flac", "wav", "ogg", "opus", "aac", "aiff"]) {
    assert.equal(storedMediaExtension(extension), extension);
    assert.ok(!storedMediaExtensionChanged(extension));
  }
});
