#!/usr/bin/env bash
# Turns a recording or screenshot into the phase's demo GIF and publishes it on the
# pr-media branch, where the PR's Demo section links to it.
# Usage: make-demo.sh <milestone-number> <recording.webm|mp4|mov|png|jpg|gif>
set -euo pipefail

PHASE="${1:?Usage: make-demo.sh <milestone-number> <recording-or-screenshot>}"
SRC="${2:?Usage: make-demo.sh <milestone-number> <recording-or-screenshot>}"
[ -f "$SRC" ] || { echo "No such file: $SRC" >&2; exit 1; }
[[ "$PHASE" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "Milestone must be a number, got: $PHASE" >&2; exit 1; }

# Zero-padded: 3 -> 03, 3.1 -> 03.1
PADDED="$(printf '%02d' "${PHASE%%.*}")"
[[ "$PHASE" == *.* ]] && PADDED="$PADDED.${PHASE#*.}"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required: brew install ffmpeg" >&2; exit 1; }
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

WORK="$(mktemp -d)"
TREE="$WORK/tree"
cleanup() {
  git worktree remove --force "$TREE" >/dev/null 2>&1 || true
  git branch -D pr-media-init >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

GIF="$WORK/demo.gif"
case "$SRC" in
  *.gif) cp "$SRC" "$GIF" ;;
  *.webm | *.mp4 | *.mov)
    ffmpeg -loglevel error -y -i "$SRC" \
      -vf "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse" \
      "$GIF"
    ;;
  *.png | *.jpg | *.jpeg) ffmpeg -loglevel error -y -i "$SRC" -vf "scale='min(1280,iw)':-1" "$GIF" ;;
  *) echo "Unsupported file type: $SRC" >&2; exit 1 ;;
esac

SIZE="$(wc -c < "$GIF" | tr -d ' ')"
if [ "$SIZE" -gt 10000000 ]; then
  echo "GIF is $SIZE bytes; GitHub shows images up to 10 MB. Record a shorter flow." >&2
  exit 1
fi

if git ls-remote --exit-code --heads origin pr-media >/dev/null 2>&1; then
  git fetch --quiet origin pr-media
  git worktree add --quiet --detach "$TREE" FETCH_HEAD
else
  git worktree add --quiet --detach "$TREE"
  git -C "$TREE" checkout --quiet --orphan pr-media-init
  git -C "$TREE" rm -rq --cached . >/dev/null 2>&1 || true
  find "$TREE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
fi

mkdir -p "$TREE/m$PADDED"
cp "$GIF" "$TREE/m$PADDED/demo.gif"
git -C "$TREE" add "m$PADDED/demo.gif"
if git -C "$TREE" diff --cached --quiet; then
  echo "Demo unchanged."
else
  # The media branch holds only GIFs and has no node_modules, so the project's
  # pre-commit hook (lint/typecheck) has nothing to run on and is not installed here.
  git -C "$TREE" -c core.hooksPath=/dev/null commit --quiet -m "docs: demo for M$PADDED"
  git -C "$TREE" push --quiet origin HEAD:refs/heads/pr-media
fi

echo "Published: https://github.com/$REPO/blob/pr-media/m$PADDED/demo.gif?raw=true"
