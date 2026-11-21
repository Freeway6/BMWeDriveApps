#!/bin/sh
# The head unit runs the apps on Node 8.16: flags syntax and library calls it does not have.
cd "$(dirname "$0")/.."
if grep -nE '\?\.[a-zA-Z_\[(]|\?\?|\.flat(Map)?\(|Object\.fromEntries|catch \{|globalThis|\.trimStart|\.trimEnd|\.matchAll|[0-9]_[0-9]|\b[0-9]+n\b|Promise\.allSettled|\.at\(-?[0-9]|replaceAll\(|recursive: true' lib/*.js apps/*/main.js | grep -vE '^[^:]+:[0-9]+:\s*(/?\*|//)'; then
    echo 'Node 8: not supported (above)'; exit 1
fi
echo 'Node 8: ok'
