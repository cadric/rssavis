# Changelog

## 1.0.0 — 2026-07-20

### Features

- Reads RSS 2.0 and Atom feeds in a local Firefox 150+ extension, with categories, Main Stream, local search, read/star state, scheduled refresh, and OPML import/export.
- Shows Main Stream unread in the localized tab title and Firefox native toolbar badge while keeping the packaged favicon static.

### Security and privacy

- Stores subscriptions, articles, settings, and reading state in the local Firefox profile with no account, developer backend, telemetry, analytics, remote configuration, or cloud sync.
- Requests feed origins only through optional host permissions. Remote images remain optional and can reveal the image URL and IP address to their host when loaded.

### Accessibility

- Provides keyboard-operated Reader, Preferences, search, menus, dialogs, and recovery flows with visible focus, localized English and Danish UI, forced-colors and reduced-motion support.
- Retains the completed Firefox and Orca release review from the V1 validation program; B54 does not claim a new screen-reader run.

### Known limitations

- The current artifact is an unsigned local ZIP and is not published on AMO. Permanent signed-install behavior has not been tested.
- OPML backs up subscriptions, not cached articles or reading state. Quota exhaustion, Firefox profile deletion, explicit site-data clearing, disk-full conditions, or profile corruption can remove local data.
- Authenticated feeds, RSS 1.0/RDF, JSON Feed, website feed discovery, notifications, sync, and arbitrary live HTML rendering are outside V1.
