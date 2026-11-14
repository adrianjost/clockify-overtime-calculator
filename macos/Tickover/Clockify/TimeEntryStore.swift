import CryptoKit
import Foundation

/// Cache of Clockify time entries shared by the tray and the dashboard, and
/// persisted to disk so restarting the app does not refetch the full history.
///
/// Clockify's API limits are tight, so requests are kept to a minimum:
/// - The active user is fetched once per API key (and persisted).
/// - The full requested range is fetched only when nothing is cached yet, and
///   again every `fullRefreshInterval` to pick up edits to old entries.
/// - The last `recentWindowDays` days are refetched on app start and then daily.
/// - The last `liveWindowDays` days are refetched every `liveRefreshInterval`
///   so starting/stopping the timer shows up in the tray (12 requests / hour).
/// - Widening the range into the past only fetches the newly added days.
/// - Running timers are computed locally, so the tray keeps ticking without API calls.
/// - If a refresh fails (e.g. rate limited) but the range is cached, cached data is used.
final class TimeEntryStore {
  private static let recentWindowDays = 14
  private static let recentRefreshInterval: TimeInterval = 24 * 60 * 60
  private static let liveWindowDays = 2  // today + yesterday, for timers running past midnight
  private static let liveRefreshInterval: TimeInterval = 5 * 60
  private static let fullRefreshInterval: TimeInterval = 7 * 24 * 60 * 60
  private static let cacheFileVersion = 1

  struct DateRange: Codable {
    var start: PlainDate
    var end: PlainDate
  }

  private struct PersistedCache: Codable {
    let version: Int
    let apiKeyHash: String
    let user: ActiveUser?
    let entries: [TimeEntry]
    let covered: DateRange?
    let lastFullRefresh: Double  // epoch milliseconds
  }

  private final class CacheState {
    let apiKey: String
    var user: ActiveUser?
    var entries: [String: TimeEntry] = [:]
    var covered: DateRange?
    var lastRecentRefresh: Date = .distantPast
    var lastLiveRefresh: Date = .distantPast
    var lastFullRefresh: Date = .distantPast

    init(apiKey: String) {
      self.apiKey = apiKey
    }
  }

  private let cacheFile: URL
  private var state: CacheState?
  // Serializes refreshes so concurrent callers (tray + dashboard) share one fetch.
  private var queue: Task<Void, Never>?

  init(cacheFile: URL) {
    self.cacheFile = cacheFile
  }

  /// Seconds worked per day in the given range, using cached data where possible.
  func secondsPerDay(apiKey: String, startDate: PlainDate, endDate: PlainDate) async throws
    -> [PlainDate: Double]
  {
    let range = DateRange(start: min(startDate, endDate), end: max(startDate, endDate))
    let previous = queue
    let task = Task { () throws -> [PlainDate: Double] in
      await previous?.value
      return try await self.load(apiKey: apiKey, range: range)
    }
    queue = Task { _ = try? await task.value }
    return try await task.value
  }

  func clear() {
    state = nil
    try? FileManager.default.removeItem(at: cacheFile)
  }

  private func load(apiKey: String, range: DateRange) async throws -> [PlainDate: Double] {
    if state?.apiKey != apiKey {
      state = loadState(apiKey: apiKey)
    }
    let cache = state!

    do {
      if try await refresh(cache, range: range) {
        saveState(cache)
      }
    } catch {
      guard isCovered(cache, range) else { throw error }
      print("Clockify refresh failed, using cached data:", error.localizedDescription)
    }

    var secondsPerDay: [PlainDate: Double] = [:]
    for entry in cache.entries.values {
      let date = entry.date
      guard date >= range.start, date <= range.end else { continue }
      secondsPerDay[date, default: 0] += entry.seconds
    }
    return secondsPerDay
  }

