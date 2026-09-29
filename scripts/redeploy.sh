#!/usr/bin/env bash
# Rebuilds Relay's image and restarts its Compose stack, keeping, saving, wiping or restoring its
# data. Run it without options to be asked, or see --help. Uses .env as `docker compose` does, so
# overlays in COMPOSE_FILE apply.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/redeploy.sh [options]

Without options, asks for each choice.

  --from commit      The latest commit only (default). Uncommitted changes are left out.
  --from working     The working tree as it is, including uncommitted and untracked files.
  --from <ref>       Any commit, branch or tag.

  --data keep        Keep the data (default).
  --data save        Save a copy of the data, then start with none.
  --data wipe        Delete the data for good, then start with none.
  --data restore=<v> Replace the data with a saved copy: a volume name, or "latest".

  --list             List saved copies of the data, then exit.
  --rollback         Go back to the image that ran before the last redeploy, keeping the data.
  -y, --yes          Don't ask for confirmation.
  -h, --help         Show this help.
EOF
}

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

bold=$'\e[1m' dim=$'\e[2m' red=$'\e[31m' green=$'\e[32m' yellow=$'\e[33m' reset=$'\e[0m'
if [[ ! -t 1 ]]; then bold='' dim='' red='' green='' yellow='' reset=''; fi
step() { printf '\n%s==> %s%s\n' "$bold" "$*" "$reset"; }
note() { printf '%s%s%s\n' "$dim" "$*" "$reset"; }
warn() { printf '%s%s%s\n' "$yellow" "$*" "$reset" >&2; }
fail() {
  printf '%sError: %s%s\n' "$red" "$*" "$reset" >&2
  exit 1
}

from='' data='' yes=false interactive=true action=deploy
while (($#)); do
  case $1 in
    --from) from=${2:?--from needs a value}; shift ;;
    --from=*) from=${1#*=} ;;
    --data) data=${2:?--data needs a value}; shift ;;
    --data=*) data=${1#*=} ;;
    --list) action=list ;;
    --rollback) action=rollback ;;
    -y | --yes) yes=true ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
  shift
done
# Any choice on the command line, or --yes alone, means the defaults for the rest: no questions.
[[ -n $from || -n $data || $action != deploy ]] || $yes && interactive=false

command -v docker >/dev/null || fail "Docker isn't installed."
docker info >/dev/null 2>&1 || fail "Docker isn't running."

project=$(docker compose config 2>/dev/null | awk '/^name:/ { print $2; exit }')
[[ -n $project ]] || fail "docker compose can't read the configuration here; run it once to see why."
image=$(docker compose config --images | head -n 1)
volume="${project}_relay-data"
saved_prefix="${volume}-saved-"
rollback_image="${image%:*}:rollback"

container() { docker compose ps -a -q relay 2>/dev/null | head -n 1; }
volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }
env_value() { [[ -f .env ]] && sed -n "s/^$1=//p" .env | tail -n 1 | tr -d "\"'" || true; }
saved_copies() {
  docker volume ls -q --filter "name=^${saved_prefix}" | sort -r
}

confirm() {
  $yes && return 0
  local answer
  read -r -p "$1 [y/N] " answer
  [[ $answer == [yY] || $answer == [yY][eE][sS] ]]
}

