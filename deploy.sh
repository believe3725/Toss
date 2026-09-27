#!/bin/bash
cd ~/Toss-main
NEW_SERVER=$(curl -s https://raw.githubusercontent.com/believe3725/Toss/main/server.js)
NEW_INDEX=$(curl -s https://raw.githubusercontent.com/believe3725/Toss/main/public/index.html)
CHANGED=0
if [ "$(md5sum server.js | awk '{print $1}')" != "$(echo "$NEW_SERVER" | md5sum | awk '{print $1}')" ]; then
  echo "$NEW_SERVER" > server.js
  CHANGED=1
fi
if [ "$(md5sum public/index.html | awk '{print $1}')" != "$(echo "$NEW_INDEX" | md5sum | awk '{print $1}')" ]; then
  echo "$NEW_INDEX" > public/index.html
  CHANGED=1
fi
if [ "$CHANGED" = "1" ]; then
  pkill -f "node server.js"
  sleep 1
  nohup npm start > server.log 2>&1 &
  echo "$(date): 업데이트됨"
fi
