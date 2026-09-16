# Publishing hftengine to GitHub

Two repositories, because the engine is somebody else's project and only needs two extra lines:

1. `hftbacktest` - your **fork** of nkaz001/hftbacktest, with one commit that adds the two read-only
   queue-position getters (`patches/0001-expose-queue-position-getters.patch`). GitHub shows
   "forked from nkaz001/hftbacktest" on it, so credit is automatic.
2. `hftengine` - this folder: runner, dashboard, tools, docs and the sample session. Inside it, the
   `hftbacktest/` directory is a *submodule*: git stores a link "repository X at commit Y" instead of
   copying the files. People clone it with `git clone --recursive` and get both.

GitHub user: `mirkovicdev` (used in every URL below and in README.md).

## 0. One-time git settings on this machine

The D: drive does not record file ownership, so git refuses to work in these folders until they are
marked safe (already done for both folders on this PC; needed again only on another machine):

```
git config --global --add safe.directory D:/quant/hftengine
git config --global --add safe.directory D:/quant/hftengine/hftbacktest
```

## 1. Fork the engine (web browser)

Open https://github.com/nkaz001/hftbacktest, click **Fork**, keep the name `hftbacktest`, create it.

## 2. Push the getter commit to your fork

```
cd D:\quant\hftengine\hftbacktest
git checkout -b queue-position-getters
git add hftbacktest/src/backtest/models/queue.rs
git commit -m "Expose read-only queue position getters on QueuePos"
git remote add fork https://github.com/mirkovicdev/hftbacktest.git
git push -u fork queue-position-getters
```

Git will ask you to sign in to GitHub in a browser window the first time.

## 3. Turn the hftbacktest folder into a submodule link and commit hftengine

```
cd D:\quant\hftengine
git submodule add -b queue-position-getters https://github.com/mirkovicdev/hftbacktest.git hftbacktest
git add -A
git commit -m "hftengine: hftbacktest replay console"
```

`git submodule add` on a directory that is already a git repository does not download anything; it
records the link to your fork at the commit currently checked out there (the getter commit).

## 4. Create the hftengine repository and push (web browser + git)

On https://github.com/new create an empty repository named `hftengine` (public; do not let GitHub
add a README, .gitignore or licence, the folder already contains them: `LICENSE` is MIT, the same
licence as the engine, change it before pushing if you want something else). Then:

```
cd D:\quant\hftengine
git remote add origin https://github.com/mirkovicdev/hftengine.git
git push -u origin main
```

## 5. Check the result

`git clone --recursive https://github.com/mirkovicdev/hftengine` into a scratch directory and follow
the README setup; the dashboard must open on `?session=sample`.

## Later changes

- Dashboard / runner / tools: commit and push in `D:\quant\hftengine` as usual.
- Engine: commit in `D:\quant\hftengine\hftbacktest`, `git push fork`, then in `D:\quant\hftengine`
  run `git add hftbacktest && git commit -m "bump engine"` so the link points at the new commit.
- Optional: open a pull request from your fork's `queue-position-getters` branch to
  nkaz001/hftbacktest. If it is merged the fork is no longer needed.
