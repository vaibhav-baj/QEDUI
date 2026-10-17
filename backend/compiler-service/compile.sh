#!/bin/bash
set -u

file="${1:-}"
if [ -z "$file" ]; then
  echo "No Lean file provided."
  exit 1
fi

if [ ! -f "$file" ]; then
  echo "Lean file not found: $file"
  exit 1
fi

lean "$file" 2>&1
