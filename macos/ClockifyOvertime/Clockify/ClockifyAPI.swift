import Foundation

struct ActiveUser: Codable {
  let id: String
  let defaultWorkspace: String
}

struct TimeEntry: Codable {
  struct TimeInterval: Codable {
    let start: String
    let duration: String?

    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(start, forKey: .start)
      try container.encode(duration, forKey: .duration)  // null for running timers
    }
  }

  let id: String
  let timeInterval: TimeInterval

  /// The (UTC) calendar day an entry is attributed to.
  var date: PlainDate { String(timeInterval.start.prefix(10)) }

  /// Running timers (no duration yet) count until now.
  var seconds: Double {
    if let duration = timeInterval.duration {
      return ISO8601Duration.seconds(duration) ?? 0
    }
    guard let start = ISO8601Instant.parse(timeInterval.start) else { return 0 }
    return max(0, Date().timeIntervalSince(start))
  }
}

struct RateLimitError: LocalizedError {
  let retryAt: Date

  var errorDescription: String? {
    let time = retryAt.formatted(date: .omitted, time: .standard)
    return "Clockify rate limit reached. Retrying after \(time)."
  }
}

struct ClockifyError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

enum ClockifyAPI {
  private static let baseURL = "https://api.clockify.me/api/v1"
  private static let timeEntriesPageSize = 5000

  private static let maxAttempts = 3
  private static let retryBaseDelay: Double = 2
  private static let requestTimeout: TimeInterval = 15
  // Free Clockify workspaces are limited to 30 requests per hour, so after a 429
  // we pause all requests for a while instead of retrying (retries burn quota).
  private static let rateLimitMinCooldown: TimeInterval = 5 * 60
  private static let rateLimitMaxCooldown: TimeInterval = 60 * 60

  private static var rateLimitedUntil = Date.distantPast

  private static let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = requestTimeout
    return URLSession(configuration: configuration)
  }()

  static func fetchActiveUser(apiKey: String) async throws -> ActiveUser {
    let (data, response) = try await get("\(baseURL)/user", apiKey: apiKey)
    guard (200..<300).contains(response.statusCode) else {
      throw ClockifyError(message: "Failed to fetch active user: \(text(data))")
    }
    return try JSONDecoder().decode(ActiveUser.self, from: data)
  }

  static func fetchTimeEntries(
    apiKey: String, user: ActiveUser, from: PlainDate, to: PlainDate
  ) async throws -> [TimeEntry] {
    let start = "\(from)T00:00:00.000Z"
    let end = "\(to)T23:59:59.000Z"
    var entries: [TimeEntry] = []
    var page = 1
    while true {
      let url =
        "\(baseURL)/workspaces/\(user.defaultWorkspace)/user/\(user.id)/time-entries"
        + "?start=\(start)&end=\(end)&page-size=\(timeEntriesPageSize)&page=\(page)"
      let (data, response) = try await get(url, apiKey: apiKey)
      guard (200..<300).contains(response.statusCode) else {
        throw ClockifyError(
          message: "Failed to fetch time entries (page \(page)): \(text(data))")
      }
      let pageEntries = try JSONDecoder().decode([TimeEntry].self, from: data)
      entries.append(contentsOf: pageEntries)
      if pageEntries.count != timeEntriesPageSize { break }
      page += 1
    }
    return entries
  }

  /// - Client errors (4xx except 429) are returned immediately; retrying them only burns quota.
  /// - 429 puts all further requests on hold for a cooldown (honoring Retry-After).
  /// - 5xx and network errors are retried with exponential backoff.
  private static func get(_ url: String, apiKey: String) async throws -> (Data, HTTPURLResponse) {
    if Date() < rateLimitedUntil {
      throw RateLimitError(retryAt: rateLimitedUntil)
    }
    guard let requestURL = URL(string: url) else {
      throw ClockifyError(message: "Invalid URL: \(url)")
    }
    var request = URLRequest(url: requestURL)
    request.setValue(apiKey, forHTTPHeaderField: "X-Api-Key")

    var lastError: Error?
    for attempt in 0..<maxAttempts {
      let isLastAttempt = attempt == maxAttempts - 1
      do {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
          throw ClockifyError(message: "Unexpected response from \(url)")
        }
        if http.statusCode == 429 {
          let cooldown = min(
            max(retryAfter(http) ?? 0, rateLimitMinCooldown), rateLimitMaxCooldown)
          rateLimitedUntil = Date().addingTimeInterval(cooldown)
          throw RateLimitError(retryAt: rateLimitedUntil)
        }
        if http.statusCode < 500 || isLastAttempt {
          return (data, http)
        }
        lastError = ClockifyError(message: "HTTP \(http.statusCode)")
      } catch let error as RateLimitError {
        throw error
      } catch {
        if isLastAttempt { throw error }
        lastError = error
      }
      let delay = retryBaseDelay * pow(2, Double(attempt))
      try await Task.sleep(for: .seconds(delay))
    }
    throw ClockifyError(
      message:
        "Failed to fetch \(url) after \(maxAttempts) attempts: \(lastError?.localizedDescription ?? "unknown error")"
    )
  }

  private static func retryAfter(_ response: HTTPURLResponse) -> TimeInterval? {
    guard let header = response.value(forHTTPHeaderField: "Retry-After") else { return nil }
    if let seconds = Double(header) { return max(0, seconds) }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    if let date = formatter.date(from: header) { return max(0, date.timeIntervalSinceNow) }
    return nil
  }

  private static func text(_ data: Data) -> String {
    String(decoding: data, as: UTF8.self)
  }
}

enum ISO8601Instant {
  private static let plain: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()

  private static let fractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  static func parse(_ value: String) -> Date? {
    plain.date(from: value) ?? fractional.date(from: value)
  }

  static func format(_ date: Date) -> String {
    fractional.string(from: date)
  }
}

enum ISO8601Duration {
  /// Parses durations like `PT8H30M`, `PT45.5S` or `P1DT2H` into seconds.
  static func seconds(_ value: String) -> Double? {
    var rest = Substring(value)
    let negative = rest.hasPrefix("-")
    if negative { rest = rest.dropFirst() }
    guard rest.hasPrefix("P") else { return nil }
    rest = rest.dropFirst()

    var total: Double = 0
    var number = ""
    var inTime = false
    for character in rest {
      switch character {
      case "T":
        inTime = true
      case "0"..."9", ".", ",":
        number.append(character == "," ? "." : character)
      default:
        guard let amount = Double(number) else { return nil }
        number = ""
        switch (character, inTime) {
        case ("W", false): total += amount * 7 * 86400
        case ("D", false): total += amount * 86400
        case ("H", true): total += amount * 3600
        case ("M", true): total += amount * 60
        case ("S", true): total += amount
        default: return nil
        }
      }
    }
    guard number.isEmpty else { return nil }
    return negative ? -total : total
  }
}
