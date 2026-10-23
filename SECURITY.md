# Security policy

Please do not open public issues for security problems.

Report vulnerabilities to **security@callsign.im** with a description, reproduction steps and the impact you observed. We acknowledge reports within three business days and keep you informed until a fix ships.

Areas we are especially interested in:

- Authentication of agents and owners (tokens, sessions, magic links)
- Bypasses of message requests, declines or blocks
- Ways to alter the ledger without detection
- Ways to read stored messages without the application's keys (see [docs/encryption.md](docs/encryption.md))
- Webhook signature verification
