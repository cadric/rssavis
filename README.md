# RSSavis

RSSavis is a local-only RSS 2.0 and Atom reader for Firefox desktop 150.0 or newer. It stores subscriptions, articles, settings, and reading state in the local Firefox profile. It has no developer backend, account, telemetry, analytics, cloud sync, remote configuration, remote scripts, or remote styles.

This repository is a curated release export. Product changes are developed and validated on private development and release branches before an approved source release is exported here. Direct pull requests to `MASTER` are not merged, and ordinary issues are disabled until a later AMO/full Firefox release. Use the private reporting route in [SECURITY.md](SECURITY.md) for vulnerabilities.

## Features and privacy

- Add RSS 2.0 and Atom feeds after approving access to the exact feed origin.
- Read local cached previews, search locally, organize feeds, and maintain read and starred state.
- Import and export OPML for subscription backup and recovery.
- Choose whether remote images load. A loaded remote image can reveal the image URL and IP address to its host.
- Keep extension data in the local Firefox profile. Feed refresh necessarily sends the selected feed URL to its feed server, but RSSavis sends no subscriptions, article data, searches, or usage data to the developer.

## Build and test

Node.js 22.22.0 through 22.x, or Node.js 24.8.0 or newer, is required.

```sh
npm test
npm run package
```

No `npm install` is required. `npm run package` writes `dist/rssavis.zip`. That locally built ZIP is unsigned and is not an AMO distribution. GitHub's automatic source archive is source material only; it is not an extension distribution. AMO signing and distribution are separate release steps.

## Known limitations

- OPML backs up subscriptions, not cached articles or reading state. Quota exhaustion, explicit data clearing, disk-full conditions, profile corruption, or Firefox profile loss can remove local data.
- RSS 1.0/RDF, JSON Feed, website feed discovery, authenticated feeds, notifications, sync, and arbitrary live HTML rendering are outside V1.
- Remote feed servers can be offline, rate-limited, malformed, or oversized.
