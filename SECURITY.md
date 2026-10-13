# Security policy

## Supported versions

Only the latest release gets fixes.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub instead: [report a vulnerability](https://github.com/mmedum/difnote/security/advisories/new), under the repository's Security tab.

Say which difnote and Claude Code versions you use, what someone could do with the problem, and how to reproduce it. difnote is maintained by one person, so allow a few days for an answer.

## What counts

difnote runs inside Claude Code with your permissions. These are in scope:

- difnote reading, running, writing or sending anything that [How it works](README.md#how-it-works) doesn't list.
- difnote changing a tool call, a prompt, or what Claude reads. It must always hand them on unchanged; the only text it adds is the notes it puts into the prompt box when you press `s`, which you send yourself.
- difnote's private git folders holding something they shouldn't: a copy of a file named like a secret or over 1 MiB, or anything from a folder the README says it doesn't watch.
- A git command of difnote's that a file or folder name could change, or that runs in your own `.git`.

A problem in Claude Code itself goes to Anthropic, through [Claude Code's security policy](https://github.com/anthropics/claude-code/blob/main/SECURITY.md).
