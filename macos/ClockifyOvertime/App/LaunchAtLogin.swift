import AppKit
import ServiceManagement

enum LaunchAtLogin {
  private static let legacyLaunchAgent = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/LaunchAgents/dev.adrianjost.clockify-overtime.plist")

  static var isEnabled: Bool {
    SMAppService.mainApp.status == .enabled
  }

  static func setEnabled(_ enabled: Bool) throws {
    if enabled {
      try SMAppService.mainApp.register()
    } else {
      try SMAppService.mainApp.unregister()
    }
  }

  /// Must be called from `applicationWillFinishLaunching`, while the launch event is current.
  static func wasLaunchedAsLoginItem() -> Bool {
    let launchedAsLoginItem: OSType = 0x6C67_6974  // 'lgit', keyAELaunchedAsLoginItem
    guard let event = NSAppleEventManager.shared().currentAppleEvent else { return false }
    return event.eventID == kAEOpenApplication
      && event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == launchedAsLoginItem
  }

  /// The Electrobun version used a LaunchAgent; replace it with a login item.
  /// Only for installed copies, so dev builds don't register themselves as login item.
  static func migrateLegacyLaunchAgent() {
    guard Bundle.main.bundlePath.hasPrefix("/Applications/"),
      FileManager.default.fileExists(atPath: legacyLaunchAgent.path)
    else { return }
    let unload = Process()
    unload.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    unload.arguments = ["unload", legacyLaunchAgent.path]
    try? unload.run()
    unload.waitUntilExit()
    try? FileManager.default.removeItem(at: legacyLaunchAgent)
    try? setEnabled(true)
  }
}
