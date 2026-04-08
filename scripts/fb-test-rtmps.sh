#!/bin/sh
# Test RTMPS connectivity to Facebook
KEY="$1"
if [ -z "$KEY" ]; then
  echo "Usage: fb-test-rtmps.sh <stream_key>"
  exit 1
fi
/usr/local/bin/ffmpeg -f lavfi -i "testsrc=duration=5:size=320x240:rate=30" -f lavfi -i "sine=duration=5" -c:v libx264 -c:a aac -f flv "rtmps://live-api-s.facebook.com:443/rtmp/$KEY" 2>&1 | tail -10
