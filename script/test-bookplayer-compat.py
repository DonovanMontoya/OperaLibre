#!/usr/bin/env python3
"""Compile BookPlayer's unchanged response models and test an isolated server.

On macOS, clone https://github.com/TortugaPower/BookPlayer and run:
BOOKPLAYER_CHECKOUT=/path/to/BookPlayer cargo test --locked \
  --manifest-path apps/server/Cargo.toml bookplayer_live_contract -- --ignored --nocapture

Invoked by that Rust test, not against a personal server: the harness uses the
fixture owner and changes its progress before logging out. No app dependencies,
Keychain, signing identity, personal library, or BookPlayer account are needed.
This verifies Swift decoding and HTTP contracts, not the iOS app UI/playback.
"""
import pathlib
import subprocess
import sys
import tempfile

checkout = pathlib.Path(sys.argv[1])
base = sys.argv[2]
root = checkout / "BookPlayer/AudiobookShelf"
items = (root / "Library Screen/AudiobookShelfLibraryItem.swift").read_text()
# Extract entire upstream declarations without rewriting their fields/decoders.
series = items[items.index("struct AudiobookShelfSeriesReference:"):items.index("struct AudiobookShelfLibraryItem:")]
models = items[items.index("struct AudiobookShelfAPIItem:"):]
details = (root / "Library Screen/Details/AudiobookShelfAudiobookDetailsData.swift").read_text()
details = details[details.index("struct AudiobookShelfItemDetailsResponse:"):details.index("extension AudiobookShelfAudiobookDetailsData")]
libraries = (root / "Network/AudiobookShelfLibrary.swift").read_text()
runner = pathlib.Path(__file__).with_suffix(".swift").read_text()
with tempfile.TemporaryDirectory(prefix="bookplayer-contract-") as temp:
    source = pathlib.Path(temp) / "main.swift"
    source.write_text("import Foundation\n" + series + models + details + libraries + runner)
    result = subprocess.run(["swift", str(source), base], check=False)
    sys.exit(result.returncode)
