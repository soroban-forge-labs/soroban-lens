# Incident: PolinRider malware merged via PR #252 (2026-10-22)

## Summary

On 2026-10-22 at 08:48 UTC, PR #252 ("fix: Per-contract event counter on
`/metrics`", commit `8b3dfaa` authored as `issue-solver-bot`) was merged into
`main`. Alongside a working metrics change, it added the
[PolinRider](https://opensourcemalware.com/blog/polinrider-dprk-compromised-hundreds-of-github-repos)
malware, a credential-stealing campaign that has been spreading through
GitHub repositories since early 2026.

`main` carried the malware from 2026-10-22 08:48 UTC until it was cleaned on
2026-10-24. The repository was removed from the Drips Stellar Wave as a
precaution on 2026-10-22.

## What the malware added

| Path | Role |
| --- | --- |
| `api.js` | Obfuscated loader (≈28 KB on one line, hidden behind whitespace) |
| `package.json` `build` script | Changed to `node api.js && …`, so `npm run build` ran the loader |
| `public/fonts/fa-solid.lkf` | Payload disguised as a font |
| `public/fonts/fa-*-400/900.*`, `public/fonts/README.md` | Decoy Font Awesome files to make the folder look legitimate |
| `.vscode/tasks.json` | Hidden `eslint-check` task with `"runOn": "folderOpen"` that runs the payload with Node when the folder is opened in VS Code |
| `.vscode/settings.json` | `task.allowAutomaticTasks`, `terminal.integrated.hideOnStartup`, `debug.openDebug: neverOpen` to run silently |
| `.vscode/launch.json`, `extensions.json`, `spellright.dict` | Decoys |
| `.gitignore` | `temp_auto_push.bat`, `branch_structure.json`, `.gitignore`, the working files of the campaign's auto-push tool |

The loader drops a backdoor in `~/.node_modules/` (`.npm-ws-runner.js`,
`.npm-ws.json`) that connects to `95.135.181.151` and runs whatever code the
server sends back.

## Who may be affected

You may be affected if, between 2026-10-22 08:48 UTC and 2026-10-24, you
cloned or pulled `main` (or a branch that merged it) **and** did any of these:

- ran `npm run build` (or `bench`, which calls it) at the repo root
- opened the folder in VS Code or Cursor with workspace trust and automatic tasks allowed

Cloning or reading the code alone does not run anything.

If you might be affected:

1. Check for `~/.node_modules/.npm-ws-runner.js` and `.npm-ws.json`. If they exist, your machine ran the payload.
2. From a **different, clean device**, rotate GitHub tokens and SSH keys, npm and other registry tokens, cloud credentials and `.env` secrets, and sign out other sessions. Move funds from any crypto wallet whose keys were on the machine.
3. Check your GitHub account for unfamiliar SSH keys, tokens, OAuth apps and collaborators.
4. Ideally reinstall the operating system before using the machine again.

GitHub Actions also ran the build on `main` during this window. The workflow
token is read-only and the repository holds no Actions secrets, so no
credentials were exposed through CI.

## What was done

- **History rewritten.** The 18 commits on `main` from the merge of #252
  onwards were rewritten to remove every file above and undo the
  `package.json` and `.gitignore` changes. No version of `main` contains the
  malware any more. The legitimate per-contract metrics change from #252 was
  kept. Commit hashes after `bb327df` changed.
- **Malware guard added.** `.github/workflows/malware-guard.yml` runs
  `.github/scripts/malware-guard.sh` on every pull request and push. It fails
  on the paths, settings, npm hooks, whitespace-hidden code and network
  indicators used by this campaign. It only reads files and never installs or
  runs repo code.
- **Branch protection (in progress).** Force pushes and deletion of `main`
  are being blocked, and the malware guard made a required check.
- **Open pull requests.** Open PRs that merged the infected `main` (#241,
  #242, #243, #244, #248, #249, #251, #253) must rebase onto the cleaned
  `main` before they can be merged. They fail the guard until they do.
- **Maintainer credentials** are being rotated from a clean device.
- **GitHub Support** has been asked to purge the old commits and PR refs.

## If you have an open PR or a local clone

Your branch probably still contains the old commits. Do **not** merge or push
them back. Rebase only your own commits onto the cleaned `main`:

```bash
git fetch origin
git rebase --onto origin/main <old-main-sha> your-branch   # old main tip: 4534d44
git push --force-with-lease
```

For a plain clone with no local work, `git fetch origin && git reset --hard origin/main` is enough.

## Indicators of compromise

- Files: `api.js` at the repo root, `public/fonts/fa-solid.lkf`, `.vscode/tasks.json` with `runOn: folderOpen`
- Local: `~/.node_modules/.npm-ws-runner.js`, `~/.node_modules/.npm-ws.json` (`_V: "A8-&&"`)
- Network: `95.135.181.151` on ports 80 and 443, path `/0x/cls`, request header `Sec-V`
- SHA-256 of the dropped `.npm-ws-runner.js`: `6aa8c6eb1555e2edb4bfa727580c2981d40ee8ae2719d2f88d267cab8384aa64`

## Lessons

- Five PRs were merged within three minutes. #252's title and description
  matched its metrics change, but the diff also added 30 unrelated files.
  Maintainers now check the **file list** of every PR, not only the
  description, and the guard fails on these patterns automatically.
- Never run a repository's npm scripts, or open it in an editor with
  automatic tasks allowed, before reviewing what was merged.
