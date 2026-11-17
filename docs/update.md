# Update and remove

Back to the [README](../README.md).

## Update

Quit ELU with `/quit` in every terminal it is open in, then:

```sh
elu update
```

On 0.1.11 or older, which have no `elu update`, update once with
`cd ~ && npx -y @elu-labs/elu@$(npm view @elu-labs/elu version)`. That asks npm for the
newest version and names it: `@latest` can reuse an old copy npx kept.

`elu update` installs the newest version where `elu` already is and restarts the peer
daemon on it; sessions still running finish on the old version first. Once a day ELU
checks for a newer version and says so in its status line; `ELU_NO_UPDATE_CHECK=1` turns
that check off. Both ask the npm registry for the latest version number and send nothing
else.

## Remove

To remove ELU, first delete your schedules in the app (Sessions tab, `t` on a row marked
`◷`, then `x` in its Schedule tab), so they no longer keep the Mac awake, and quit it with `/quit`.

Then remove the login item that runs schedules, and bots with a schedule such as `@elu`,
while ELU is closed, if there is one. On macOS, run
`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.elu-code.scheduler.plist`
and delete that file. On Linux, run `systemctl --user disable --now elu-code-scheduler.timer`
and delete `elu-code-scheduler.service` and `elu-code-scheduler.timer` in
`~/.config/systemd/user`.

Stop what still runs in the background:

```sh
elu peer uninstall          # stops the peer daemon and removes its login item
elu conductor stop          # stops sessions that are still running
```

In each project folder that is a Git repository, see what ELU would remove there,
then remove it:

```sh
elu uninstall --dry-run
elu uninstall               # asks before it removes anything
```

That removes the project's run history in `.git/elu-code`, which can hold secrets a command
printed; its task worktrees, and their folder once it is empty; and what `elu init` or
`/setup` wrote: `.elu-code/config.yaml` and the marked part of `AGENTS.md` and `CLAUDE.md`.
It keeps the task branches. It stops at a worktree with changes you have not committed,
and at a worktree of another repository: remove those first, as below.

Last:

```sh
npm uninstall --global @elu-labs/elu
```

If `elu` is in `~/.local/bin`, add `--prefix "$HOME/.local"` to that line.

These stay, for you to delete:

- `~/.config/elu-code`: your bots, your projects, your peer identity, and the sessions of a
  project whose folder is not a Git repository.
- `~/.local/share/elu-code`: the stand-in commands that refuse the never list.
- `~/.cache/elu`: an empty folder that held Claude Code's temporary files.
- `.elu-code/project.json` in each project folder, with the project's name, and any
  setting saved beside it that `elu uninstall` did not list.
- Task worktrees in a repository that is not itself the project folder, which a session
  edited. They sit beside that repository, in `shop.elu-code` for `shop`. In the
  repository, `git worktree list` shows them and `git worktree remove PATH` removes one;
  then delete the folder.
- Task branches, whose names start with `feat/task-`: `git branch -D NAME` in their
  repository.
