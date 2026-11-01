# Changelog

All notable changes to `@narcisbodea/smstunnel-node-red` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-01

### Added

- **SMSTunnel account** config node: the API key in Node-RED's encrypted credentials, an optional phone and country code.
- **SMSTunnel send**: one text per number from `msg.to` (or the node's typed input), with an optional wait for the
  phone's confirmation, one send at a time per account, and one retry after a 429.
- **SMSTunnel code**: sign-in codes through `send-2fa`, to one number, without the text in the output.
- **SMSTunnel received**: outputs new received texts, oldest first; checks on a timer or when a message arrives, and
  carries on after a redeploy.
- Help text and messages in `en-US`, three example flows, and status badges.
