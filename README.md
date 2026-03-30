# Clockify Overtime Desktop App

Native macOS desktop app built with Electrobun.

## Features

- Enter your Clockify API key in-app
- Choose a year to analyze
- Run overtime analysis from the Bun process
- View the same report output format as the original CLI in plain text

## Setup

1. Install dependencies:
   bun install

2. Install pre-commit hooks:
   bun scripts/setup-hooks.sh

   This ensures code is automatically formatted with oxfmt and prettier before each commit.

## Run

1. Start app in dev mode:
   bun start

2. In the app window:
   - Paste your Clockify API key
   - Enter a year
   - Click Analyze

## Structure

- src/bun: Bun main process and Clockify analysis logic
- src/mainview: HTML/CSS/TS desktop UI
- src/shared: Shared RPC types
