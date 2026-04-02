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

## Helpful Commands

- Format source: bun run format
- Generate app icons: bun run generate-icons

## Structure

- src/bun: Bun main process and Clockify analysis logic
- src/mainview: HTML/CSS/TS desktop UI
- src/shared: Shared RPC types
