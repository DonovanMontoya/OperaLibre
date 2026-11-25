import SwiftUI
import WidgetKit

private struct StreakEntry: TimelineEntry {
    let date = Date()
    let streak: ReadingStreak?
}

private struct StreakProvider: TimelineProvider {
    func placeholder(in context: Context) -> StreakEntry {
        StreakEntry(streak: ReadingStreak(current: 5, longest: 9,
            activity: (0..<28).map { $0 >= 23 || $0 % 6 < 3 }, asOf: Date()))
    }

    func getSnapshot(in context: Context, completion: @escaping (StreakEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : StreakEntry(streak: .read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StreakEntry>) -> Void) {
        let tomorrow = Calendar.current.dateInterval(of: .day, for: Date())?.end
        completion(Timeline(entries: [StreakEntry(streak: .read())], policy: tomorrow.map { .after($0) } ?? .never))
    }
}

struct ReadingStreakView: View {
    @Environment(\.widgetFamily) private var family
    let streak: ReadingStreak?
    private let ink = Color(red: 0.21, green: 0.14, blue: 0.10)
    private let accent = Color(red: 0.56, green: 0.21, blue: 0.12)
    private let paper = Color(red: 0.98, green: 0.94, blue: 0.84)

    private func history(_ streak: ReadingStreak) -> some View {
        let days = Array(streak.activity.suffix(family == .systemLarge ? 28 : 7))
        return VStack(alignment: .leading, spacing: 8) {
            Text("Last \(days.count) days").font(.caption.bold())
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7), spacing: 4) {
                ForEach(days.indices, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 3)
                        .fill(days[index] ? accent : ink.opacity(0.12))
                        .frame(height: family == .systemLarge ? 16 : 12)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Listened on \(days.filter { $0 }.count) of the last \(days.count) days")
    }

    private func count(_ streak: ReadingStreak) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(streak.current, format: .number)
                .font(.system(size: family == .systemLarge ? 64 : 44, weight: .semibold, design: .serif))
            Text(streak.current == 1 ? "day" : "days").font(.subheadline)
        }.lineLimit(1).minimumScaleFactor(0.65)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Reading streak", systemImage: "flame.fill")
                .font(.subheadline.bold()).foregroundStyle(accent)
            if let streak {
                Spacer(minLength: 0)
                if family == .systemMedium {
                    HStack(alignment: .bottom, spacing: 16) {
                        count(streak)
                        if !streak.activity.isEmpty { history(streak) }
                    }
                } else {
                    count(streak)
                }
                if family != .systemSmall {
                    Text(streak.longest == 1 ? "Best: 1 day" : "Best: \(streak.longest) days").font(.caption)
                }
                if family == .systemLarge && !streak.activity.isEmpty {
                    history(streak).padding(.vertical, 8)
                }
                Spacer(minLength: 0)
                Text("As of \(streak.asOf.formatted(date: .abbreviated, time: .omitted))")
                    .font(.caption2)
            } else {
                Spacer(minLength: 0)
                Text("Listen in OperaLibre to start a streak.").font(.subheadline)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .foregroundStyle(ink)
        .privacySensitive(streak != nil)
    }

    var body: some View {
        if #available(iOS 17, *) {
            content.containerBackground(for: .widget) { paper }
        } else {
            content.padding().background(paper)
        }
    }
}

private struct ReadingStreakWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: ReadingStreak.kind, provider: StreakProvider()) { entry in
            ReadingStreakView(streak: entry.streak)
        }
        .configurationDisplayName("Reading streak")
        .description("See your reading streak and recent listening days.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
struct OperaLibreWidgets: WidgetBundle {
    var body: some Widget {
        ResumeWidget()
        ReadingStreakWidget()
    }
}
