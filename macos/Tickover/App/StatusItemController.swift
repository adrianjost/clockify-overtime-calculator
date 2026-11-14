import AppKit

/// Menu bar item showing the overtime. Left click opens the window, right click shows a menu.
final class StatusItemController: NSObject {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private let extraMenuItems: () -> [NSMenuItem]
  private let onOpen: () -> Void

  init(
    title: String, extraMenuItems: @escaping () -> [NSMenuItem], onOpen: @escaping () -> Void
  ) {
    self.extraMenuItems = extraMenuItems
    self.onOpen = onOpen
    super.init()

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
      rebuildMenu()
      statusItem.menu = menu
      statusItem.button?.performClick(nil)
      statusItem.menu = nil
    } else {
      onOpen()
    }
  }

  private func rebuildMenu() {
    menu.removeAllItems()
    menu.addItem(MenuAction.item("Open Tickover", key: "", onOpen))
    let extra = extraMenuItems()
    if !extra.isEmpty {
      menu.addItem(.separator())
      extra.forEach(menu.addItem)
    }
    menu.addItem(.separator())
    menu.addItem(
      NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
  }
}

/// A menu item that runs a closure.
final class MenuAction: NSObject {
  private let handler: () -> Void

  private init(_ handler: @escaping () -> Void) {
    self.handler = handler
  }

  static func item(_ title: String, key: String, _ handler: @escaping () -> Void) -> NSMenuItem {
    let action = MenuAction(handler)
    let item = NSMenuItem(title: title, action: #selector(run), keyEquivalent: key)
    item.target = action
    item.representedObject = action  // the item keeps its target alive
    return item
  }

  @objc private func run() {
    handler()
  }
}
