import AppKit
import Network
import WebKit

final class BundledWebServer {
    let root: URL
    private let queue = DispatchQueue(label: "com.operalibre.web-server")
    private var listener: NWListener?

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func start(onReady: @escaping (Result<URL, Error>) -> Void) {
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 49201)
            let listener = try NWListener(using: parameters)
            self.listener = listener
            listener.newConnectionHandler = { [weak self] connection in
                self?.handle(connection)
            }
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    DispatchQueue.main.async {
                        onReady(.success(URL(string: "http://127.0.0.1:49201/index.html")!))
                    }
                case .failed(let error):
                    DispatchQueue.main.async { onReady(.failure(error)) }
                default:
                    break
                }
            }
            listener.start(queue: queue)
        } catch {
            onReady(.failure(error))
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, _, error in
            guard let self, error == nil, let data, let request = String(data: data, encoding: .utf8) else {
                connection.cancel()
                return
            }
            let requestTarget = request.split(separator: " ", maxSplits: 2).dropFirst().first.map(String.init) ?? "/"
            let path = requestTarget.split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
            self.respond(to: connection, path: path)
        }
    }

    private func respond(to connection: NWConnection, path: String) {
        let relativePath = path.removingPercentEncoding?
            .trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        let fileURL = root.appendingPathComponent(relativePath.isEmpty ? "index.html" : relativePath)
            .standardizedFileURL
        guard fileURL.path.hasPrefix(root.path + "/") else {
            send(connection, status: "403 Forbidden", mimeType: "text/plain", data: Data("Forbidden".utf8))
            return
        }

        do {
            let data = try Data(contentsOf: fileURL)
            let mimeType: String
            switch fileURL.pathExtension.lowercased() {
            case "html": mimeType = "text/html"
            case "css": mimeType = "text/css"
            case "js": mimeType = "text/javascript"
            case "json", "webmanifest": mimeType = "application/json"
            case "png": mimeType = "image/png"
            case "jpg", "jpeg": mimeType = "image/jpeg"
            case "svg": mimeType = "image/svg+xml"
            default: mimeType = "application/octet-stream"
            }
            send(connection, status: "200 OK", mimeType: mimeType, data: data)
        } catch {
            send(connection, status: "404 Not Found", mimeType: "text/plain", data: Data("Not found".utf8))
        }
    }

    private func send(_ connection: NWConnection, status: String, mimeType: String, data: Data) {
        var response = Data(
            "HTTP/1.1 \(status)\r\nContent-Type: \(mimeType)\r\nContent-Length: \(data.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8
        )
        response.append(data)
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var webServer: BundledWebServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMainMenu()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(self, name: "frontendError")
        configuration.userContentController.addUserScript(WKUserScript(
            source: """
            window.addEventListener('error', event => {
              window.webkit.messageHandlers.frontendError.postMessage(
                event.error?.stack || `${event.message || 'Unknown frontend error'} at ${event.filename}:${event.lineno}:${event.colno}`
              );
            });
            window.addEventListener('unhandledrejection', event => {
              window.webkit.messageHandlers.frontendError.postMessage(
                event.reason?.stack || String(event.reason || 'Unhandled promise rejection')
              );
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OperaLibre"
        window.minSize = NSSize(width: 900, height: 620)
        window.contentView = webView
        window.setFrameAutosaveName("OperaLibreMainWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)

        self.window = window
        self.webView = webView

        loadFrontend(in: webView)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        webServer?.stop()
    }

    private func loadFrontend(in webView: WKWebView) {
        guard let resources = Bundle.main.resourceURL else {
            showStartupError("The application resources directory is missing.")
            return
        }

        let webRoot = resources.appendingPathComponent("Web", isDirectory: true)
        let index = webRoot.appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: index.path) else {
            showStartupError("The bundled web frontend is missing. Rebuild with script/build_and_run.sh.")
            return
        }

        let server = BundledWebServer(root: webRoot)
        webServer = server
        server.start { [weak self, weak webView] result in
            switch result {
            case .success(let url):
                webView?.load(URLRequest(url: url))
            case .failure(let error):
                self?.showStartupError("The local frontend server could not start.\n\n\(error.localizedDescription)")
            }
        }
    }

    private func showStartupError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "OperaLibre could not start"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "frontendError" else { return }
        let detail = String(describing: message.body)
        NSLog("Frontend error: %@", detail)
        showStartupError("The bundled frontend failed to load.\n\n\(detail)")
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()

        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(
            withTitle: "About OperaLibre",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(
            withTitle: "Quit OperaLibre",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        applicationItem.submenu = applicationMenu
        mainMenu.addItem(applicationItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        NSApp.mainMenu = mainMenu
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")

        let input = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input

        let response = alert.runModal()
        completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
