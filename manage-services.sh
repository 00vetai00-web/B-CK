#!/usr/bin/env bash
# BACK — interactive service management TUI
# Usage: ./manage-services.sh [services.conf]
# Requires: bash 4+, curl optional for health checks

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${1:-$SCRIPT_DIR/services.conf}"
LOG_DIR="${BACK_ADMIN_LOG_DIR:-$SCRIPT_DIR/logs}"
ADMIN_LOG="$LOG_DIR/admin-actions.log"
STATE_DIR="${BACK_STATE_DIR:-$SCRIPT_DIR/.service-state}"

# ─── logging ───────────────────────────────────────────────────────────────
log_action() {
  mkdir -p "$LOG_DIR"
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$ADMIN_LOG"
}

die() {
  echo "ERROR: $*" >&2
  log_action "ERROR: $*"
  exit 1
}

need_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "Missing dependency: $c"
  done
}

# ─── config parser (simple INI) ────────────────────────────────────────────
declare -A SVC_WORKDIR SVC_START SVC_STOP SVC_PID SVC_LOG SVC_PORT SVC_CFG SVC_UPDATE
SVC_LIST=()

load_config() {
  [[ -f "$CONFIG_FILE" ]] || die "Config not found: $CONFIG_FILE (copy services.conf.example)"
  local section=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    if [[ "$line" =~ ^\[(.+)\]$ ]]; then
      section="${BASH_REMATCH[1]}"
      SVC_LIST+=("$section")
      continue
    fi
    if [[ -z "$section" ]]; then continue; fi
    if [[ "$line" =~ ^([^=]+)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"
      val="${val%\"}"; val="${val#\"}"
      case "$key" in
        workdir)      SVC_WORKDIR[$section]="$val" ;;
        start_cmd)    SVC_START[$section]="$val" ;;
        stop_cmd)     SVC_STOP[$section]="$val" ;;
        pid_file)     SVC_PID[$section]="$val" ;;
        log_file)     SVC_LOG[$section]="$val" ;;
        port)         SVC_PORT[$section]="$val" ;;
        config_files) SVC_CFG[$section]="$val" ;;
        update_cmd)   SVC_UPDATE[$section]="$val" ;;
      esac
    fi
  done <"$CONFIG_FILE"
  [[ ${#SVC_LIST[@]} -gt 0 ]] || die "No services defined in $CONFIG_FILE"
}

resolve_path() {
  local base="$1" rel="$2"
  if [[ "$rel" = /* ]]; then echo "$rel"; else echo "$base/$rel"; fi
}

read_pid() {
  local svc="$1"
  local wd="${SVC_WORKDIR[$svc]:-}"
  local pf="${SVC_PID[$svc]:-}"
  [[ -n "$wd" && -n "$pf" ]] || return 1
  local path
  path="$(resolve_path "$wd" "$pf")"
  [[ -f "$path" ]] || return 1
  local pid
  pid="$(cat "$path" 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

write_pid() {
  local svc="$1" pid="$2"
  local wd="${SVC_WORKDIR[$svc]}"
  local pf="${SVC_PID[$svc]:-.pid}"
  local path
  path="$(resolve_path "$wd" "$pf")"
  echo "$pid" >"$path"
}

clear_pid() {
  local svc="$1"
  local wd="${SVC_WORKDIR[$svc]:-}"
  local pf="${SVC_PID[$svc]:-}"
  [[ -n "$wd" && -n "$pf" ]] || return 0
  rm -f "$(resolve_path "$wd" "$pf")"
}

svc_status() {
  local svc="$1"
  local pid
  if pid="$(read_pid "$svc" 2>/dev/null)"; then
    echo "RUNNING (pid $pid)"
    return 0
  fi
  # fallback: port check
  local port="${SVC_PORT[$svc]:-}"
  if [[ -n "$port" ]] && command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -q ":${port} "; then
      echo "RUNNING (port $port in use)"
      return 0
    fi
  fi
  echo "STOPPED"
  return 1
}

svc_start() {
  local svc="$1"
  local wd="${SVC_WORKDIR[$svc]:-}"
  local cmd="${SVC_START[$svc]:-}"
  [[ -n "$wd" && -n "$cmd" ]] || die "[$svc] missing workdir or start_cmd"
  [[ -d "$wd" ]] || die "[$svc] workdir not found: $wd"

  if read_pid "$svc" >/dev/null 2>&1; then
    echo "[$svc] already running"
    return 0
  fi

  mkdir -p "$STATE_DIR" "$LOG_DIR"
  local logf="${SVC_LOG[$svc]:-}"
  local logpath=""
  if [[ -n "$logf" ]]; then
    logpath="$(resolve_path "$wd" "$logf")"
    mkdir -p "$(dirname "$logpath")"
  fi

  log_action "START $svc cwd=$wd cmd=$cmd"
  local newpid
  cd "$wd" || die "[$svc] cannot cd to $wd"
  if [[ -n "$logpath" ]]; then
    nohup bash -c "$cmd" >>"$logpath" 2>&1 &
  else
    nohup bash -c "$cmd" >/dev/null 2>&1 &
  fi
  newpid=$!
  write_pid "$svc" "$newpid"
  sleep 1
  if pid="$(read_pid "$svc" 2>/dev/null)"; then
    echo "[$svc] started (pid $pid)"
    log_action "STARTED $svc pid=$pid"
  else
    die "[$svc] failed to start — check logs"
  fi
}

svc_stop() {
  local svc="$1"
  local custom="${SVC_STOP[$svc]:-}"
  log_action "STOP $svc"

  if [[ -n "$custom" ]]; then
    local wd="${SVC_WORKDIR[$svc]}"
    (cd "$wd" && bash -c "$custom") || true
    clear_pid "$svc"
    echo "[$svc] stopped (custom command)"
    log_action "STOPPED $svc custom"
    return 0
  fi

  local pid
  if pid="$(read_pid "$svc" 2>/dev/null)"; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    clear_pid "$svc"
    echo "[$svc] stopped (pid $pid)"
    log_action "STOPPED $svc pid=$pid"
    return 0
  fi
  echo "[$svc] not running"
}

svc_restart() {
  local svc="$1"
  log_action "RESTART $svc"
  svc_stop "$svc"
  sleep 1
  svc_start "$svc"
}

svc_resources() {
  local svc="$1"
  local pid
  pid="$(read_pid "$svc" 2>/dev/null)" || { echo "[$svc] not running"; return 1; }
  if command -v ps >/dev/null 2>&1; then
    ps -p "$pid" -o pid=,pcpu=,pmem=,rss=,etime=,comm= 2>/dev/null | awk -v s="$svc" '{printf "[%s] pid=%s CPU=%s%% MEM=%s%% RSS=%sKB elapsed=%s %s\n",s,$1,$2,$3,$4,$5,$6}'
  else
    echo "[$svc] pid=$pid (ps not available)"
  fi
}

svc_backup() {
  local svc="$1"
  local wd="${SVC_WORKDIR[$svc]:-}"
  local files="${SVC_CFG[$svc]:-}"
  [[ -n "$files" ]] || { echo "[$svc] no config_files defined"; return 1; }
  mkdir -p "$STATE_DIR/backups"
  local stamp
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  local dest="$STATE_DIR/backups/${svc}-${stamp}.tar.gz"
  local list=()
  local f
  IFS=',' read -ra parts <<<"$files"
  for f in "${parts[@]}"; do
    f="${f#"${f%%[![:space:]]*}"}}"
    f="${f%"${f##*[![:space:]]}"}"
    [[ -f "$(resolve_path "$wd" "$f")" ]] && list+=("$f")
  done
  [[ ${#list[@]} -gt 0 ]] || die "[$svc] no config files found to backup"
  (
    cd "$wd" || exit 1
    tar -czf "$dest" "${list[@]}"
  )
  echo "[$svc] backup -> $dest"
  log_action "BACKUP $svc -> $dest"
}

svc_logs() {
  local svc="$1" follow="${2:-0}"
  local wd="${SVC_WORKDIR[$svc]:-}"
  local logf="${SVC_LOG[$svc]:-}"
  [[ -n "$logf" ]] || die "[$svc] no log_file configured"
  local path
  path="$(resolve_path "$wd" "$logf")"
  [[ -f "$path" ]] || die "[$svc] log not found: $path"
  log_action "LOGS $svc follow=$follow"
  if [[ "$follow" == "1" ]]; then
    tail -n 80 -f "$path"
  else
    tail -n 80 "$path"
  fi
}

svc_update() {
  local svc="$1"
  local wd="${SVC_WORKDIR[$svc]:-}"
  local cmd="${SVC_UPDATE[$svc]:-}"
  [[ -n "$cmd" ]] || { echo "[$svc] no update_cmd configured"; return 1; }
  log_action "UPDATE $svc"
  (cd "$wd" && bash -c "$cmd") || die "[$svc] update failed"
  echo "[$svc] update complete"
  log_action "UPDATED $svc"
}

pick_service() {
  local i=1 s
  echo "" >&2
  echo "Services:" >&2
  for s in "${SVC_LIST[@]}"; do
    printf '  %d) %s — %s\n' "$i" "$s" "$(svc_status "$s" 2>/dev/null || true)" >&2
    ((i++)) || true
  done
  echo "" >&2
  read -rp "Select service [1-${#SVC_LIST[@]}]: " pick
  [[ "$pick" =~ ^[0-9]+$ ]] && ((pick>=1 && pick<=${#SVC_LIST[@]})) || die "Invalid selection"
  echo "${SVC_LIST[$((pick-1))]}"
}

menu() {
  clear 2>/dev/null || true
  echo "╔══════════════════════════════════════╗"
  echo "║     BACK — Service Management TUI      ║"
  echo "╚══════════════════════════════════════╝"
  echo "Config: $CONFIG_FILE"
  echo "Admin log: $ADMIN_LOG"
  echo ""
  echo "  1) Start service"
  echo "  2) Stop service"
  echo "  3) Restart service"
  echo "  4) Status (all)"
  echo "  5) Tail logs (follow)"
  echo "  6) Tail logs (last 80 lines)"
  echo "  7) Backup configuration"
  echo "  8) Resource usage (CPU/RAM)"
  echo "  9) Update service"
  echo "  0) Exit"
  echo ""
}

main() {
  need_cmd bash mkdir date
  load_config
  mkdir -p "$LOG_DIR" "$STATE_DIR"
  log_action "TUI session start config=$CONFIG_FILE"

  while true; do
    menu
    read -rp "Choice: " choice
    case "${choice:-}" in
      1) svc="$(pick_service)"; svc_start "$svc" ;;
      2) svc="$(pick_service)"; svc_stop "$svc" ;;
      3) svc="$(pick_service)"; svc_restart "$svc" ;;
      4)
        for svc in "${SVC_LIST[@]}"; do
          printf '  %-16s %s\n' "$svc" "$(svc_status "$svc" 2>/dev/null || echo STOPPED)"
        done
        read -rp "Press Enter…" _
        ;;
      5) svc="$(pick_service)"; svc_logs "$svc" 1 ;;
      6) svc="$(pick_service)"; svc_logs "$svc" 0; read -rp "Press Enter…" _ ;;
      7) svc="$(pick_service)"; svc_backup "$svc"; read -rp "Press Enter…" _ ;;
      8) svc="$(pick_service)"; svc_resources "$svc"; read -rp "Press Enter…" _ ;;
      9) svc="$(pick_service)"; svc_update "$svc"; read -rp "Press Enter…" _ ;;
      0) log_action "TUI session end"; echo "Bye."; exit 0 ;;
      *) echo "Invalid choice" ;;
    esac
  done
}

# CLI shortcut: ./manage-services.sh status back-proxy
if [[ "${1:-}" == "status" && -n "${2:-}" ]]; then
  CONFIG_FILE="${3:-$SCRIPT_DIR/services.conf}"
  load_config
  svc_status "$2" || exit 1
  exit 0
fi

main