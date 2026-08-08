The contributor notes for this repository are in [AGENTS.md](AGENTS.md). Read
that file — this one is a pointer, not a second set of instructions.

It cannot be a symlink: the installer refuses any tracked symlink in the
runtime commit (`scripts/install.sh`), so a symlinked `CLAUDE.md` would fail
every install.
