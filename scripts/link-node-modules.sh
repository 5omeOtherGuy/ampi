#!/usr/bin/env bash
# Worktree setup helper. Points a task worktree's `node_modules` at the primary
# checkout's install via a relative symlink, so parallel worktrees share one
# 300+ MB install instead of each running `npm ci`. Source stays isolated per
# worktree; only the dependency tree is shared.
#
# This is the sanctioned setup step for a new worktree (AGENTS.md "Landing a
# change").
# It is safe and idempotent:
#   - Refuses to run from the primary checkout (it already owns these).
#   - No-op if node_modules is already the correct symlink.
#   - Refuses to clobber a real node_modules directory (a worktree that
#     deliberately installed its own, e.g. a different peer-dep version).
#
# IMPORTANT: never run `npm install`/`npm ci` while node_modules is this shared
# symlink — writes would mutate the primary's install for every worktree.
# Remove the symlink first if a worktree truly needs its own install.
#
# Exit codes:
#   0   linked, or already linked
#   10  real node_modules dir present; refusing to clobber (remove it first)
#   11  primary checkout has no node_modules to link against
#   12  called from the primary checkout; nothing to do
#   20  not inside a git repository / git failure

set -euo pipefail

note() { printf 'link-node-modules: %s\n' "$*"; }
warn() { printf 'link-node-modules: %s\n' "$*" >&2; }

if ! WT_TOP=$(git rev-parse --show-toplevel 2>/dev/null); then
  warn "not inside a git repository"
  exit 20
fi

# Primary checkout = parent of the shared git common dir.
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || true)
[ -n "$COMMON_DIR" ] || { warn "cannot resolve git common dir"; exit 20; }
case "$COMMON_DIR" in
  /*) ;;                         # already absolute
  *) COMMON_DIR="$WT_TOP/$COMMON_DIR" ;;
esac
PRIMARY_TOP=$(cd "$(dirname "$COMMON_DIR")" && pwd)

if [ "$WT_TOP" = "$PRIMARY_TOP" ]; then
  note "this is the primary checkout ($PRIMARY_TOP); nothing to link"
  exit 12
fi

if [ ! -d "$PRIMARY_TOP/node_modules" ]; then
  warn "primary checkout has no node_modules ($PRIMARY_TOP/node_modules)"
  warn "install it there first (npm ci in the primary checkout)"
  exit 11
fi

TARGET="$WT_TOP/node_modules"

# Already a symlink: accept if it resolves into the primary, else refuse.
if [ -L "$TARGET" ]; then
  if [ "$(cd "$TARGET" 2>/dev/null && pwd -P)" = "$(cd "$PRIMARY_TOP/node_modules" && pwd -P)" ]; then
    note "already linked to primary node_modules"
    exit 0
  fi
  warn "node_modules is a symlink pointing elsewhere; leaving it untouched"
  exit 10
fi

if [ -d "$TARGET" ]; then
  warn "a real node_modules directory exists in this worktree; refusing to clobber"
  warn "remove it explicitly if you want to share the primary install:"
  warn "  rm -rf '$TARGET' && scripts/link-node-modules.sh"
  exit 10
fi

# Build a relative link target so the worktree stays portable.
REL=$(realpath --relative-to="$WT_TOP" "$PRIMARY_TOP/node_modules" 2>/dev/null || echo "$PRIMARY_TOP/node_modules")
ln -s "$REL" "$TARGET"
note "linked node_modules -> $REL"
exit 0
