# Security policy

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). We aim to acknowledge reports within three business days.

## Ground rules for contributors

- Never commit credentials, tokens, key material, `.env` files or recordings of real people. Provider API keys stay on the server side.
- No client-supplied account or tenant identifier may authorize an action. Identity is bound by the server when a host is created.
- No audio leaves the device before the person has activated voice. Wake-phrase monitoring needs explicit, revocable consent.
- Live provider tests use your own developer credentials and are never run in CI against shared secrets.
