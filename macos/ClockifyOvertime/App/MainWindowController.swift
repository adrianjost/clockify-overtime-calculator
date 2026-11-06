import AppKit
import UniformTypeIdentifiers
import WebKit

/// Hosts the web dashboard. JS calls Swift through `window.webkit.messageHandlers.rpc`,
/// see `src/mainview/bridge.ts`.
final class MainWindowController: NSObject, NSWindowDelegate, WKScriptMessageHandlerWithReply {
  typealias RequestHandler = (_ method: String, _ params: [String: Any]) async throws -> String?

  private static let minSize = NSSize(width: 400, height: 450)
  private static let screenMargin: CGFloat = 24
  private static let frameAutosaveName = "MainWindow"

  let window: NSWindow
  private let webView: WKWebView
  private let handleRequest: RequestHandler
  private let onClose: () -> Void

  init(handleRequest: @escaping RequestHandler, onClose: @escaping () -> Void) {
    self.handleRequest = handleRequest
    self.onClose = onClose

    let configuration = WKWebViewConfiguration()
    configuration.setURLSchemeHandler(BundledWebHandler(), forURLScheme: BundledWebHandler.scheme)
    webView = WKWebView(frame: .zero, configuration: configuration)
    #if DEBUG
      webView.isInspectable = true
    #endif

    window = NSWindow(
      contentRect: NSRect(origin: .zero, size: Self.minSize),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Clockify Overtime"
    window.minSize = Self.minSize
    window.isReleasedWhenClosed = false
    window.contentView = webView

    super.init()

    configuration.userContentController.addScriptMessageHandler(
      self, contentWorld: .page, name: "rpc")
    window.delegate = self
    if !window.setFrameUsingName(Self.frameAutosaveName) {
      placeTopRight()
    }
    window.setFrameAutosaveName(Self.frameAutosaveName)

    webView.load(URLRequest(url: URL(string: "\(BundledWebHandler.scheme)://app/index.html")!))
  }

  func show() {
    window.deminiaturize(nil)
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
  }

  func close() {
    window.performClose(nil)
  }

  func windowWillClose(_ notification: Notification) {
    webView.configuration.userContentController.removeAllScriptMessageHandlers()
    onClose()
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) async -> (Any?, String?) {
    guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
      return (nil, "Invalid request")
    }
    do {
      let result = try await handleRequest(method, body["params"] as? [String: Any] ?? [:])
      return (result, nil)
    } catch {
      return (nil, error.localizedDescription)
    }
  }

  private func placeTopRight() {
    guard let visible = NSScreen.main?.visibleFrame else {
      window.center()
      return
    }
    let size = window.frame.size
    window.setFrameOrigin(
      NSPoint(
        x: visible.maxX - size.width - Self.screenMargin,
        y: visible.maxY - size.height - Self.screenMargin
      ))
  }
}

/// Serves the bundled web UI (`Resources/web`) from `app://app/…`, which gives the
/// page a stable origin for localStorage.
private final class BundledWebHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "app"

  private let root = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)

  func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    let relativePath = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
    let file = root.appendingPathComponent(relativePath).standardizedFileURL

    guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file)
    else {
      task.didFailWithError(URLError(.fileDoesNotExist))
      return
    }
    let mimeType = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType
    let response = HTTPURLResponse(
      url: url,
      statusCode: 200,
      httpVersion: "HTTP/1.1",
      headerFields: [
        "Content-Type": mimeType ?? "application/octet-stream",
        "Content-Length": String(data.count),
      ]
    )!
    task.didReceive(response)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}
