# gladys-akuvox

External integration for [Gladys Assistant](https://gladysassistant.com) (5.1.0 or later): Akuvox door
phones and access controllers on the local network, through their HTTP API. **Unofficial, not affiliated
with Akuvox. Never tested with a real device.**

- the state of the door relays (A to D), read only;
- one "Open relay" push button per relay, **off by default** (never a switch); the relay closes by itself
  after the opening duration;
- scene triggers: door opened, access denied, call (from the door and call logs of the device).

User guide: [français](docs/fr.md) · [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (fake Gladys of the SDK, fake Akuvox devices on loopback)
npm run lint
npm run format:check
npm run cover          # regenerates cover.png
```

Architecture, rules and decisions: [CLAUDE.md](CLAUDE.md) and [TODO.md](TODO.md). Ported from
[pylocal-akuvox](https://github.com/tykeal/pylocal-akuvox) 1.7.0 (Apache-2.0), see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0, see [LICENSE](LICENSE).
