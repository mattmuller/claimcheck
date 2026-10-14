# Security

Report a security problem privately, not in a public issue:
https://github.com/mattmuller/claimcheck/security/advisories/new

Please include what you ran, what happened, and the package version (`npm ls @mattmuller/claimcheck`).

## What this tool does to your system

`prepare` only reads the target repository. `execute` runs the checks you or an agent wrote, and temporarily edits one line of one file in the target repository, restoring it with `git checkout`. Run it on a clean checkout of code you are happy to execute.
