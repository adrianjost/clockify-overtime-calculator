import AppKit
import WebKit

/// Forwards trackpad pinches to the dashboard chart. WebKit's own gesture events end as soon as
/// the chart re-renders the element under the fingers.
final class ChartWebView: WKWebView {
  override func magnify(with event: NSEvent) {
    let phase: String
    if event.phase.contains(.began) {
      phase = "start"
    } else if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
      phase = "end"
    } else {
      phase = "change"
    }
    let point = convert(event.locationInWindow, from: nil)
    let y = isFlipped ? point.y : bounds.height - point.y
    evaluateJavaScript("window.nativePinch?.('\(phase)', \(event.magnification), \(point.x), \(y))")
  }
}
