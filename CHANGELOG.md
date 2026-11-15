# Changelog

All notable changes to `@narcisbodea/smstunnel-node-red` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-11-15

Needs SMSTunnel with scheduled texts on the server. A server from before them refuses `msg.sendAt` with a 400
(`property sendAt should not exist`), reported like any 400, and nothing is sent.

### Added

- **Scheduled texts in SMSTunnel send**: `msg.sendAt` (a Date, also one made in a function node, or an ISO 8601 time
  with its offset) has SMSTunnel keep each text and send it then, 1 minute to 30 days ahead. The output is
  `{ scheduledId, to, status: "scheduled", scheduled: true, sendAt, message }`, the badge says it was scheduled, and
  **Wait** doesn't apply. A time without an offset, a number, or a date that doesn't exist (30 February) is refused
  before anything is sent; the time always goes out as `toISOString()` (UTC).
- **`msg.cancel`** on SMSTunnel send: the `scheduledId` of a scheduled text cancels it instead of sending a text, and
  the canceled text is output. A text that already went out raises an error with `409 SCHEDULE_NOT_EDITABLE`.
- SMSTunnel code refuses `msg.sendAt` and `msg.cancel`: sign-in codes are never scheduled.
- The client (`nodes/lib/client.js`): `sendSms()` with `sendAt`, `listScheduled()`, `getScheduled()` and
  `cancelScheduled()`, with SMSTunnel's `code` on `SmsTunnelError`.

## [1.0.0] - 2026-11-01

### Added

- **SMSTunnel account** config node: the API key in Node-RED's encrypted credentials, an optional phone and country code.
- **SMSTunnel send**: one text per number from `msg.to` (or the node's typed input), with an optional wait for the
  phone's confirmation, one send at a time per account, and one retry after a 429.
- **SMSTunnel code**: sign-in codes through `send-2fa`, to one number, without the text in the output.
- **SMSTunnel received**: outputs new received texts, oldest first; checks on a timer or when a message arrives, and
  carries on after a redeploy.
- Help text and messages in `en-US`, three example flows, and status badges.
