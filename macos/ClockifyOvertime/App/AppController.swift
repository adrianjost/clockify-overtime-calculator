import AppKit

final class AppController {
  private static let trayRefreshInterval: Duration = .seconds(60)

  private var preferences = Preferences.load()
  private let store = TimeEntryStore(cacheFile: Paths.timeEntryCache)
  private var currentApiKey: String?
  private var trayTitle = "--"
  private var statusItem: StatusItemController?
  private var mainWindow: MainWindowController?
  private var trayRefreshTask: Task<Void, Never>?

  func start(launchedAtLogin: Bool) {
    LaunchAtLogin.migrateLegacyLaunchAgent()
    if preferences.trayEnabled {
      createStatusItem()
    }
    if !(launchedAtLogin && preferences.trayEnabled) {
      openMainWindow()
    }
    Task { await refreshTrayOnLaunch() }
  }

  func openMainWindow() {
    if mainWindow == nil {
      mainWindow = MainWindowController(
        handleRequest: { [unowned self] method, params in
          try await handle(method: method, params: params)
        },
        onClose: { [unowned self] in mainWindowClosed() }
      )
    }
    NSApp.setActivationPolicy(.regular)
    mainWindow?.show()
    // Cooperative NSApp.activate() is declined when opened from the menu bar item,
    // as another app is still active.
    NSApp.activate(ignoringOtherApps: true)
  }

  func openSettings() {
    openMainWindow()
    mainWindow?.showSettings()
  }

  /// Keep running in the menu bar after the window closes; quit when there is no menu bar item.
  var shouldTerminateAfterLastWindowClosed: Bool { !preferences.trayEnabled }

  private func mainWindowClosed() {
    mainWindow = nil
    NSApp.setActivationPolicy(.accessory)
  }

  // MARK: - Bridge

  private func handle(method: String, params: [String: Any]) async throws -> String? {
    switch method {
    case "analyzeOvertime":
      let data = try await analyzeFromDashboard(
        apiKey: params["apiKey"] as? String ?? "",
        startDate: params["startDate"] as? String ?? "",
        endDate: params["endDate"] as? String ?? ""
      )
      return try json(data)
    case "closeApp":
      mainWindow?.close()
      return nil
    case "setContentMaxHeight":
      if let height = params["height"] as? Double {
        mainWindow?.setPageMaxHeight(height)
      }
      return nil
    case "getLaunchAtLogin":
      return try json(["enabled": LaunchAtLogin.isEnabled])
    case "setLaunchAtLogin":
      try LaunchAtLogin.setEnabled(params["enabled"] as? Bool ?? false)
      return nil
    case "getTrayEnabled":
      return try json(["enabled": preferences.trayEnabled])
    case "setTrayEnabled":
      setTrayEnabled(params["enabled"] as? Bool ?? true)
      return nil
    case "getStoredApiKey":
      return try json(["apiKey": Keychain.loadApiKey()])
    case "setStoredApiKey":
      try Keychain.storeApiKey(params["apiKey"] as? String ?? "")
      return nil
    case "clearStoredApiKey":
      Keychain.clearApiKey()
      store.clear()
      currentApiKey = nil
      stopTrayRefresh()
      setTrayTitle("--")
      return nil
    default:
      throw ClockifyError(message: "Unknown method: \(method)")
    }
  }

  private func json(_ value: some Encodable) throws -> String {
    String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
  }

  // MARK: - Overtime

  private func analyzeFromDashboard(apiKey: String, startDate: PlainDate, endDate: PlainDate)
    async throws -> OvertimeData
  {
    let apiKey = apiKey.trimmingCharacters(in: .whitespaces)
    let data = try await analyze(apiKey: apiKey, startDate: startDate, endDate: endDate)
    if apiKey != currentApiKey {
      try Keychain.storeApiKey(apiKey)
    }
    currentApiKey = apiKey
    // The tray uses the same range start as the dashboard.
    preferences.startDate = startDate
    preferences.save()
    startTrayRefresh()
    return data
  }

  private func analyze(apiKey: String, startDate: PlainDate, endDate: PlainDate) async throws
    -> OvertimeData
  {
    guard !apiKey.isEmpty else {
      throw ClockifyError(message: "Please provide your Clockify API key.")
    }
    guard let startYear = Int(startDate.prefix(4)), let endYear = Int(endDate.prefix(4)),
      startYear >= 1970, endYear <= 3000
    else {
      throw ClockifyError(message: "Please provide valid start and end dates.")
    }
    let secondsPerDay = try await store.secondsPerDay(
      apiKey: apiKey, startDate: startDate, endDate: endDate)
    let data = try OvertimeReport.build(
      secondsPerDay: secondsPerDay, startDate: startDate, endDate: endDate)
    setTrayTitle(Self.formatTrayTitle(totalSeconds: data.totalOvertimeSeconds))
    return data
  }

  private func refreshTray() async {
    guard let apiKey = currentApiKey else { return }
    let year = Calendar.current.component(.year, from: Date())
    let startDate = preferences.startDate ?? String(format: "%04d-01-01", year)
    do {
      _ = try await analyze(apiKey: apiKey, startDate: startDate, endDate: PlainDates.todayUTC())
    } catch {
      print("Tray refresh failed:", error.localizedDescription)
    }
  }

  private func refreshTrayOnLaunch() async {
    guard let apiKey = Keychain.loadApiKey() else { return }
    currentApiKey = apiKey
    await refreshTray()
    startTrayRefresh()
  }

  // MARK: - Tray

  private func createStatusItem() {
    guard statusItem == nil else { return }
    statusItem = StatusItemController(title: trayTitle) { [unowned self] in openMainWindow() }
  }

  private func setTrayEnabled(_ enabled: Bool) {
    preferences.trayEnabled = enabled
    preferences.save()
    if enabled {
      createStatusItem()
      startTrayRefresh()
    } else {
      stopTrayRefresh()
      statusItem?.remove()
      statusItem = nil
    }
  }

  private func setTrayTitle(_ title: String) {
    trayTitle = title
    statusItem?.setTitle(title)
  }

  private func startTrayRefresh() {
    guard preferences.trayEnabled, currentApiKey != nil else { return }
    trayRefreshTask?.cancel()
    trayRefreshTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.trayRefreshInterval)
        guard !Task.isCancelled else { return }
        await self?.refreshTray()
      }
    }
  }

  private func stopTrayRefresh() {
    trayRefreshTask?.cancel()
    trayRefreshTask = nil
  }

  private static func formatTrayTitle(totalSeconds: Int) -> String {
    let totalMinutes = totalSeconds / 60
    let sign = totalMinutes >= 0 ? "+" : "-"
    let hours = abs(totalMinutes) / 60
    let minutes = abs(totalMinutes) % 60
    return minutes > 0 ? "\(sign)\(hours)h \(minutes)m" : "\(sign)\(hours)h"
  }
}
