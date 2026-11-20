import SwiftUI
import WidgetKit

private struct Entry: TimelineEntry {
    let date = Date()
    let book: ResumeWidgetBook?
}

private struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        Entry(book: ResumeWidgetBook(identity: "preview", title: "Alice’s Adventures in Wonderland",
                                     author: "Lewis Carroll", remaining: "4m", percent: 68,
                                     artwork: Bundle.main.url(forResource: "Alice", withExtension: "png").flatMap { try? Data(contentsOf: $0) }))
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : Entry(book: .read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry(book: .read())], policy: .never))
    }
}

struct ResumeWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let book: ResumeWidgetBook?
    private let image: UIImage?
    private let ink: Color
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let tint: LinearGradient

    private var background: some View {
        ZStack {
            tint
            if !reduceTransparency {
                RadialGradient(colors: [.white.opacity(0.66), .clear],
                                   center: UnitPoint(x: 0.12, y: -0.16), startRadius: 0, endRadius: 160)
                LinearGradient(stops: [
                    .init(color: .clear, location: 0.4),
                    .init(color: .white.opacity(0.23), location: 0.57),
                    .init(color: .clear, location: 0.68)
                ], startPoint: .topLeading, endPoint: .bottomTrailing)
                ContainerRelativeShape().strokeBorder(
                    LinearGradient(colors: [.white.opacity(0.95), .white.opacity(0.12), .white.opacity(0.78)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1.2)
            }
        }
    }

    init(book: ResumeWidgetBook?) {
        self.book = book
        let image = book?.artwork.flatMap { UIImage(data: $0) }
        self.image = image
        let color = Self.coverColor(image?.cgImage)
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0
        color.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: nil)
        ink = Color(hue: hue, saturation: saturation * 0.70, brightness: 0.16)
        tint = LinearGradient(colors: [
            Color(hue: hue, saturation: saturation * 0.19, brightness: 0.98),
            Color(hue: hue, saturation: saturation * 0.53, brightness: 0.87)
        ], startPoint: .bottomLeading, endPoint: .topTrailing)
    }

    private static func coverColor(_ image: CGImage?) -> UIColor {
        let side = 24
        guard let image, let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8,
                                      bytesPerRow: side * 4, space: space,
                                      bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue),
              let data = context.data else { return .gray }
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        let pixels = data.assumingMemoryBound(to: UInt8.self)
        // Group nearby shades so lettering and highlights don't muddy the cover's main hue.
        var buckets = [Int: (count: Int, red: Int, green: Int, blue: Int)]()
        for offset in stride(from: 0, to: side * side * 4, by: 4) where pixels[offset + 3] >= 240 {
            let r = Int(pixels[offset]), g = Int(pixels[offset + 1]), b = Int(pixels[offset + 2])
            let key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5)
            let old = buckets[key] ?? (0, 0, 0, 0)
            buckets[key] = (old.count + 1, old.red + r, old.green + g, old.blue + b)
        }
        guard let dominant = buckets.max(by: {
            ($0.value.count, $0.key) < ($1.value.count, $1.key)
        })?.value else { return .gray }
        let scale = CGFloat(dominant.count * 255)
        return UIColor(red: CGFloat(dominant.red) / scale, green: CGFloat(dominant.green) / scale,
                       blue: CGFloat(dominant.blue) / scale, alpha: 1)
    }

    @ViewBuilder private var cover: some View {
        if let image {
            Image(uiImage: image).resizable().scaledToFill()
        } else {
            ZStack {
                Color(red: 0.37, green: 0.13, blue: 0.10)
                Image(systemName: "book.closed.fill").font(.largeTitle).foregroundStyle(.white)
            }
        }
    }

    private func artwork(_ side: CGFloat) -> some View {
        cover.frame(width: side, height: side)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .shadow(color: .black.opacity(0.18), radius: 3, y: 2)
            .accessibilityHidden(true)
    }

    @ViewBuilder private var details: some View {
        if let book {
            Text(verbatim: book.title).font(.headline).lineLimit(family == .systemLarge ? 2 : 1)
            if family != .systemSmall, let author = book.author {
                Text(verbatim: author).font(.subheadline).lineLimit(1)
            }
            if family != .systemSmall, let remaining = book.remaining {
                Text("\(remaining) left").font(.caption)
            }
        }
    }

    @ViewBuilder private var action: some View {
        let label = Label("Resume", systemImage: "play.fill").font(.caption.bold())
            .padding(.horizontal, 12).padding(.vertical, 6)
        if #available(iOS 26, *), !reduceTransparency {
            label.foregroundStyle(ink)
                .glassEffect(.regular.tint(.white.opacity(0.25)), in: Capsule())
        } else {
            label.foregroundStyle(.white).background(ink, in: Capsule())
        }
    }

    private var content: some View {
        GeometryReader { geo in
            if book == nil {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "headphones").font(.title2)
                    Text("Continue listening").font(.headline)
                    Text("Start an audiobook in OperaLibre.").font(.caption)
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            } else if family == .systemMedium {
                HStack(spacing: 14) {
                    artwork(min(geo.size.height, geo.size.width * 0.40))
                    VStack(alignment: .leading, spacing: 4) {
                        Image(systemName: "headphones").font(.subheadline.bold())
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .accessibilityHidden(true)
                        Spacer(minLength: 0)
                        details
                        action.padding(.top, 4)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    artwork(min(geo.size.width, geo.size.height * (family == .systemLarge ? 0.54 : 0.50)))
                        .frame(maxWidth: .infinity, alignment: family == .systemLarge ? .center : .leading)
                    Spacer(minLength: 0)
                    details
                    if family == .systemLarge, let percent = book?.percent {
                        ProgressView(value: Double(percent), total: 100).tint(ink)
                            .accessibilityLabel("Book progress")
                    }
                    action
                }
            }
        }
        .foregroundStyle(ink)
        .widgetURL(book?.resumeURL)
        .privacySensitive(book != nil)
    }

    var body: some View {
        if #available(iOS 17, *) {
            content.containerBackground(for: .widget) { background }
        } else {
            content.padding().background(background)
        }
    }
}

struct ResumeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: ResumeWidgetBook.kind, provider: Provider()) { entry in
            ResumeWidgetView(book: entry.book)
        }
        .configurationDisplayName("Continue listening")
        .description("Resume your current audiobook.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
