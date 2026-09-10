import AppIntents
import Foundation

private enum AudiobookShortcutError: LocalizedError {
    case noAudiobook

    var errorDescription: String? {
        "Open OperaLibre and start an audiobook first, then ask me to resume it."
    }
}

@available(iOS 16.0, *)
struct ResumeAudiobookIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "Resume Audiobook"
    static var description = IntentDescription("Resume your current audiobook in OperaLibre.")
    static var openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult {
        guard CarPlayCoordinator.shared.resumeAudiobook() else {
            throw AudiobookShortcutError.noAudiobook
        }
        return .result()
    }
}

@available(iOS 16.0, *)
struct AudiobookShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ResumeAudiobookIntent(),
            phrases: [
                "Resume \(.applicationName)",
                "Resume my audiobook in \(.applicationName)",
                "Resume my book in \(.applicationName)",
                "Continue my audiobook in \(.applicationName)",
                "Play my audiobook in \(.applicationName)"
            ],
            shortTitle: "Resume Audiobook",
            systemImageName: "play.fill"
        )
    }
}
