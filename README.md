# Clockify Overtime Desktop App

Native macOS menu bar app that shows your Clockify overtime.

## Features

- Enter your Clockify API key in-app (stored in the macOS Keychain)
- Analyze overtime for a custom date range
- Zoomable daily/weekly chart with cumulative overtime
- Menu bar item with periodic overtime updates
- Optional: track time yourself (start/stop, add and edit entries) and keep the entries on your
  own server instead of Clockify
- Launch at login

## How it works

- `macos/`: the native app (Swift, AppKit). It owns the menu bar item, the window, the Keychain,
  launch at login, and fetching/caching Clockify time entries (`macos/ClockifyOvertime/Clockify`).
- `src/mainview/`: the dashboard UI (HTML/CSS/TypeScript), shown in a `WKWebView`. It talks to the
  native app through `src/mainview/bridge.ts`; the available requests are typed in `src/shared/rpc.ts`.

- `server/`: the optional self-hosted time tracking server (Bun + SQLite, run with Docker Compose).
  The app talks to it in `macos/ClockifyOvertime/TimeTracking`. It also serves a mobile web UI
  (`src/web/`), which reuses the dashboard's views with an HTTP transport instead of the native bridge.

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
2. Open it. On first launch it asks where your time entries are: choose Clockify.
3. Create a Clockify API key: in Clockify, open your profile menu → Preferences → Advanced →
   Manage API keys → Generate new, and copy the key (it is only shown once).
4. Paste the key into the API key field. It is stored in the Keychain.
5. Go back to the overview. The dashboard shows your overtime for this year (pick another range
   at the top left), and the menu bar shows the total. Turn on Open at login in the settings if
   you like.

To update, pull the latest changes, build again and replace the app in `/Applications`.

## Self-hosted time tracking (optional)

By default the app reads your time entries from Clockify. Instead, you can track time in the app
and keep the entries on your own server, for example a NAS. Then you don't need Clockify at all.

### Run the server

You only need Docker and the Compose file, not the repo. On the machine:

```sh
mkdir time-tracking && cd time-tracking
curl -fsSLO https://raw.githubusercontent.com/adrianjost/clockify-overtime-calculator/main/server/docker-compose.yml
docker compose up -d
```

This runs the prebuilt image `ghcr.io/adrianjost/clockify-overtime-calculator-server` (for x86 and
ARM). It is rebuilt on every change to `main`. On a NAS you can also paste the Compose file into its
container manager.

The server listens on port 8787 and stores everything in one SQLite file, `data/time-tracking.db`
next to the Compose file. Back up that folder to back up your entries. To update:

```sh
docker compose pull && docker compose up -d
```

To build the image yourself instead, run this in the repo and then `docker compose up -d` as above:

```sh
docker build -f server/Dockerfile -t ghcr.io/adrianjost/clockify-overtime-calculator-server .
```

### Accounts

Nobody can sign up on their own: you create the accounts on the server. Each account has its own
time entries and its own timer.

To add an account, run this in the folder with the Compose file while the server is running:

```sh
docker compose exec time-tracking bun server.ts user add <name>
```

It asks for a password (at least 8 characters; it is shown while you type). The person can then sign
in with that name and password in the app or on the web page. Names are not case-sensitive.

The other commands work the same way:

| Command                                                              | What it does                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `docker compose exec time-tracking bun server.ts user list`          | List all accounts                                            |
| `docker compose exec time-tracking bun server.ts user passwd <name>` | Set a new password and sign out all of that person's devices |
| `docker compose exec time-tracking bun server.ts user remove <name>` | Delete the account and all its time entries                  |

Without Docker Compose, use `docker exec -it <container> bun server.ts user add <name>`. On a NAS
without SSH, open a terminal for the container in its container manager and run
`bun server.ts user add <name>` there.

### Use it on your phone

The server also hosts a mobile web page at its address (e.g. `http://192.168.1.10:8787`). Sign in to
start and stop the timer, add, edit and delete entries, and see your overtime balance for a range and
for the current week. On iOS, use Share → Add to Home Screen to open it like an app.

### Move your entries from Clockify

Each user can copy their Clockify history to the server themselves. While an account has no entries,
the web page offers the import right away; later, use "Import time entries" at the bottom. Choose
Clockify and paste a Clockify API key. The server copies all finished entries from your
default Clockify workspace. Entries imported before are skipped, so importing twice adds nothing.
Entries whose time you already tracked on the server (overlapping by more than a minute) are skipped
too, so nothing is counted twice. A running Clockify timer is not imported. The key is only used for
the import and not stored. The server needs internet access to reach Clockify.

### Export your entries

At the bottom of the web page, "Export all entries as CSV · JSON" downloads all your time entries. The
CSV has start and end date and time in your browser's time zone, the duration, and the exact times in
ISO 8601, which most time tracking tools can import. The JSON lists the same entries with their IDs.

### Connect the app

In Settings, choose Self-hosted server as the data source, enter the server address
(e.g. `http://192.168.1.10:8787`), your username and password, and click Sign in. The Clockify API key
stays saved, so you can switch between both data sources at any time.

Plain `http://` works for IP addresses, `.local` names and single-word hostnames on your network.
Any other hostname needs HTTPS (for example through your NAS's reverse proxy). Use HTTPS when the
server is reachable from outside your home network, as passwords and session tokens are sent with
the requests.

Once connected:

- Start and stop the timer from the toolbar or by right-clicking the menu bar item. While the timer runs,
  the menu bar shows a dot and its length in front of your overtime, e.g. `● 1:25 · +12h 30m`.
- The list button in the toolbar opens your time entries. Click an entry to change or delete it, or
  use "Add entry" for time you forgot to track. An end time earlier than the start time counts as the
  next day.
- The overtime is calculated from these entries, counting each entry on the day it started.

### API

`POST /api/login` with `{username, password}` returns a session token. All other `/api` requests
need it as `Authorization: Bearer <token>`. Times are ISO 8601.

| Request                                          | Purpose                                      |
| ------------------------------------------------ | -------------------------------------------- |
| `POST /api/login` `{username, password}`         | Sign in; returns `{token, username}`         |
| `POST /api/logout`                               | End this session                             |
| `GET /api/me`                                    | The signed-in user, and if they have entries |
| `GET /api/entries?from=…&to=…`                   | Entries overlapping the range                |
| `POST /api/entries` `{start, end}`               | Add an entry                                 |
| `PATCH /api/entries/:id` `{start?, end?}`        | Change an entry                              |
| `DELETE /api/entries/:id`                        | Delete an entry                              |
| `GET /api/timer`                                 | The running entry, if any                    |
| `POST /api/timer/start` / `POST /api/timer/stop` | Start or stop the timer                      |
| `POST /api/import/clockify` `{apiKey}`           | Copy entries from Clockify                   |

## Signing and distribution

Local builds are ad-hoc signed, so the app is blocked by Gatekeeper on other Macs.

Debug builds are signed with a designated requirement that only checks the bundle identifier
(`macos/DebugSigning.req`). Choosing "Always Allow" on the Keychain prompt once therefore holds
across rebuilds. Release builds keep the default requirement.

To distribute, set your team under Signing & Capabilities in Xcode (Developer ID Application),
then archive and notarize via Product → Archive → Distribute App → Direct Distribution.

Launch at login only replaces the LaunchAgent of older versions when the app runs from
`/Applications`.
