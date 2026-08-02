#!/usr/bin/env bash
#
# Start Ollama's API server (if not already listening) and bring up the OpenClaw stack.
#
# The Ollama tray app on this machine fails to spawn its `serve` backend - it logs
# "timeout waiting for Ollama server to be ready" and never writes server.log.
# Running `ollama serve` directly works fine, so this script does that itself.
#
# Ollama stays bound to 127.0.0.1. The container reaches it through the ollama-fwd
# socat container, which sits in WSL's network namespace and re-publishes Ollama on
# the docker0 gateway - see README.
#
# Git Bash / MSYS2 port of start.ps1.

set -euo pipefail

OLLAMA_EXE="/c/Users/briem/AppData/Local/Programs/Ollama/ollama.exe"
PORT=11434
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Colors, but only when stdout is a terminal.
if [ -t 1 ]; then
    GREEN=$'\033[32m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
    GREEN=''; CYAN=''; RESET=''
fi

# Probe the API rather than the socket table: netstat's output format varies
# across the Windows/MSYS builds, and a listening-but-wedged server is not "up".
ollama_up() {
    curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/version"
}

die() { printf '%s\n' "$*" >&2; exit 1; }

if ollama_up; then
    printf '%sOllama already listening on %s.%s\n' "$GREEN" "$PORT" "$RESET"
else
    [ -x "$OLLAMA_EXE" ] || die "ollama.exe not found at $OLLAMA_EXE"

    # Loopback-only bind. The container reaches Ollama through the ollama-fwd
    # socat container, which lives in WSL's network namespace and can therefore
    # use 127.0.0.1 - so Ollama never needs to listen on a routable interface.
    # Set explicitly rather than inheriting: a shell that predates any OLLAMA_HOST
    # change would otherwise silently pick a different bind.
    export OLLAMA_HOST="127.0.0.1:$PORT"

    printf 'Starting ollama serve...'
    # Detach so the server outlives this script.
    nohup "$OLLAMA_EXE" serve >/dev/null 2>&1 &
    disown || true

    # Wait for the listener rather than sleeping a fixed interval.
    deadline=$(( $(date +%s) + 30 ))
    while [ "$(date +%s)" -lt "$deadline" ] && ! ollama_up; do
        sleep 0.5
        printf '.'
    done

    if ollama_up; then
        printf ' %sup.%s\n' "$GREEN" "$RESET"
    else
        printf '\n'
        die "Ollama did not start within 30s. Check %LOCALAPPDATA%\\Ollama\\server.log"
    fi
fi

echo "Bringing up OpenClaw..."
docker compose --project-directory "$SCRIPT_DIR" up -d

echo ""
printf '%sGateway:  http://127.0.0.1:18789%s\n' "$CYAN" "$RESET"
printf '%sOllama:   http://127.0.0.1:%s%s\n' "$CYAN" "$PORT" "$RESET"
