import Foundation

/// Calendar day as `YYYY-MM-DD`. String comparison equals date comparison.
typealias PlainDate = String

enum PlainDates {
  private static let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }()

  private static let formatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.calendar = utc
    formatter.timeZone = utc.timeZone
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter
  }()

  static func parse(_ value: PlainDate) -> Date? {
    guard value.count == 10 else { return nil }
    return formatter.date(from: value)
  }

  static func format(_ date: Date) -> PlainDate {
    formatter.string(from: date)
  }

  static func todayUTC() -> PlainDate {
    format(Date())
  }

  static func addDays(_ value: PlainDate, _ days: Int) -> PlainDate {
    guard let date = parse(value), let shifted = utc.date(byAdding: .day, value: days, to: date)
    else { return value }
    return format(shifted)
  }

  static func isWeekend(_ value: PlainDate) -> Bool {
    guard let date = parse(value) else { return false }
    let weekday = utc.component(.weekday, from: date)
    return weekday == 1 || weekday == 7
  }
}
