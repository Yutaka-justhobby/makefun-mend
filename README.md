# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Yutaka-justhobby/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Yutaka-justhobby/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies an edit an AI model wrote to a tree of text files. It reads all four formats models write — unified diffs (line numbers may be wrong), SEARCH/REPLACE blocks, V4A patches and JSON tool calls — finds the old lines at three tiers of exactness, from byte-equal down to indentation-insensitive, and then writes every change or none of them: a failed edit leaves the tree untouched and is reported by name. It runs on Node 22 with the standard library alone and behaves deterministically.

## Run it

```sh
node main.ts [options] [PATCH]
node main.ts --check fix.patch
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=rah12zz7&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
