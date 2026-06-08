#!/usr/bin/env bash
# Build and deploy this extension into ~/.vscode/extensions so VS Code loads it.
# TypeScript project: compiles src/ -> out/, then installs a flat runtime copy.
set -euo pipefail
cd "$(dirname "$0")"

npm run compile

read -r NAME PUBLISHER VERSION < <(python3 -c "
import json
p = json.load(open('package.json'))
print(p['name'], p['publisher'], p['version'])
")

DEST="$HOME/.vscode/extensions/${PUBLISHER}.${NAME}-${VERSION}"
echo "Deploying ${PUBLISHER}.${NAME}@${VERSION} -> $DEST"

mkdir -p "$DEST"
cp out/extension.js "$DEST/extension.js"
cp README.md "$DEST/README.md"
# Copy the icon if the manifest references one (keeps its relative path).
if [ -f images/icon.png ]; then
  mkdir -p "$DEST/images"
  cp images/icon.png "$DEST/images/icon.png"
fi
# Copy the manifest, but force main to the flat layout used in the install dir.
python3 -c "
import json
p = json.load(open('package.json'))
p['main'] = './extension.js'
for k in ('scripts', 'devDependencies'):
    p.pop(k, None)
json.dump(p, open('$DEST/package.json', 'w'), indent=2)
"
echo "Done. Restart VS Code (or Developer: Reload Window) to pick up changes."
