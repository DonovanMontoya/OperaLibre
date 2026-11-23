import CoreGraphics

enum DisplayTransition {
    /// A turn of the same screen keeps or swaps the view's size and carries a transform.
    static func isRotation(from old: CGSize, to new: CGSize, transformed: Bool) -> Bool {
        transformed && (matches(new, old) || matches(new, CGSize(width: old.height, height: old.width)))
    }

    /// A foldable moving the app between its cover screen (under 500 points on
    /// its short side) and its inner screen. Crossing that size alone is not
    /// enough: a resizable window or split screen can cross it on one screen.
    /// The window must also be seen to change screens, either because the
    /// screen's size changed or because one of the sizes cannot fit on the
    /// other screen. `screenBefore` is the screen at the last layout and
    /// `screenNow` the one reported as the transition starts; without that
    /// evidence the page stays visible.
    static func isScreenChange(from old: CGSize, to new: CGSize, rotating: Bool,
                               screenBefore: CGSize?, screenNow: CGSize?) -> Bool {
        let coverSized = { (size: CGSize) in min(size.width, size.height) < 500 }
        guard !rotating, coverSized(old) != coverSized(new) else { return false }
        if let screenBefore, let screenNow, !matchesEitherWay(screenBefore, screenNow) { return true }
        if let screenBefore, !fits(new, on: screenBefore) { return true }
        if let screenNow, !fits(old, on: screenNow) { return true }
        return false
    }

    private static func matches(_ a: CGSize, _ b: CGSize) -> Bool {
        abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
    }

    private static func matchesEitherWay(_ a: CGSize, _ b: CGSize) -> Bool {
        matches(a, b) || matches(a, CGSize(width: b.height, height: b.width))
    }

    /// Either orientation counts, since a screen's reported orientation can
    /// lag the view's during a transition.
    private static func fits(_ size: CGSize, on screen: CGSize) -> Bool {
        let fitsAs = { (width: CGFloat, height: CGFloat) in
            size.width <= width + 1 && size.height <= height + 1
        }
        return fitsAs(screen.width, screen.height) || fitsAs(screen.height, screen.width)
    }
}
