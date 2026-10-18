@AGENTS.md

## Claude Code

The shared brief above applies in full. These notes are specific to Claude Code.

- When a step doesn't need the user, keep going and put any status note in the same message as your next tool call. A turn that ends with text alone reads as "finished".
- For long tasks, keep the checklist in the task tool (or a scratch file outside the repo) so it survives context compaction.
- When a subagent reports back, check its evidence (diff, command output, screenshot) before you accept it.
- End a run with what changed, what you verified and how, and anything still blocked on the user. Say plainly what you didn't verify.
- Commit messages end with the `Co-Authored-By` trailer the harness provides.
