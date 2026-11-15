import AVFoundation
import Foundation

guard CommandLine.arguments.count == 2 else {
    fatalError("Usage: swift animatic-voice.swift output.wav < narration.txt")
}
let identifier = "com.apple.siri.natural.en-US-G"
guard let voice = AVSpeechSynthesisVoice(identifier: identifier) else {
    fatalError("Siri Voice 6 is unavailable. Install it in macOS voice settings before continuing.")
}
let text = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    fatalError("Narration is empty")
}
let synthesizer = AVSpeechSynthesizer()
let utterance = AVSpeechUtterance(string: text)
utterance.voice = voice
var output: AVAudioFile?
var finished = false
synthesizer.write(utterance) { buffer in
    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
    if pcm.frameLength == 0 {
        finished = true
        return
    }
    do {
        if output == nil {
            output = try AVAudioFile(
                forWriting: URL(fileURLWithPath: CommandLine.arguments[1]),
                settings: pcm.format.settings
            )
        }
        try output?.write(from: pcm)
    } catch {
        fputs("Could not export Siri narration: \(error)\n", stderr)
        exit(1)
    }
}
let deadline = Date().addingTimeInterval(max(60, Double(text.count) / 5))
while !finished && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}
guard finished, output != nil else {
    fputs("Siri narration timed out or produced no audio\n", stderr)
    exit(1)
}
output = nil
