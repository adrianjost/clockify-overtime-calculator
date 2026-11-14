import Foundation
import Security

enum Paths {
  static let stateDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".tickover", isDirectory: true)
  static let preferences = stateDirectory.appendingPathComponent("preferences.json")
  static let timeEntryCache = stateDirectory.appendingPathComponent("time-entries-cache.json")
}

struct Preferences: Codable {
  var trayEnabled: Bool = true
  /// Whether the running timer in the menu bar ticks every second.
  var trayShowsSeconds: Bool = false
  /// "light" or "dark" to override the system appearance; nil follows the system.
  var theme: String?
  /// Whether the time entries are shown next to the dashboard.
  var entriesSidebar: Bool = true
  var startDate: PlainDate?
  /// Where time entries come from: "clockify" or "server". Both can be set up at once.
  var dataSource: String?
  var serverURL: String?
  var serverUsername: String?

  init() {}

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    trayEnabled = try container.decodeIfPresent(Bool.self, forKey: .trayEnabled) ?? true
    trayShowsSeconds =
      try container.decodeIfPresent(Bool.self, forKey: .trayShowsSeconds) ?? false
    theme = try container.decodeIfPresent(String.self, forKey: .theme)
    entriesSidebar = try container.decodeIfPresent(Bool.self, forKey: .entriesSidebar) ?? true
    startDate = try container.decodeIfPresent(PlainDate.self, forKey: .startDate)
    dataSource = try container.decodeIfPresent(String.self, forKey: .dataSource)
    serverURL = try container.decodeIfPresent(String.self, forKey: .serverURL)
    serverUsername = try container.decodeIfPresent(String.self, forKey: .serverUsername)
  }

  static func load() -> Preferences {
    guard let data = try? Data(contentsOf: Paths.preferences),
      let preferences = try? JSONDecoder().decode(Preferences.self, from: data)
    else { return Preferences() }
    return preferences
  }

  func save() {
    do {
      try FileManager.default.createDirectory(
        at: Paths.stateDirectory, withIntermediateDirectories: true)
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      try encoder.encode(self).write(to: Paths.preferences, options: .atomic)
    } catch {
      print("Failed to persist preferences:", error.localizedDescription)
    }
  }
}

enum Keychain {
  private static let service = "dev.adrianjost.tickover"
  private static let apiKeyAccount = "clockify-api-key"
  private static let serverTokenAccount = "server-token"

  static func loadApiKey() -> String? { load(apiKeyAccount) }
  static func storeApiKey(_ apiKey: String) throws { try store(apiKey, apiKeyAccount) }
  static func clearApiKey() { clear(apiKeyAccount) }

  static func loadServerToken() -> String? { load(serverTokenAccount) }
  static func storeServerToken(_ token: String) throws { try store(token, serverTokenAccount) }
  static func clearServerToken() { clear(serverTokenAccount) }

  private static func query(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  private static func load(_ account: String) -> String? {
    var request = query(account)
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    else { return nil }
    let value = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespaces)
    return value.isEmpty ? nil : value
  }

  private static func store(_ value: String, _ account: String) throws {
    let data = Data(value.trimmingCharacters(in: .whitespaces).utf8)
    let status = SecItemUpdate(
      query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = query(account)
      item[kSecValueData as String] = data
      let addStatus = SecItemAdd(item as CFDictionary, nil)
      guard addStatus == errSecSuccess else { throw keychainError(addStatus) }
    } else if status != errSecSuccess {
      throw keychainError(status)
    }
  }

  private static func clear(_ account: String) {
    SecItemDelete(query(account) as CFDictionary)
  }

  private static func keychainError(_ status: OSStatus) -> Error {
    let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
    return ClockifyError(message: "Could not store the secret in the Keychain: \(message)")
  }
}
