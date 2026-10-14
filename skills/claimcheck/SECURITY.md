# Security

Report a security problem privately, not in a public issue:
https://github.com/mattmuller/claimcheck/security/advisories/new

Please include what you ran, what happened, and the package version (`npm ls @mattmuller/claimcheck`).

## What this tool does to your system

`prepare` only reads the target repository. `execute` runs the checks you or an agent wrote, and temporarily edits one line of one file in the target repository, writing the original bytes back afterwards and checking them against git's stored copy. Run it on a clean checkout of code you are happy to execute. The working file must match git's index byte-for-byte, so on Windows a checkout with `core.autocrlf=true` is refused: run `git config core.autocrlf false` and check out again.

`execute` refuses a target that is untracked, a symlink, or outside the repository. It also refuses an absolute path or a path with `..` in it. If it cannot restore the edited file, it stops with an error that names the file.

Checks run without your API keys in their environment variables. A check sees only a short list of environment variables (`PATH`, `HOME`, temp folders, locale and time zone). Any variable with `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` in its name is never passed on. The gateway key is also removed from any output claimcheck stores.

**A check is not sandboxed.** It is code, often written by a model that read the target repository, and it runs as you with your files within reach. Scrubbing environment variables does not stop it reading your files or using the network. For code you do not trust, run claimcheck in a container or as a throwaway user.

If you press Ctrl+C or the process gets SIGTERM, SIGHUP or SIGQUIT, claimcheck kills the running check and everything it started, then restores the edited file. SIGKILL cannot be caught, so a `kill -9` can leave the mutated line behind: run `git status` in the target afterwards.

The `--out` folder can hold output from the code under test. Keep it out of version control.

`prepare` reads only tracked regular files inside the repository. It skips symlinks and paths that resolve outside it.
