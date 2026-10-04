#!/bin/bash

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do # resolve $SOURCE until the file is no longer a symlink
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE" # if $SOURCE was a relative symlink, we need to resolve it relative to the path where the symlink file was located
done
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"

cd "$DIR"

PORT=8080

while lsof -i :"$PORT" >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

# 127.0.0.1 counts as a secure context, which the AudioWorklet and the line input need
open http://127.0.0.1:$PORT

# -c-1 turns off caching, so edits show up on reload
http-server -p $PORT -c-1
