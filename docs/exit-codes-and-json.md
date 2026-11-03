# Exit codes and JSON

Exit codes follow the pytest convention. A script or CI job can read them directly.

| Code | `execute` | `prepare` and `author` |
|---|---|---|
| 0 | No claim is CONTRADICTED or NO-TEETH. | Done. |
| 1 | At least one claim is CONTRADICTED or NO-TEETH. With `--strict`, a NOT-LOCATED or NOT-CHECKABLE claim also gives 1. | Not used. |
| 2 | Could not check: bad arguments, unknown command, missing or invalid claims file, `--repo` not a git repository, target file differs from the git index, or a crash. | Same. `author` also gives 2 when no model is configured or a call fails. |

A claim with no `answer.json` yet is reported as NOT-CHECKABLE. Code 2 always prints one line on
stderr that says what to fix.

`--json` prints one JSON object on stdout and nothing else. The human lines go to stderr.
`--json-file <path>` writes the same object to a file. Both work with all three commands.

```json
{
  "tool": "claimcheck", "version": "0.1.2", "command": "execute", "repo": "/tmp/repo", "exitCode": 1,
  "summary": { "PROVEN": 3, "CONTRADICTED": 1, "NO-TEETH": 0, "NOT-LOCATED": 1, "NOT-CHECKABLE": 0, "total": 5 },
  "claims": [
    { "id": "c38", "quote": "Workers send a heartbeat every 5 seconds.", "class": "CONTRADICTED",
      "reason": "the check fails on real code", "located": "src/jobs/queue.ts:5",
      "checkKind": "behavioural", "mutationDiff": null }
  ]
}
```

For `prepare`, each claim carries `periods` and the top 5 `candidates`
(`file`, `line`, `text`, `why`, `score`, `usedBy`). The full list of 25 stays in
`<out>/work/<id>/candidates.json`.

The sample above shows the main fields. `execute` also adds an `errors` array with one line for each claim it could not check. A run that fails before it starts prints `error` and an empty `claims` array. A claim it could not check has `"class": null`.
