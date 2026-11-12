import AppKit

final class AppController {
  private static let trayRefreshInterval: Duration = .seconds(60)

  private var preferences = Preferences.load()
  private let store = TimeEntryStore(cacheFile: Paths.timeEntryCache)
  private var currentApiKey: String?
  private var server: TrackingServer?
  private var runningEntry: TrackedEntry?
  private var overtimeTitle = "--"
  private var trayTitle = "--"
  private var statusItem: StatusItemController?
  private var mainWindow: MainWindowController?
  private var trayRefreshTask: Task<Void, Never>?
  private var elapsedTitleTask: Task<Void, Never>?

  func start(launchedAtLogin: Bool) {
    LaunchAtLogin.migrateLegacyLaunchAgent()
    server = Self.loadServer(preferences)
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
    case "getSetupState":
      return try json([
        "configured": server != nil || Keychain.loadApiKey() != nil,
        "tracking": server != nil,
      ])
    case "getServerSettings":
      return try json(
        ServerSettings(
          url: preferences.serverURL, username: preferences.serverUsername,
          signedIn: server != nil))
    case "signInToServer":
      try await signInToServer(
        url: params["url"] as? String ?? "", username: params["username"] as? String ?? "",
        password: params["password"] as? String ?? "")
      return nil
    case "signOutOfServer":
      await signOutOfServer()
      return nil
    case "getTimer":
      if let server { runningEntry = try await server.runningTimer() }
      updateTrayTitle()
      return try json(["running": runningEntry])
    case "startTimer", "stopTimer", "discardTimer":
      try await timerAction(method)
      return try json(["running": runningEntry])
    case "listEntries":
      let server = try requireServer()
      let (from, to) = try Self.localRange(
        params["startDate"] as? String ?? "", params["endDate"] as? String ?? "")
      return try json(try await server.entries(from: from, to: to))
    case "saveEntry":
      let server = try requireServer()
      let start = params["start"] as? String ?? ""
      let end = params["end"] as? String
      let entry =
        if let id = params["id"] as? String {
          try await server.update(id: id, start: start, end: end)
        } else {
          try await server.create(start: start, end: end)
        }
      Task { await refreshTray() }
      return try json(entry)
    case "deleteEntry":
      try await requireServer().delete(id: params["id"] as? String ?? "")
      Task { await refreshTray() }
      return nil
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
      try? await server?.signOut()
      Keychain.clearServerToken()
      preferences.serverURL = nil
      preferences.serverUsername = nil
      preferences.save()
      server = nil
      runningEntry = nil
      store.clear()
      currentApiKey = nil
      stopTrayRefresh()
      setOvertimeTitle("--")
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
    if let server {
      let data = try await analyze(server: server, startDate: startDate, endDate: endDate)
      preferences.startDate = startDate
      preferences.save()
      startTrayRefresh()
      return data
    }
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
    setOvertimeTitle(Self.formatTrayTitle(totalSeconds: data.totalOvertimeSeconds))
    return data
  }

  private func analyze(server: TrackingServer, startDate: PlainDate, endDate: PlainDate)
    async throws -> OvertimeData
  {
    let (from, to) = try Self.localRange(startDate, endDate)
    let entries = try await server.entries(from: from, to: to)
    runningEntry = entries.first { $0.end == nil }
    let data = try OvertimeReport.build(
      secondsPerDay: TrackingServer.secondsPerDay(entries), startDate: startDate,
      endDate: endDate)
    setOvertimeTitle(Self.formatTrayTitle(totalSeconds: data.totalOvertimeSeconds))
    return data
  }

  private func refreshTray() async {
    let year = Calendar.current.component(.year, from: Date())
    let startDate = preferences.startDate ?? String(format: "%04d-01-01", year)
    do {
      if let server {
        let today = PlainDates.formatLocal(Date())
        _ = try await analyze(server: server, startDate: startDate, endDate: today)
      } else if let apiKey = currentApiKey {
        _ = try await analyze(apiKey: apiKey, startDate: startDate, endDate: PlainDates.todayUTC())
      }
    } catch {
      print("Tray refresh failed:", error.localizedDescription)
    }
  }

  private func refreshTrayOnLaunch() async {
    currentApiKey = Keychain.loadApiKey()
    guard server != nil || currentApiKey != nil else { return }
    await refreshTray()
    startTrayRefresh()
  }

  // MARK: - Time tracking

  /// Signed in when there is a session token; the address alone is kept after signing out.
  private static func loadServer(_ preferences: Preferences) -> TrackingServer? {
    guard let url = preferences.serverURL.flatMap(URL.init(string:)),
      let token = Keychain.loadServerToken()
    else { return nil }
    return TrackingServer(baseURL: url, token: token)
  }

