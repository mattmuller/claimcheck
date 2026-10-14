# Security

Report a security problem privately, not in a public issue:
https://github.com/mattmuller/claimcheck/security/advisories/new

Please include what you ran, what happened, and the package version (`npm ls @mattmuller/claimcheck`).

## What this tool does to your system

`prepare` only reads the target repository. `execute` runs the checks you or an agent wrote, and temporarily edits one line of one file in the target repository, restoring it with `git checkout`. Run it on a clean checkout of code you are happy to execute.

`execute` refuses a target that is untracked, a symlink, or outside the repository. It also refuses an absolute path or a path with `..` in it. If it cannot restore the edited file, it stops with an error that names the file.

Checks run without your API keys in their environment. A check sees only a short list of variables (`PATH`, `HOME`, temp folders, locale and time zone). Any variable with `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` in its name is never passed on. The gateway key is also removed from any output claimcheck stores.

The `--out` folder can hold output from the code under test. Keep it out of version control.

`prepare` reads only tracked regular files inside the repository. It skips symlinks and paths that resolve outside it.
