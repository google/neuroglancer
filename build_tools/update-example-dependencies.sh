#!/bin/bash -xve

cd "$(dirname "$0")/.."

npm install
npm run build-package

for x in examples/*/*; do
  if [ -e "${x}/package.json" ]; then
    ( cd $x && npx npm-check-updates -u && npm install ) &
  fi
done

wait
