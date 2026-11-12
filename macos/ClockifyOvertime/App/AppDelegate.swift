import AppKit

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let controller = AppController()
  private var launchedAtLogin = false

  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
  }

  func applicationWillFinishLaunching(_ notification: Notification) {
    launchedAtLogin = LaunchAtLogin.wasLaunchedAsLoginItem()
    NSApp.setActivationPolicy(.accessory)
    NSApp.mainMenu = buildMainMenu()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    controller.start(launchedAtLogin: launchedAtLogin)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    controller.shouldTerminateAfterLastWindowClosed
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    controller.openMainWindow()
    return false
  }

  @objc private func openSettings() {
    controller.openSettings()
  }

  private func buildMainMenu() -> NSMenu {
    let mainMenu = NSMenu()

    let appMenu = NSMenu()
    let settings = NSMenuItem(
      title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
    settings.target = self
    appMenu.addItem(settings)
    appMenu.addItem(.separator())
    appMenu.addItem(
      NSMenuItem(
        title: "Hide Surplus", action: #selector(NSApplication.hide(_:)),
        keyEquivalent: "h"))
    appMenu.addItem(.separator())
    appMenu.addItem(
      NSMenuItem(
        title: "Quit Surplus", action: #selector(NSApplication.terminate(_:)),
        keyEquivalent: "q"))
    mainMenu.addItem(Self.submenuItem(appMenu))

    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
    let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(redo)
    editMenu.addItem(.separator())
    editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
    editMenu.addItem(
      NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
    editMenu.addItem(
      NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
    editMenu.addItem(
      NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
    mainMenu.addItem(Self.submenuItem(editMenu))

    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(
      NSMenuItem(
        title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
    windowMenu.addItem(
      NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
    mainMenu.addItem(Self.submenuItem(windowMenu))
    NSApp.windowsMenu = windowMenu

    return mainMenu
  }

  private static func submenuItem(_ menu: NSMenu) -> NSMenuItem {
    let item = NSMenuItem()
    item.submenu = menu
    return item
  }
}
