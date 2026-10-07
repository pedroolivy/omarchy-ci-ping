# CI Ping

An [Omarchy](https://omarchy.org) bar widget that pings you on screen when CI
starts, passes or fails on any of your open pull requests.

- **Finds your PRs by itself.** Every open PR you authored, in every repo and
  organization your GitHub account can see. No repo list to keep.
- **Three pings.** ⏳ CI running, ✅ CI passed, ❌ CI failed. A failure stays on
  screen until you close it; the others go away on their own.
- **Never repeats.** Each result pings once, even with several monitors, and a
  shell restart does not replay old results.
- **In the bar.** How many PRs you have open, with an hourglass while CI runs
  and a red cross when something failed.
- **One click to the PR.** Click the icon for a list of your PRs, failures
  first, each with the branch it goes into and its CI status. Click a row to
  open exactly that PR.
- **What just landed.** Pull requests merged in the last 24 hours stay at the
  bottom of the panel, with the branch they went into. Hide one with its ×, or
  all of them with Clear.
- **Pin it.** Pin the panel to keep your pull requests on screen while you
  work; it keeps updating. Click Pinned or the bar icon to let it go.
- **Quiet when you want.** The bell at the top of the panel turns the pings
  off; the panel keeps tracking everything.

## Requirements

- Omarchy 4
- The GitHub CLI, signed in:

  ```bash
  sudo pacman -S github-cli
  gh auth login
  ```

That is all. CI Ping uses the login `gh` already has: no token to create.

Some organizations block third-party apps. If PRs from one are missing, an
admin of that organization has to allow the GitHub CLI once.

## Usage

| Action | Result |
| --- | --- |
| Left click | Opens the panel with your open PRs and their CI |
| Click a row | Opens that PR in the browser |
| Right click | Asks GitHub again now |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `notify` | `true` | Show pings on screen (the bell in the panel flips it) |
| `pollSeconds` | `60` | How often to ask GitHub (30 to 900 seconds) |
| `notifyStarted` | `true` | Ping when CI starts, not only when it ends |

## How it works

One GraphQL request through `gh api graphql` per poll returns your open PRs
with the combined check state of each PR's newest commit, the ones merged in
the last 24 hours, and your login and avatar. The panel loads the avatar from
`avatars.githubusercontent.com`; nothing else leaves your machine. The plugin compares
it with the previous answer and pings only on a change. A PR without CI never
pings.

## Development

```bash
node tests/model.test.mjs
```

## License

MIT
