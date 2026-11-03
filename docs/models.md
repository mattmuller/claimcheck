# Does it need an AI model?

Model use is optional. A model can choose the line, write the check and suggest search words (`--model-terms`). A person or agent can choose the line and write the check by hand.

| Step | How it runs |
|---|---|
| Parse the claim | Rules. No model. |
| Locate candidate code | Patterns, BM25 and the compiler's value map. No model, unless you ask for `--model-terms`. |
| Choose the line and write the check | A model, **or** a person or agent session writing `answer.json` by hand. It picks one of the located lines, names the value to change, and writes the check. |
| Mutate and rerun | Plain code. No model. |
| Verdict | Plain code. No model. |

A model cannot produce a PROVEN on its own: the check must also fail when the located code is
broken. A check that never touches that code passes on the mutant and is thrown out as NO-TEETH.
A check can still test the wrong thing and pass both rules, which is why a second, independent
review step is planned.
