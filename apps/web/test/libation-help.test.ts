import assert from "node:assert/strict";
import test from "node:test";
import { libationHelp, validAudibleResponse } from "../src/libationHelp.ts";

test("import failures give the correct recovery action without echoing server paths", () => {
  assert.match(libationHelp("No region is associated with the Invariant Culture"), /ICU/);
  assert.match(libationHelp("insufficient free space to preserve min_download_free_gib"), /Free up space/);
  assert.match(libationHelp("title exceeds max_upload_gib"), /size limit/);
  assert.match(libationHelp("Cannot find settings files at /private/example"), /libation_files_dir/);
  assert.doesNotMatch(libationHelp("Cannot find settings files at /private/example"), /private/);
  assert.match(libationHelp("Sign-in session expired"), /Start a new sign-in/);
  assert.match(libationHelp("Authentication failed"), /Reconnect/);
});

test("sign-in accepts marketplace URLs and rejects control characters and lookalike hosts", () => {
  for (const suffix of ["com", "co.uk", "ca", "de", "fr", "com.au", "co.jp", "in", "es"]) {
    assert.equal(validAudibleResponse(`https://www.amazon.${suffix}/ap/maplanding?code=fixture`), true);
  }
  for (const value of ["http://www.amazon.com/ap/maplanding", "https://amazon.com.example.test/", "https://example.test/", "javascript:alert(1)", "https://www.amazon.com/ap/maplanding\nscan"]) {
    assert.equal(validAudibleResponse(value), false, value);
  }
});
