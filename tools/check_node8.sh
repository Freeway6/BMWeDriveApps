#!/bin/sh
# The head unit runs the apps on Node 8.16: flags syntax and library calls it does not have.
# Checks lib/ and each app's own modules (not the lib_*.js the build copies into the app folders).
cd "$(dirname "$0")/.."
files=$(ls lib/*.js apps/*/*.js | grep -vE '^apps/[^/]+/lib_')
if grep -nE '\?\.[a-zA-Z_\[(]|\?\?|\.flat(Map)?\(|Object\.fromEntries|catch \{|globalThis|\.trimStart|\.trimEnd|\.matchAll|(^|[^A-Za-z0-9_.])[0-9]+_[0-9]|\b[0-9]+n\b|Promise\.allSettled|\.at\(-?[0-9]|replaceAll\(|recursive: true' $files | grep -vE '^[^:]+:[0-9]+:\s*(/?\*|//)'; then
    echo 'Node 8: not supported (above)'; exit 1
fi
echo 'Node 8: ok'
