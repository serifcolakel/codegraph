#!/bin/sh
set -eu

project="${1:-$(pwd)}"
codegraph="$(cd "$(dirname "$0")/../.." && pwd)"
hooks_dir="$project/.githooks"
mkdir -p "$hooks_dir"

for hook in post-commit post-merge post-checkout; do
  sed "s#/absolute/path/to/codegraph#$codegraph#g" "$codegraph/integrations/git-hooks/$hook" > "$hooks_dir/$hook"
  chmod +x "$hooks_dir/$hook"
done

git -C "$project" config core.hooksPath .githooks
echo "Installed CodeGraph git hooks in $hooks_dir"
echo "Undo with: git -C $project config --unset core.hooksPath"
