import Foundation
import Security

enum Paths {
  static let stateDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".clockify-overtime", isDirectory: true)
  static let preferences = stateDirectory.appendingPathComponent("preferences.json")
  static let timeEntryCache = stateDirectory.appendingPathComponent("time-entries-cache.json")
}

struct Preferences: Codable {
  var trayEnabled: Bool = true
  var startDate: PlainDate?

  init() {}

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    trayEnabled = try container.decodeIfPresent(Bool.self, forKey: .trayEnabled) ?? true
    startDate = try container.decodeIfPresent(PlainDate.self, forKey: .startDate)
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
  private static let service = "dev.adrianjost.clockify-overtime"
  private static let account = "clockify-api-key"

  private static var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  static func loadApiKey() -> String? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    else { return nil }
    let apiKey = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespaces)
    return apiKey.isEmpty ? nil : apiKey
  }

  static func storeApiKey(_ apiKey: String) throws {
    let data = Data(apiKey.trimmingCharacters(in: .whitespaces).utf8)
    let status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = query
      item[kSecValueData as String] = data
      let addStatus = SecItemAdd(item as CFDictionary, nil)
      guard addStatus == errSecSuccess else { throw keychainError(addStatus) }
    } else if status != errSecSuccess {
      throw keychainError(status)
    }
  }

  static func clearApiKey() {
    SecItemDelete(query as CFDictionary)
  }

  private static func keychainError(_ status: OSStatus) -> Error {
    let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
    return ClockifyError(message: "Could not securely store API key: \(message)")
  }
}
