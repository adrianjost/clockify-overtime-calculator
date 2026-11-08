import AppKit

/// Menu bar item showing the overtime. Left click opens the window, right click shows a menu.
final class StatusItemController: NSObject {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private let onOpen: () -> Void

  init(title: String, onOpen: @escaping () -> Void) {
    self.onOpen = onOpen
    super.init()

    let openItem = NSMenuItem(
      title: "Open Clockify Overtime", action: #selector(openClicked), keyEquivalent: "")
    openItem.target = self
    menu.addItem(openItem)
    menu.addItem(.separator())
    menu.addItem(
      NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

    if let button = statusItem.button {
      button.font = .monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
      button.target = self
      button.action = #selector(buttonClicked)
      button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }
    setTitle(title)
  }

  func setTitle(_ title: String) {
    statusItem.button?.title = title
  }

  func remove() {
    NSStatusBar.system.removeStatusItem(statusItem)
  }

  @objc private func buttonClicked() {
    let event = NSApp.currentEvent
    if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
      statusItem.menu = menu
      statusItem.button?.performClick(nil)
      statusItem.menu = nil
    } else {
      onOpen()
    }
  }

  @objc private func openClicked() {
    onOpen()
  }
}
