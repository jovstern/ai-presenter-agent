#!/bin/sh
# Generates the spoken prompts the opt-in live e2e (e2e/live.spec.js) feeds
# Chromium's fake microphone. macOS only: it uses `say`. `npm run e2e:live`
# runs it first, so the WAVs always match this script.
#
# Format: 16 kHz, 16-bit little-endian mono PCM (LEI16@16000), which Chromium's
# --use-file-for-fake-audio-capture reads as is. [[slnc N]] is `say`'s embedded
# silence command (N ms):
# - leading silence keeps the speech out of the connect gap (liveSession.js
#   buffers only the newest 20 mic frames before the socket is up) and, for the
#   task, lets the greeting finish first;
# - 60 s of trailing silence gives Gemini's voice activity detection a clean end
#   of turn and keeps the mic quiet for the rest of the scenario. The file plays
#   once (%noloop): a looping prompt would repeat the task and trip the loop guard.
set -eu

command -v say >/dev/null 2>&1 || {
  echo "make-prompts.sh needs macOS 'say' to generate e2e/fixtures/prompts/*.wav" >&2
  exit 1
}

out="$(dirname "$0")/fixtures/prompts"
mkdir -p "$out"

prompt() {
  say -o "$out/$1.wav" --data-format=LEI16@16000 "$2"
}

prompt greeting '[[slnc 4000]] Hi! [[slnc 60000]]'
prompt task '[[slnc 6000]] Increment the counter twice, then go to Settings, turn on notifications and save. [[slnc 60000]]'
prompt followup '[[slnc 12000]] Which page are we on right now? [[slnc 60000]]'
