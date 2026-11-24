# 0029. Size read-along speech recognition to the server

Status: Accepted.

## Context

Recognition supplies the phrases that anchor each alignment window and the word clocks that repair sentence starts. The smallest whisper model was the first pass. On sampled narration it dropped passages of fifteen seconds or more in three of four four-minute windows, and a gap like that sends the window to a second, slower model. Servers range from a Raspberry Pi to a desktop, and a model that suits one is too slow or too large for the other.

## Decision

- Recognize English with Parakeet transducer models through sherpa-onnx, in a recognizer that ships in the add-on beside the aligner. Keep forced alignment, language detection, and other languages on the existing runtime. The multilingual Parakeet export lost words on some narration, and no other language had books to measure with.
- Lead with the 110M model. On the same narration it was more accurate than whisper `base.en`, about three times as fast, and used no more memory than whisper `tiny.en`. One laptop core ran it at eighteen times real time.
- Use the 0.6B model as the second opinion on a server with at least 6 GB of memory, and as the first pass on a server that runs the small model at ninety times real time or more. A server without room for it keeps whisper as the second opinion.
- Measure that speed once per machine and speech runtime, and keep the result. A book resumed after a restart must be planned the same way, because the recognition settings are part of a checkpoint's identity.
- Let the add-on choose. It knows its models, the machine's memory, a container's limit, and its own speed. The server asks for a plan for each book, names the model it wants for each window, and reads the same word timeline from either recognizer. A server with an older add-on, a hand-installed aligner, or a recognizer that cannot start on that system keeps whisper.
- Ship the small model in the add-on package and download the larger one on first use, pinned by size and SHA-256. Keep downloads outside the add-on folder, which is copied into a backup whenever the add-on is updated or removed.
- Cut audio into pieces of thirty seconds, or fifteen on a small machine, at the quietest moment near each cut. Memory grows with the square of a piece's length, and speed and accuracy do not improve with longer pieces.
- Keep one recognizer process for each model while a book syncs, and send it every window. Starting a process and loading the model took one to three seconds a window, which was about a tenth of a sync on the processor and a third of each window's recognition on the card. A recognizer with no work leaves after three minutes, or thirty seconds for a model used only for retries, so the larger model does not hold 1.5 GB for the rest of the book.
- On a server with six or more cores, recognize the next window while the aligner places the current one. Recognition decides where a window ends before alignment starts, so the next window is already known. The recognizer uses up to four cores and leaves one for playback, so a smaller server does the two in turn.
- Leave the rest of recognition as it is. On the same laptop, decoding two pieces at once was 1.3 times as fast for twice the processor time and did not fit twice on a 6 GB card, the unquantized 0.6B weights were slower than the quantized ones on the processor, and the aligner starts in a third of a second.
- Compare a recognizer's word clocks with pauses in the audio before trusting them. One export that recognized well placed every word a third of a second late and was left out. The 0.6B model placed words one 80 ms encoder frame earlier than the small model did, with either set of weights, so its times are moved one frame later. On four windows from two narrators that raised the share of its words within 100 ms of a pause's end from 51–73% to 76–98%; the small model's was 67–81%.
- Use a graphics card only when the owner turns it on in Administration, and only NVIDIA cards on 64-bit Linux, the one combination measured. A 2016 laptop card ran the 0.6B model on a four-minute window in under six seconds from a cold start, against under nine for the small model on the processor and about thirty for the 0.6B model there. The card needs the unquantized weights: the quantized ones ran slower on the card than on the processor, and the half-precision ones overflowed.
- Borrow the CUDA build of the speech runtime that sherpa-onnx publishes for the same version, and put the npm package's addon beside its libraries. Download it and the unquantized model after the owner opts in, pinned like the other downloads. Leave NVIDIA's CUDA and cuDNN libraries to the owner.
- Prove the card with a trial run in a separate process before each book. The runtime answers a missing library by using the processor without failing, so its message counts as a failure. The first trial uses the small model, which finds a missing library before the 2.5 GB download. A card that fails its trial gets the processor plan and the reason. The trial is not remembered: the plan follows the card as it is now, and a book resumed after the card stops working starts over on the processor.

## Consequences

An English book needs one recognition pass per window in the usual case. The add-on package grows by the small model and the speech runtime. The recognizer needs a newer system C library than the aligner does; an older system keeps whisper and the sync says so. A recognizer that the card brings down in the middle of a book is handled as any recognizer crash is: the chapter is retried once, led by the small model on the processor. The next sync tests the card again.

See [recognize.mjs](../../addons/readalong-sync/recognize.mjs), [sync.rs](../../apps/server/src/sync.rs), and [recognition windows](0028-bound-readalong-recognition-and-prefetch.md).
