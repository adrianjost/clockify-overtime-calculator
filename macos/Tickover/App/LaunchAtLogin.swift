import AppKit
import ServiceManagement

enum LaunchAtLogin {
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
}
