#!/bin/bash

# Same as travis deploy script

# npm install
npm run build
rm -r static/
mkdir static/
cp -r ./dist/dev/* static/
virtualenv env
source env/bin/activate
pip install -t lib -r requirements.txt
dev_appserver.py app.yaml