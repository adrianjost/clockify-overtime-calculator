import AppKit
import UniformTypeIdentifiers
import WebKit

/// Hosts the web dashboard. JS calls Swift through `window.webkit.messageHandlers.rpc`,
/// see `src/mainview/bridge.ts`.
final class MainWindowController: NSObject, NSWindowDelegate, WKScriptMessageHandlerWithReply,
  WKNavigationDelegate, WKUIDelegate
{
  typealias RequestHandler = (_ method: String, _ params: [String: Any]) async throws -> String?

  private static let minSize = NSSize(width: 400, height: 450)
  private static let defaultSize = NSSize(width: 720, height: 560)
  private static let screenMargin: CGFloat = 24
  private static let frameAutosaveName = "MainWindow"

  let window: NSWindow
  private let webView: ChartWebView
  private let handleRequest: RequestHandler
  private let onClose: () -> Void

  init(handleRequest: @escaping RequestHandler, onClose: @escaping () -> Void) {
    self.handleRequest = handleRequest
    self.onClose = onClose

    let configuration = WKWebViewConfiguration()
    configuration.setURLSchemeHandler(BundledWebHandler(), forURLScheme: BundledWebHandler.scheme)
    configuration.userContentController.addUserScript(Self.accentColorScript())
    webView = ChartWebView(frame: .zero, configuration: configuration)
    webView.setValue(false, forKey: "drawsBackground")
    webView.underPageBackgroundColor = .clear
    #if DEBUG
      webView.isInspectable = true
    #endif

    window = NSWindow(
      contentRect: NSRect(origin: .zero, size: Self.defaultSize),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "Tickover"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.minSize = Self.minSize
    window.isReleasedWhenClosed = false

    // Native window material behind the (transparent) page; the page starts below
    // the title bar so the window stays draggable there.
    let background = NSVisualEffectView()
    background.material = .windowBackground
    background.blendingMode = .behindWindow
    background.state = .followsWindowActiveState
    window.contentView = background
    webView.translatesAutoresizingMaskIntoConstraints = false
    background.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: (window.contentLayoutGuide as! NSLayoutGuide).topAnchor),
      webView.leadingAnchor.constraint(equalTo: background.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: background.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: background.bottomAnchor),
    ])

    super.init()

    configuration.userContentController.addScriptMessageHandler(
      self, contentWorld: .page, name: "rpc")
    window.delegate = self
    webView.navigationDelegate = self
    webView.uiDelegate = self
    if !window.setFrameUsingName(Self.frameAutosaveName) {
      placeTopRight()
    }
    window.setFrameAutosaveName(Self.frameAutosaveName)

    webView.load(
      URLRequest(
        url: URL(string: "\(BundledWebHandler.scheme)://\(BundledWebHandler.host)/index.html")!))
  }

  func show() {
    window.deminiaturize(nil)
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
  }

  func close() {
    window.performClose(nil)
  }

  /// Caps the window so the page never gets taller than its content can use.
  func setPageMaxHeight(_ pageHeight: Double) {
    let contentHeight = window.contentView?.frame.height ?? 0
    let titlebarInset = contentHeight - webView.frame.height
    let maxHeight = max(Self.minSize.height, CGFloat(pageHeight) + titlebarInset)
    window.contentMaxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: maxHeight)
    if contentHeight > maxHeight + 0.5 {
      var frame = window.frame
      let shrink = contentHeight - maxHeight
      frame.size.height -= shrink
      frame.origin.y += shrink
      window.setFrame(frame, display: true, animate: false)
    }
  }

  /// Keeps the window at least this wide, widening it now if needed (e.g. for the entries sidebar).
  func setPageMinWidth(_ width: Double) {
    let minWidth = max(Self.minSize.width, CGFloat(width))
    window.contentMinSize = NSSize(width: minWidth, height: window.contentMinSize.height)
    guard let contentWidth = window.contentView?.frame.width, contentWidth < minWidth else { return }
    var frame = window.frame
    frame.size.width += minWidth - contentWidth
    if let visible = window.screen?.visibleFrame {
      // Grow to the right, or move left where the screen ends.
      frame.origin.x = max(visible.minX, min(frame.origin.x, visible.maxX - frame.width))
    }
    window.setFrame(frame, display: true, animate: true)
  }

  /// Tells the page that the timer or entries changed outside of it (e.g. from the menu bar).
  func notifyTrackingChanged() {
    webView.evaluateJavaScript("window.dispatchEvent(new Event('tracking-changed'))")
  }

  func showSettings() {
    webView.evaluateJavaScript("location.hash = '#settings'")
  }

  /// Exposes the system accent color to CSS for light and dark appearance.
  private static func accentColorScript() -> WKUserScript {
    func hex(_ appearance: NSAppearance.Name) -> String {
      var result = "#007aff"
      NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance {
        if let color = NSColor.controlAccentColor.usingColorSpace(.sRGB) {
          result = String(
            format: "#%02x%02x%02x", Int(color.redComponent * 255),
            Int(color.greenComponent * 255), Int(color.blueComponent * 255))
        }
      }
      return result
    }
    let source = """
      document.documentElement.style.setProperty('--accent-light', '\(hex(.aqua))');
      document.documentElement.style.setProperty('--accent-dark', '\(hex(.darkAqua))');
      """
    return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
  }

  func windowWillClose(_ notification: Notification) {
    webView.configuration.userContentController.removeAllScriptMessageHandlers()
    onClose()
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) async -> (Any?, String?) {
    // Only the bundled page may call the app, not another page or frame that ended up in the view.
    let origin = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame, origin.protocol == BundledWebHandler.scheme,
      origin.host == BundledWebHandler.host
    else {
      return (nil, "Not allowed")
    }
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

  /// The window only shows the bundled page; web links open in the default browser.
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
    if url.scheme == BundledWebHandler.scheme && url.host == BundledWebHandler.host {
      return decisionHandler(.allow)
    }
    openExternally(url)
    decisionHandler(.cancel)
  }

  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url { openExternally(url) }
    return nil
  }

  private func openExternally(_ url: URL) {
    guard ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
    NSWorkspace.shared.open(url)
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
  static let host = "app"

  private let root = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)

  func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    let relativePath = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
    let file = root.appendingPathComponent(relativePath).standardizedFileURL

    guard file.path.hasPrefix(root.standardizedFileURL.path + "/"),
      let data = try? Data(contentsOf: file)
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
