# When to use claimcheck

Anywhere a document makes a promise that the code has to keep. The more people rely on the
document, and the less they can see the code, the more a wrong sentence costs.

| Where the claim is written | Example claim | Why checking it matters |
|---|---|---|
| Privacy notices and data-retention statements | "Server logs are kept for 90 days." | Data protection law requires these statements to be accurate. A regulator, auditor or customer reads the notice, never the code. |
| Terms of service and service-level documents | "Uploads larger than 50 MB are rejected." "A request times out after 30 seconds." | Users and customers act on these terms, and a contract that does not match the product is a dispute waiting to happen. |
| Security and compliance pages | "Idle sessions end after 15 minutes." | Auditors and security questionnaires take these as evidence. A drifted setting turns a true answer into a false one. |
| API reference documentation | "Each client may send 100 requests per minute." "Results come back in pages of 50." | Integrators build to the documented numbers. A silent change breaks them. |
| Runbooks and operations guides | "Backups run every 6 hours and the newest 30 are kept." | People make recovery decisions from runbooks during an incident, the worst time to find out they are wrong. |
| Documentation written by AI agents | Any of the above, drafted by an agent from the code | An agent can describe code confidently and wrongly. A claim it cannot prove is a claim a person should read. |
| Before a release, in CI | The same claims, re-run on every change | A setting changed in code months after the document was written is the usual way these drift. |

It is most useful where the claim is a number with a unit: a period, a limit, a size or a count.
It cannot yet check claims without one, such as "passwords are stored hashed".
