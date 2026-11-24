import CoreGraphics

@main
struct DisplayTransitionTests {
    static func main() {
        let ipad = CGSize(width: 1024, height: 1366)
        let cover = CGSize(width: 466, height: 678)
        let inner = CGSize(width: 951, height: 669)
        let innerPortrait = CGSize(width: 669, height: 951)

        func change(_ old: CGSize, _ new: CGSize, before: CGSize?, now: CGSize?) -> Bool {
            DisplayTransition.isScreenChange(from: old, to: new, rotating: false, screenBefore: before, screenNow: now)
        }

        // Resizing an iPad window through the 500-point short edge stays on one screen.
        precondition(!change(CGSize(width: 520, height: 900), CGSize(width: 480, height: 900), before: ipad, now: ipad))
        precondition(!change(CGSize(width: 480, height: 900), CGSize(width: 520, height: 900), before: ipad, now: ipad))
        precondition(!change(ipad, CGSize(width: 320, height: 1366), before: ipad, now: ipad))
        // So does putting the app beside another on the Duo's inner screen.
        precondition(!change(inner, CGSize(width: 466, height: 669), before: inner, now: inner))
        precondition(!change(CGSize(width: 466, height: 669), inner, before: inner, now: inner))
        // Without screen information the page stays visible.
        precondition(!change(cover, inner, before: nil, now: nil))

        // Moving between the cover and inner screens, in either direction.
        precondition(change(cover, inner, before: cover, now: inner))
        precondition(change(inner, cover, before: inner, now: cover))
        precondition(change(cover, innerPortrait, before: cover, now: innerPortrait))
        precondition(change(innerPortrait, cover, before: innerPortrait, now: cover))
        // A screen size that has not caught up yet is still caught when the
        // new size cannot fit on the old screen.
        precondition(change(cover, inner, before: cover, now: cover))
        // A cover-sized page fits on the inner screen, so leaving it with both
        // readings still on the inner screen falls back to staying visible.
        precondition(!change(inner, cover, before: inner, now: inner))
        // A screen reported in the other orientation is the same screen.
        precondition(!change(CGSize(width: 520, height: 900), CGSize(width: 480, height: 900),
                             before: ipad, now: CGSize(width: ipad.height, height: ipad.width)))

        // Turning a phone is a rotation, never a move between screens.
        let portrait = CGSize(width: 402, height: 874)
        let landscape = CGSize(width: 874, height: 402)
        precondition(DisplayTransition.isRotation(from: portrait, to: landscape, transformed: true))
        precondition(DisplayTransition.isRotation(from: portrait, to: portrait, transformed: true))
        precondition(!DisplayTransition.isRotation(from: portrait, to: landscape, transformed: false))
        precondition(!DisplayTransition.isRotation(from: cover, to: inner, transformed: true))
        precondition(!DisplayTransition.isScreenChange(from: cover, to: CGSize(width: 678, height: 466), rotating: true,
                                                      screenBefore: cover, screenNow: cover))
        print("Display transition tests passed")
    }
}
