import UIKit
import XCTest

@MainActor
final class DeviceFoldTests: XCTestCase {
    func testDivisionStopsSplittingWhenAWindowOccupiesOneSide() {
        let vertical = CGRect(x: 460, y: 0, width: 31, height: 669)
        let horizontal = CGRect(x: 0, y: 460, width: 669, height: 31)
        for (region, full, narrow, shifted) in [
            (vertical, CGRect(x: 0, y: 0, width: 951, height: 669),
             CGRect(x: 0, y: 0, width: 466, height: 669),
             CGRect(x: 491, y: 0, width: 460, height: 669)),
            (horizontal, CGRect(x: 0, y: 0, width: 669, height: 951),
             CGRect(x: 0, y: 0, width: 669, height: 466),
             CGRect(x: 0, y: 491, width: 669, height: 460))
        ] {
            XCTAssertTrue(DeviceFoldPlugin.dividesViewport(region, bounds: full))
            XCTAssertFalse(DeviceFoldPlugin.dividesViewport(region, bounds: narrow))
            XCTAssertFalse(DeviceFoldPlugin.dividesViewport(region, bounds: shifted))
            XCTAssertTrue(DeviceFoldPlugin.dividesViewport(region, bounds: full))
        }
    }

    func testFlatZeroWidthDivisionRetainsUsableLayoutGeometry() {
        XCTAssertTrue(DeviceFoldPlugin.dividesViewport(
            CGRect(x: 475, y: 0, width: 0, height: 669),
            bounds: CGRect(x: 0, y: 0, width: 951, height: 669)))
        XCTAssertTrue(DeviceFoldPlugin.dividesViewport(
            CGRect(x: 0, y: 475, width: 669, height: 0),
            bounds: CGRect(x: 0, y: 0, width: 669, height: 951)))
    }

    func testUnavailableAndNonOverlappingGeometryDoesNotSplit() {
        let bounds = CGRect(x: 0, y: 0, width: 951, height: 669)
        for frame in [CGRect.null, CGRect.infinite,
                      CGRect(x: 475, y: 334, width: 0, height: 0),
                      CGRect(x: 460, y: 700, width: 31, height: 669),
                      CGRect(x: 1000, y: 320, width: 951, height: 24)] {
            XCTAssertFalse(DeviceFoldPlugin.dividesViewport(frame, bounds: bounds))
        }
        XCTAssertFalse(DeviceFoldPlugin.dividesViewport(
            CGRect(x: 460, y: 0, width: 31, height: 669), bounds: .zero))
    }
}