choose() { # choose <prompt> <default> <option>...: prints the chosen option's number.
  local prompt=$1 default=$2 i=1 answer
  shift 2
  printf '\n%s%s%s\n' "$bold" "$prompt" "$reset" >&2
  for option in "$@"; do
    printf '  %d) %s\n' "$i" "$option" >&2
    i=$((i + 1))
  done
  while true; do
    read -r -p "Choice [$default]: " answer
    answer=${answer:-$default}
    if [[ $answer =~ ^[0-9]+$ ]] && ((answer >= 1 && answer <= $#)); then
      echo "$answer"
      return
    fi
  done
}

list_saved() {
  local copies
  copies=$(saved_copies)
  if [[ -z $copies ]]; then
    echo "No saved copies of the data."
    return
  fi
  echo "Saved copies of the data, newest first:"
  for v in $copies; do
    printf '  %s  %s\n' "$v" "$(docker run --rm -v "$v:/v:ro" --entrypoint du "$image" -sh /v 2>/dev/null | cut -f1)"
  done
  note "Delete one with: docker volume rm <name>"
}

copy_volume() { # copy_volume <from> <to>: the stack must be stopped.
  docker volume create "$2" >/dev/null
  docker run --rm --user 0 --network none -v "$1:/from:ro" -v "$2:/to" --entrypoint sh "$image" \
    -c 'find /to -mindepth 1 -delete && cp -a /from/. /to/'
}

schema_of() { docker run --rm --network none --entrypoint cat "$1" server/db/schema.sql 2>/dev/null || true; }

wait_healthy() {
  local id=$1 status restarts
  for _ in $(seq 1 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)
    restarts=$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)
    [[ $status == healthy ]] && return 0
    [[ $status == unhealthy || $restarts -gt 0 ]] && return 1
    [[ $(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null) == exited ]] && return 1
    sleep 2
  done
  return 1
}

start_and_check() {
  step "Starting Relay"
  docker compose up -d --no-build --remove-orphans
  local id
  id=$(container)
  if ! wait_healthy "$id"; then
    printf '\n%sRelay did not become healthy. Its last messages:%s\n' "$red" "$reset" >&2
    docker logs --tail 25 "$id" 2>&1 | sed 's/^/  /' >&2
    return 1
  fi
  printf '%sRelay is healthy.%s\n' "$green" "$reset"
  local origin
  origin=$(env_value RELAY_ORIGIN)
  if [[ -n $origin ]]; then
    local code
    code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$origin/api/health" || true)
    if [[ $code == 200 ]]; then
      printf '%s%s answers.%s\n' "$green" "$origin" "$reset"
    else
      warn "$origin/api/health answered ${code:-nothing}; check the tunnel or proxy."
    fi
  else
    note "Open http://$(docker compose port relay 3090 2>/dev/null || echo 127.0.0.1:3090)"
  fi
}

# Swaps the image and the one from before the last redeploy, so going back twice is where it began.
rollback() {
  docker image inspect "$rollback_image" >/dev/null 2>&1 || fail "There's no earlier image to go back to."
  local id now
  id=$(container)
  now=$(docker inspect -f '{{.Image}}' "$id" 2>/dev/null || docker image inspect -f '{{.Id}}' "$image")
  if volume_exists "$volume" && [[ "$(schema_of "$rollback_image")" != "$(schema_of "$now")" ]]; then
    warn "The earlier image has a different database schema, so it would refuse the data Relay has now."
    if ! $interactive || ! confirm "Go back anyway?"; then
      fail "Nothing changed. Redeploy with --data save or --data wipe instead."
    fi
  fi
  step "Going back to the previous image"
  docker tag "$rollback_image" "$image"
  docker tag "$now" "$rollback_image"
  start_and_check
}

if [[ $action == list ]]; then
  list_saved
  exit 0
fi
if [[ $action == rollback ]]; then
  interactive=$([[ $yes == true ]] && echo false || echo true)
  confirm "Go back to the image from before the last redeploy, keeping the data?" || exit 1
  rollback
  exit $?
fi

# ---------------------------------------------------------------------------------------------
# Choices

head_line=$(git log -1 --format='%h %s')
changed=$(git status --porcelain | wc -l | tr -d ' ')

if $interactive; then
  n=$(choose "Build from" 1 \
    "The latest commit: $head_line" \
    "The working tree, including $changed uncommitted change(s)" \
    "Another commit, branch or tag")
  case $n in
    1) from=commit ;;
    2) from=working ;;
    3) read -r -p "Commit, branch or tag: " from ;;
  esac
  data_state="none yet"
  volume_exists "$volume" && data_state="exists"
  n=$(choose "Data (currently: $data_state)" 1 \
    "Keep it" \
    "Save a copy, then start with none" \
    "Delete it for good, then start with none" \
    "Replace it with a saved copy")
  case $n in
    1) data=keep ;;
    2) data=save ;;
    3) data=wipe ;;
    4)
      copies=$(saved_copies)
      [[ -n $copies ]] || fail "There are no saved copies."
      # shellcheck disable=SC2086
      n=$(choose "Saved copy" 1 $copies)
      data="restore=$(echo "$copies" | sed -n "${n}p")"
      ;;
  esac
fi
from=${from:-commit}
data=${data:-keep}

case $data in
  keep | save | wipe) ;;
  restore=latest)
    data="restore=$(saved_copies | head -n 1)"
    [[ $data != restore= ]] || fail "There are no saved copies."
    ;;
  restore=?*) volume_exists "${data#restore=}" || fail "No volume named ${data#restore=}." ;;
  *) fail "--data must be keep, save, wipe or restore=<volume>." ;;
esac

case $from in
  commit) ref=HEAD ;;
  working) ref='' ;;
  *) ref=$from ;;
