#!/bin/bash
# What app/linux.Dockerfile's container runs: build, install, check.
set -euo pipefail
rsync -a --delete --exclude node_modules --exclude /app/target --exclude /dist --exclude /app/binaries --exclude /app/staged /src/ /work/
cd /work
bun install --frozen-lockfile
# linuxdeploy is an AppImage itself, and a container has no FUSE
export APPIMAGE_EXTRACT_AND_RUN=1
bun scripts/build-app.ts
bundle=app/target/release/bundle
cp "$bundle"/appimage/*.AppImage "$bundle"/deb/*.deb /out/
ls -la /out

# a display, a session bus and a microphone (the monitor of a null sink), as a desktop has them
export DISPLAY=:99
Xvfb :99 -screen 0 1600x1000x24 >/dev/null 2>&1 &
eval "$(dbus-launch --sh-syntax)"
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=desk >/dev/null
pactl set-default-source desk.monitor
sleep 1

apt-get install -y "$(ls /out/*.deb)" >/dev/null 2>&1 || dpkg -i /out/*.deb
status=0
echo "== the .deb (/usr/bin/obeya)"
bun scripts/check-app.ts /usr/bin/obeya || status=1
echo "== the AppImage"
chmod +x /out/*.AppImage
bun scripts/check-app.ts "$(ls /out/*.AppImage)" || status=1
exit $status