  private func refresh(_ cache: CacheState, range: DateRange) async throws -> Bool {
    let now = Date()
    let today = PlainDates.todayUTC()
    // Always fetch up to today, so days that were still in the future at fetch
    // time are known to be empty and don't need their own request later.
    let fetchEnd = max(range.end, today)

    guard var covered = cache.covered,
      now.timeIntervalSince(cache.lastFullRefresh) < Self.fullRefreshInterval
    else {
      let full = DateRange(start: range.start, end: fetchEnd)
      let fresh = try await fetchRange(cache, full)
      cache.entries = Dictionary(fresh.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
      cache.covered = full
      cache.lastFullRefresh = now
      cache.lastRecentRefresh = now
      cache.lastLiveRefresh = now
      return true
    }
    defer { cache.covered = covered }

    var fetched = false

    // Range widened into the past: only fetch the missing days.
    if range.start < covered.start {
      let missing = DateRange(start: range.start, end: PlainDates.addDays(covered.start, -1))
      replaceRange(cache, missing, try await fetchRange(cache, missing))
      covered.start = range.start
      fetched = true
    }

    let recentStart = max(covered.start, PlainDates.addDays(today, -(Self.recentWindowDays - 1)))
    let liveStart = max(covered.start, PlainDates.addDays(today, -(Self.liveWindowDays - 1)))
    let isRecentDue = now.timeIntervalSince(cache.lastRecentRefresh) >= Self.recentRefreshInterval
    let isLiveDue =
      isRecentDue || now.timeIntervalSince(cache.lastLiveRefresh) >= Self.liveRefreshInterval
    let refreshStart = isRecentDue ? recentStart : liveStart

    if range.end > covered.end {
      let gapStart = PlainDates.addDays(covered.end, 1)
      let lastFetchDate =
        cache.lastLiveRefresh == .distantPast ? "" : PlainDates.format(cache.lastLiveRefresh)
      if covered.end >= lastFetchDate && !isLiveDue {
        // The missing days (e.g. after midnight) were in the future when we last
        // fetched, so they were empty then. The next live refresh picks them up.
        covered.end = range.end
      } else if gapStart < refreshStart {
        // Gap reaches outside the window refreshed below: fetch it explicitly.
        let missing = DateRange(start: gapStart, end: fetchEnd)
        replaceRange(cache, missing, try await fetchRange(cache, missing))
        covered.end = fetchEnd
        fetched = true
      } else {
        covered.end = fetchEnd
      }
    }

    // Refresh the live window (every few minutes) or the larger recent window
    // (on start and daily), where entries are typically added or edited.
    if isLiveDue {
      let end = max(covered.end, today)
      let window = DateRange(start: min(refreshStart, end), end: end)
      replaceRange(cache, window, try await fetchRange(cache, window))
      covered.end = end
      cache.lastLiveRefresh = now
      if isRecentDue { cache.lastRecentRefresh = now }
      fetched = true
    }

    return fetched
  }

  private func fetchRange(_ cache: CacheState, _ range: DateRange) async throws -> [TimeEntry] {
    let user: ActiveUser
    if let cached = cache.user {
      user = cached
    } else {
      user = try await ClockifyAPI.fetchActiveUser(apiKey: cache.apiKey)
      cache.user = user
    }
    return try await ClockifyAPI.fetchTimeEntries(
      apiKey: cache.apiKey, user: user, from: range.start, to: range.end)
  }

  /// Removing first ensures entries deleted in Clockify disappear from the cache.
  private func replaceRange(_ cache: CacheState, _ range: DateRange, _ fresh: [TimeEntry]) {
    cache.entries = cache.entries.filter { _, entry in
      entry.date < range.start || entry.date > range.end
    }
    for entry in fresh {
      cache.entries[entry.id] = entry
    }
  }

  private func isCovered(_ cache: CacheState, _ range: DateRange) -> Bool {
    guard let covered = cache.covered else { return false }
    return covered.start <= range.start && covered.end >= range.end
  }

  private func hash(_ apiKey: String) -> String {
    SHA256.hash(data: Data(apiKey.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private func loadState(apiKey: String) -> CacheState {
    let cache = CacheState(apiKey: apiKey)
    guard let data = try? Data(contentsOf: cacheFile),
      let persisted = try? JSONDecoder().decode(PersistedCache.self, from: data),
      persisted.version == Self.cacheFileVersion,
      persisted.apiKeyHash == hash(apiKey)
    else { return cache }
    cache.user = persisted.user
    cache.entries = Dictionary(
      persisted.entries.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    cache.covered = persisted.covered
    // Recent/live refresh times are not persisted on purpose: refresh once per app start.
    cache.lastFullRefresh = Date(timeIntervalSince1970: persisted.lastFullRefresh / 1000)
    return cache
  }

  private func saveState(_ cache: CacheState) {
    let persisted = PersistedCache(
      version: Self.cacheFileVersion,
      apiKeyHash: hash(cache.apiKey),
      user: cache.user,
      entries: Array(cache.entries.values),
      covered: cache.covered,
      lastFullRefresh: cache.lastFullRefresh.timeIntervalSince1970 * 1000
    )
    do {
      try FileManager.default.createDirectory(
        at: cacheFile.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(persisted).write(to: cacheFile, options: .atomic)
    } catch {
      print("Failed to persist time entry cache:", error.localizedDescription)
    }
  }
}
