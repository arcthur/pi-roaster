#!/usr/bin/env bash

set -euo pipefail

limit="${1:-30}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error=not_a_git_repo"
  exit 1
fi

messages="$(git log "-${limit}" --pretty=format:%s 2>/dev/null || true)"

if [ -z "${messages}" ]; then
  echo "language=ENGLISH"
  echo "style=PLAIN"
  echo "total=0"
  echo "korean=0"
  echo "english=0"
  echo "semantic=0"
  echo "short=0"
  exit 0
fi

total="$(printf '%s\n' "${messages}" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
korean="$(printf '%s\n' "${messages}" | grep -Ec '[가-힣]' || true)"
english="$((total - korean))"
semantic_regex='^(feat|fix|chore|refactor|docs|test|ci|style|perf|build|revert)(\([^)]+\))?(!)?:[[:space:]].+'
semantic="$(printf '%s\n' "${messages}" | grep -Eic "${semantic_regex}" || true)"
short="$(printf '%s\n' "${messages}" | awk 'NF > 0 && NF <= 3 { count++ } END { print count + 0 }')"
half="$(((total + 1) / 2))"

if [ "${korean}" -ge "${english}" ]; then
  language="KOREAN"
else
  language="ENGLISH"
fi

if [ "${semantic}" -ge "${half}" ]; then
  style="SEMANTIC"
elif [ "${short}" -ge "${half}" ]; then
  style="SHORT"
else
  style="PLAIN"
fi

echo "language=${language}"
echo "style=${style}"
echo "total=${total}"
echo "korean=${korean}"
echo "english=${english}"
echo "semantic=${semantic}"
echo "short=${short}"
echo "sample_1=$(printf '%s\n' "${messages}" | sed -n '1p')"
echo "sample_2=$(printf '%s\n' "${messages}" | sed -n '2p')"
echo "sample_3=$(printf '%s\n' "${messages}" | sed -n '3p')"
