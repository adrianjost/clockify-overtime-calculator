# Clockify Overtime Desktop App

Native macOS desktop app built with Electrobun.

## Features

- Enter your Clockify API key in-app
- Analyze overtime for a custom date range
- View overtime and daily chart data in the desktop UI
- Keep a tray icon with periodic overtime updates

## Prerequisites

1. Install Bun (official instructions): https://bun.sh/docs/installation
2. Verify Bun is available:
   bun --version
3. Install an SVG conversion tool for icon generation:
   - macOS (Homebrew): brew install imagemagick
   - Alternative: brew install librsvg

## Setup

1. Install dependencies:
   bun install

2. Install pre-commit hooks:
   bash scripts/setup-hooks.sh

   This configures local git hooks from `.githooks/`.

3. Generate app icons (required before packaging):
   bun run generate-icons

Optional one-command setup:

- bun run setup

## Run (Development)

1. Start app in dev mode:
   bun start

2. In the app window:
   - Paste your Clockify API key
   - Pick a start and end date
   - Click Analyze

Optional watch mode:

- bun run dev

## Build

Build a distributable app bundle:

- bunx electrobun build

Build output is written to `build/`.

## Distribution on Other Macs (Important)

If the app works on your machine but shows "is damaged" or "is broken" on another Mac, it is usually a Gatekeeper issue.
Unsigned or ad-hoc signed apps can run locally but are blocked when downloaded/copied to another device.

### 1. Sign the app with Developer ID

Use a real Developer ID Application certificate (not ad-hoc):

- APP="build/stable-macos-arm64/clockify-overtime.app"
- IDENTITY="Developer ID Application: Your Name (TEAMID)"
- codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$APP"
- codesign --verify --deep --strict --verbose=2 "$APP"
- spctl -a -vv "$APP"

### 2. Notarize and staple

- ditto -c -k --sequesterRsrc --keepParent "$APP" "clockify-overtime-macos.zip"
- xcrun notarytool submit "clockify-overtime-macos.zip" --apple-id "YOUR_APPLE_ID" --team-id "TEAMID" --password "APP_SPECIFIC_PASSWORD" --wait
- xcrun stapler staple "$APP"
- spctl -a -vv "$APP"

### 3. Distribute as DMG or ZIP created with `ditto`

Avoid archive tools that can break macOS metadata/signatures.

## Temporary Testing Workaround (Not for Release)

On a tester machine, this bypasses quarantine checks for a local test build:

- xattr -dr com.apple.quarantine /Applications/clockify-overtime.app

This is only for internal testing. Proper fix is signing + notarization.

## Helpful Commands

- Format source: bun run format
- Generate app icons: bun run generate-icons

## Structure

- src/bun: Bun main process and Clockify analysis logic
- src/mainview: HTML/CSS/TS desktop UI
- src/shared: Shared RPC types
