# Contributing

Bug reports, fixes and improvements are welcome. For anything larger than a fix, open an
issue first so the change can be agreed before you write it.

A change to what a model may do (the permission modes, the never list, the sandbox, the
approvals, what a teammate's computer may ask of yours) always starts with an issue.
A security problem is reported privately: see [SECURITY.md](SECURITY.md). Everyone taking part
follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need macOS or Linux, Node 22 or newer, and Git.

```sh
git clone https://github.com/ELU-Labs/elu.git
cd elu
npm ci --ignore-scripts
node bin/elu-code.mjs --help
```

There is no build step. The code is plain ES modules: the command line in `bin/`, the app
in `lib/`, one module per vendor in `lib/adapters/`, and the peer network in `lib/peer/`.

## Tests

```sh
npm test                                # everything in test/*.test.mjs
node --test test/schedules.test.mjs     # one file
```

- The tests drive stand-in vendor command lines from `test/fakes/`, so they need no vendor
  account and make no model calls.
- The sandbox tests use the sandbox helper that ships with Codex, and are skipped when
  `codex` is not installed. CI installs the tested release first:
  `npm install --global --ignore-scripts @openai/codex@0.166.0-alpha.5.1`, and on Linux
  also `bubblewrap`. The tests of the system's own sandbox (`test/system-sandbox.test.mjs`)
  run where bubblewrap (Linux) or sandbox-exec (macOS) is.
- The peer tests run on a local test network; nothing leaves your computer.
- `npm run test:live` calls the real Claude Code and costs money. Its tests are skipped
  unless `ELU_CODE_LIVE=1` is set.
- CI tests a pull request on Ubuntu 24.04 with Node 22.9.0, and `main` on macOS 15 as well
  ([.github/workflows/test.yml](.github/workflows/test.yml)).

A change in behavior comes with a test that fails without it. A new vendor flag or rule
comes with the vendor's documentation, or the run, that shows it works.

## Pull requests

- One change per pull request, on a branch of your fork.
- The maintainer reviews every pull request. It merges once the maintainer approves it and
  the Linux tests pass.
- The subject line names the part it changes and what changes, as the history does:
  `Schedules: refuse a time that has passed`.
- Text the app shows is short, plain and says what to do next.
- There is no formatter or linter. Match the file you are in.
- Runtime dependencies are pinned to exact versions. A new one needs a reason in the
  pull request.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
