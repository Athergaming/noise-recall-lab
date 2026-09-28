#!/bin/sh
# Downloads the original recordings (Wikimedia Commons) into tools/sources/ so that
# tools/make_audio.py can rebuild js/audio-data.js. Not needed to run the site.
set -e
cd "$(dirname "$0")" && mkdir -p sources && cd sources
UA="noise-recall-lab/1.0 (school project)"
curl -fL -A "$UA" -o Baustelle_am_Moedlingbach.wav "https://upload.wikimedia.org/wikipedia/commons/3/3d/Baustelle_am_M%C3%B6dlingbach.wav"
curl -fL -A "$UA" -o Group_discussion_1.ogg.mp3 "https://upload.wikimedia.org/wikipedia/commons/transcoded/6/69/Group_discussion_1.ogg/Group_discussion_1.ogg.mp3"
curl -fL -A "$UA" -o Group_discussion_3.ogg.mp3 "https://upload.wikimedia.org/wikipedia/commons/transcoded/8/82/Group_discussion_3.ogg/Group_discussion_3.ogg.mp3"
