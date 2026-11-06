# Clockify Overtime Desktop App

Native macOS menu bar app that shows your Clockify overtime.

## Features

- Enter your Clockify API key in-app (stored in the macOS Keychain)
- Analyze overtime for a custom date range
- Zoomable daily/weekly chart with cumulative overtime
- Menu bar item with periodic overtime updates
- Launch at login

## How it works

- `macos/`: the native app (Swift, AppKit). It owns the menu bar item, the window, the Keychain,
  launch at login, and fetching/caching Clockify time entries (`macos/ClockifyOvertime/Clockify`).
- `src/mainview/`: the dashboard UI (HTML/CSS/TypeScript), shown in a `WKWebView`. It talks to the
  native app through `src/mainview/bridge.ts`; the available requests are typed in `src/shared/rpc.ts`.

The Xcode build bundles the web UI with Bun (`scripts/build-web.sh`), so the app has no runtime
dependencies.

App data lives in `~/.clockify-overtime/` (preferences and a time entry cache).

## Prerequisites

- macOS 14 or later
- Xcode
- Bun: https://bun.sh/docs/installation
- For regenerating icons: `brew install librsvg` (or ImageMagick)

## Setup

```sh
bun run setup
```

This installs dev dependencies and the pre-commit hook (formatting via oxfmt).

## Run (Development)

Open `macos/ClockifyOvertime.xcodeproj` in Xcode and press Run.

Debug builds enable the Web Inspector for the dashboard (Safari → Develop menu).

## Build

```sh
bun run build
```

The app is written to `build/DerivedData/Build/Products/Release/Clockify Overtime.app`.

Other commands:

- `bun run typecheck`: type-check the web UI
- `bun run format`: format source
- `bun run generate-icons`: regenerate the app icon from `icon-source.svg`

## Signing and distribution

Local builds are ad-hoc signed, so the app is blocked by Gatekeeper on other Macs.

Debug builds are signed with a designated requirement that only checks the bundle identifier
(`macos/DebugSigning.req`). Choosing "Always Allow" on the Keychain prompt once therefore holds
across rebuilds. Release builds keep the default requirement.

To distribute, set your team under Signing & Capabilities in Xcode (Developer ID Application),
then archive and notarize via Product → Archive → Distribute App → Direct Distribution.

Launch at login only replaces the LaunchAgent of older versions when the app runs from
`/Applications`.
