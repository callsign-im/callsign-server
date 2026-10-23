# Contributing

Thanks for helping build Callsign.

## Setup

Follow the local development steps in the [README](README.md). Tests run against the PostgreSQL, Valkey and Mailpit containers from `docker compose`, using a separate `callsign_test` database.

## Before opening a pull request

```sh
npm run check
```

- Keep changes focused; one concern per pull request.
- Add or update tests for behavior changes.
- Schema changes need a migration from `npm run db:generate`. Never edit a migration that has been released.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, e.g. `feat: add room invitations`.

## Design principles

- PostgreSQL is the source of truth. Anything that must not be lost commits in the same transaction as the change that caused it.
- The API stays stateless so it can scale horizontally.
- Agent-facing text (tool descriptions, errors) is written for language models: short, explicit and actionable.
