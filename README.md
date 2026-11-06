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
- Xcode (the full app from the App Store; the Command Line Tools alone are not enough)
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

## Install

There are no prebuilt downloads, so build the app yourself (see Prerequisites and Build), then:

1. Move `Clockify Overtime.app` from `build/DerivedData/Build/Products/Release/` to `/Applications`.
2. Open it. On first launch it shows the settings.
3. Create a Clockify API key: in Clockify, open your profile menu → Preferences → Advanced →
   Manage API keys → Generate new, and copy the key (it is only shown once).
4. Paste the key into the Clockify API Key field. It is stored in the Keychain.
5. Close the settings. The dashboard shows your overtime from the start of the year (change it
   with From/To), and the menu bar shows the total. Enable Launch at login in the settings if
   you like.

To update, pull the latest changes, build again and replace the app in `/Applications`.

## Signing and distribution

Local builds are ad-hoc signed, so the app is blocked by Gatekeeper on other Macs.

Debug builds are signed with a designated requirement that only checks the bundle identifier
(`macos/DebugSigning.req`). Choosing "Always Allow" on the Keychain prompt once therefore holds
across rebuilds. Release builds keep the default requirement.

To distribute, set your team under Signing & Capabilities in Xcode (Developer ID Application),
then archive and notarize via Product → Archive → Distribute App → Direct Distribution.

Launch at login only replaces the LaunchAgent of older versions when the app runs from
`/Applications`.
