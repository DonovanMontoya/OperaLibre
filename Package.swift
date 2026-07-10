// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "OperaLibreMac",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "OperaLibre", targets: ["OperaLibre"])
    ],
    targets: [
        .executableTarget(
            name: "OperaLibre",
            path: "apps/macos/Sources/OperaLibre"
        )
    ]
)
