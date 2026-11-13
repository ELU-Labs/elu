# Third-party notices

Two of the bots ELU comes with are adapted from skills published by others. Their
instructions are in `lib/default-bots.mjs`. Some test files are examples copied from a
published specification; they are in the repository only, not in the npm package.

## @reviewer

Adapted from the `code-review` skill of the Engineering plugin in
[anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)
(`engineering/skills/code-review/SKILL.md`, version 1.2.0), by Anthropic, licensed under the
Apache License, Version 2.0. A copy of that license is in
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).

Changes: the review dimensions (security, performance, correctness, maintainability) and the
shape of the answer (summary, critical issues, suggestions, what looks good, verdict) are
kept. The text is rewritten for a bot that reviews the change of a session and reports its
findings as blocking or optional comments. The slash command, the connector notes and the
usage tips are left out.

## @qa

Adapted from the `qa` skill of [garrytan/gstack](https://github.com/garrytan/gstack)
(`qa/SKILL.md`), licensed under the MIT License. The method is kept: test, report a
baseline by severity, then for each finding reproduce it, write the regression test first,
make the smallest fix, test again and classify the result, with rules for when to stop. The
text is rewritten for a bot in a session; the browser tooling, the setup steps, the report
files and the telemetry of the original are left out.

```text
MIT License

Copyright (c) 2026 Garry Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## A2A specification examples

The six files in `test/fixtures/a2a/` are examples from the Agent2Agent (A2A) Protocol
specification in [a2aproject/A2A](https://github.com/a2aproject/A2A)
(`docs/specification.md`, tag `v1.0.1`), licensed under the Apache License, Version 2.0. A
copy of that license is in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).

Changes: each file holds one example, as JSON, with a `_source` field added that names the
section of the specification and the lines it comes from.