esac
if [[ -n $ref ]]; then
  sha=$(git rev-parse --verify --quiet "$ref^{commit}") || fail "$ref isn't a commit, branch or tag."
  source_line="commit $(git log -1 --format='%h %s' "$sha")"
  if ((changed > 0)) && [[ $from == commit ]]; then note "$changed uncommitted change(s) will be left out."; fi
else
  source_line="working tree at $head_line, with $changed uncommitted change(s)"
fi

step "Plan"
echo "  Build:  $source_line"
case $data in
  keep) echo "  Data:   keep $volume" ;;
  save) echo "  Data:   save a copy of $volume, then start with none" ;;
  wipe) echo "  Data:   ${red}delete $volume for good${reset}, then start with none" ;;
  restore=*) echo "  Data:   replace $volume with ${data#restore=}" ;;
esac
files=${COMPOSE_FILE:-$(env_value COMPOSE_FILE)}
echo "  Files:  ${files:-compose.yaml}"
confirm "Go ahead?" || exit 1

# ---------------------------------------------------------------------------------------------
# Build

worktree=''
cleanup() { [[ -n $worktree ]] && git worktree remove --force "$worktree" >/dev/null 2>&1 || true; }
trap cleanup EXIT

context=$root
if [[ -n $ref ]]; then
  worktree=$(mktemp -d "${TMPDIR:-/tmp}/relay-deploy.XXXXXX")
  git worktree add --detach --quiet "$worktree" "$sha"
  context=$worktree
fi

current=$(container)
if [[ -n $current ]]; then
  docker tag "$(docker inspect -f '{{.Image}}' "$current")" "$rollback_image"
fi

step "Building $image"
docker build -t "$image" "$context"
cleanup
worktree=''

# The database refuses a schema it wasn't made with, and there are no migrations.
if [[ $data == keep ]] && volume_exists "$volume" && [[ -n $current ]] \
  && [[ "$(schema_of "$rollback_image")" != "$(schema_of "$image")" ]]; then
  warn ""
  warn "The database schema changed, so Relay will refuse the data it has."
  if ! $interactive; then
    docker tag "$rollback_image" "$image"
    fail "Nothing changed. Run again with --data save or --data wipe."
  fi
  n=$(choose "What now?" 1 \
    "Save a copy of the data, then start with none" \
    "Delete the data for good, then start with none" \
    "Keep the data anyway" \
    "Stop here; Relay keeps running as it was")
  case $n in
    1) data=save ;;
    2) data=wipe ;;
    3) ;;
    4)
      docker tag "$rollback_image" "$image"
      echo "Nothing changed."
      exit 0
      ;;
  esac
fi

# ---------------------------------------------------------------------------------------------
# Data

if [[ $data != keep ]]; then
  step "Stopping Relay"
  docker compose down
fi

case $data in
  save)
    if volume_exists "$volume"; then
      copy="${saved_prefix}$(date +%Y%m%d-%H%M%S)"
      step "Saving the data to $copy"
      copy_volume "$volume" "$copy"
      docker volume rm "$volume" >/dev/null
    fi
    ;;
  wipe)
    if volume_exists "$volume"; then
      if ! $yes && $interactive; then
        read -r -p "Type ${bold}delete${reset} to delete $volume for good: " answer
        [[ $answer == delete ]] || fail "Not deleted. Relay is stopped; run docker compose up -d to start it as it was."
      fi
      step "Deleting the data"
      docker volume rm "$volume" >/dev/null
    fi
    ;;
  restore=*)
    source_volume=${data#restore=}
    if volume_exists "$volume"; then
      copy="${saved_prefix}$(date +%Y%m%d-%H%M%S)"
      step "Saving the current data to $copy first"
      copy_volume "$volume" "$copy"
    fi
    step "Restoring $source_volume"
    copy_volume "$source_volume" "$volume"
    ;;
esac

# ---------------------------------------------------------------------------------------------
# Start

if ! start_and_check; then
  if [[ -n $current ]] && ($yes || confirm "Go back to the previous image?"); then
    rollback || true
  fi
  exit 1
fi

if [[ $data == save || $data == wipe ]]; then
  echo
  warn "Relay starts empty: whoever opens it first creates the administrator. Do setup now."
  if [[ $(env_value RELAY_SETUP_KEY) == true ]]; then note "Setup key: docker compose exec relay cat /data/setup.key"; fi
fi
if [[ -n ${copy:-} ]]; then note "The earlier data is in $copy (scripts/redeploy.sh --list)."; fi
