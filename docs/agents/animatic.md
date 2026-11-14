# Animatic

The narration, frame renderer, style and stitcher for this repository.

## Flags

Use the flags for the host platform unchanged on `say`, `setup` and `build`.

### macOS

Before changing to the scratch build folder, set the repository path:

```sh
export OPERALIBRE_ANIMATIC_ROOT="$(git rev-parse --show-toplevel)"
```

```sh
--tts-command 'swift "$OPERALIBRE_ANIMATIC_ROOT/script/animatic-voice.swift" {out}.wav'
```

This exports the selected Siri Voice 6 through Apple's speech API. Requires
Swift and the installed voice `com.apple.siri.natural.en-US-G`.
If the voice is unavailable, stop and ask before choosing a replacement.
Do not pass its identifier to `say`: that silently used Samantha during testing.

### Other platforms

Install `edge-tts` on PATH, for example with `uv tool install edge-tts`.

```sh
--tts-command 'edge-tts --voice en-GB-RyanNeural --text {text} --write-media {out}.mp3'
```

## Stages

- **Voice**: Siri Voice 6 on macOS; edge-tts Ryan Neural elsewhere.
- **Renderer**: generated frames on the kit, through Playwright.
- **Style**: the plain kit.
- **Stitcher**: ffmpeg, through `build`.

## Secrets

None. Siri runs locally; edge-tts uses an online service without an API key.
`OPERALIBRE_ANIMATIC_ROOT` is the repository path, not a secret.

## Tested

2026-11-14, on macOS: Siri sample at 2.71 words/s; setup printed Ready;
one-moment build completed with no warnings. The rendered frame was inspected.

The edge-tts sample ran at 2.23 words/s; setup printed Ready; its one-moment
build completed with no warnings on the same Mac. Other operating systems
have not been tested.
