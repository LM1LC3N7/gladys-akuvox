# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: Akuvox door phones and access controllers over their local
  HTTP API (none, Basic or Digest authentication), several devices.
- State of the door relays (read only) and one opening push button per relay,
  off by default, in automatic-close mode, never sent again.
- Scene triggers from the door log (door opened, access denied) and the call
  log (call).
- Refused credentials kept in `/data` (a salted 8-bit fingerprint) so a device
  is not asked again in a loop; lifted by new credentials or the test button.