  private func requireServer() throws -> TrackingServer {
    guard let server else {
      throw ClockifyError(message: "No time tracking server is set up.")
    }
    return server
  }

  private struct ServerSettings: Encodable {
    let url: String?
    let username: String?
    let signedIn: Bool
  }

  private func signInToServer(url: String, username: String, password: String) async throws {
    let url = url.trimmingCharacters(in: .whitespaces)
    let username = username.trimmingCharacters(in: .whitespaces)
    guard let baseURL = URL(string: url), ["http", "https"].contains(baseURL.scheme ?? "") else {
      throw ClockifyError(message: "Enter the server address, e.g. http://192.168.1.10:8787")
    }
    guard !username.isEmpty, !password.isEmpty else {
      throw ClockifyError(message: "Enter your username and password.")
    }
    let token = try await TrackingServer.signIn(
      baseURL: baseURL, username: username, password: password)
    try Keychain.storeServerToken(token)
    preferences.serverURL = url
    preferences.serverUsername = username
    preferences.save()
    server = TrackingServer(baseURL: baseURL, token: token)
    runningEntry = try? await server?.runningTimer()
    await refreshTray()
    startTrayRefresh()
  }

  /// Switches back to Clockify. Keeps the address and username to make signing in again easy.
  private func signOutOfServer() async {
    try? await server?.signOut()
    Keychain.clearServerToken()
    server = nil
    runningEntry = nil
    updateTrayTitle()
    stopTrayRefresh()
    setOvertimeTitle("--")
    await refreshTrayOnLaunch()
  }

  private func timerAction(_ action: String) async throws {
    let server = try requireServer()
    switch action {
    case "startTimer":
      runningEntry = try await server.startTimer()
    case "stopTimer":
      try await server.stopTimer()
      runningEntry = nil
    default:
      if let running = try await server.runningTimer() {
        try await server.delete(id: running.id)
      }
      runningEntry = nil
    }
    updateTrayTitle()
    mainWindow?.notifyTrackingChanged()
    await refreshTray()
  }

  private func runTimerAction(_ action: String) {
    Task {
      do {
        try await timerAction(action)
      } catch {
        let alert = NSAlert()
        alert.messageText = "Time tracking failed"
        alert.informativeText = error.localizedDescription
        alert.runModal()
      }
    }
  }

  private func timerMenuItems() -> [NSMenuItem] {
    guard server != nil else { return [] }
    if let running = runningEntry {
      return [
        MenuAction.item("Stop timer (\(Self.formatElapsed(running.seconds)))", key: "") {
          [unowned self] in runTimerAction("stopTimer")
        },
        MenuAction.item("Discard timer", key: "") { [unowned self] in
          runTimerAction("discardTimer")
        },
      ]
    }
    return [
      MenuAction.item("Start timer", key: "") { [unowned self] in runTimerAction("startTimer") }
    ]
  }

  /// Midnight at the start of `startDate` to midnight after `endDate`, in the Mac's time zone.
  private static func localRange(_ startDate: PlainDate, _ endDate: PlainDate) throws -> (
    Date, Date
  ) {
    guard let from = PlainDates.parseLocal(startDate),
      let lastDay = PlainDates.parseLocal(endDate),
      let to = Calendar.current.date(byAdding: .day, value: 1, to: lastDay)
    else {
      throw ClockifyError(message: "Invalid date format, expected YYYY-MM-DD")
    }
    return (from, to)
  }

  private static func formatElapsed(_ seconds: Double) -> String {
    let minutes = Int(seconds) / 60
    return String(format: "%d:%02d", minutes / 60, minutes % 60)
  }

  // MARK: - Tray

  private func createStatusItem() {
    guard statusItem == nil else { return }
    statusItem = StatusItemController(
      title: trayTitle,
      extraMenuItems: { [unowned self] in timerMenuItems() },
      onOpen: { [unowned self] in openMainWindow() }
    )
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

  private func setOvertimeTitle(_ title: String) {
    overtimeTitle = title
    updateTrayTitle()
  }

  /// A running timer shows as a dot and its length in front of the overtime.
  private func updateTrayTitle() {
    if let running = runningEntry {
      trayTitle = "● \(Self.formatElapsed(running.seconds)) · \(overtimeTitle)"
      if elapsedTitleTask == nil {
        elapsedTitleTask = Task { [weak self] in
          while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            self?.updateTrayTitle()
          }
        }
      }
    } else {
      trayTitle = overtimeTitle
      elapsedTitleTask?.cancel()
      elapsedTitleTask = nil
    }
    statusItem?.setTitle(trayTitle)
  }

  private func startTrayRefresh() {
    guard preferences.trayEnabled, server != nil || currentApiKey != nil else { return }
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
