# Builds the Linux app (AppImage and .deb) and checks it, where there is no Linux machine: a Mac
# with Docker builds for its own architecture (arm64 on Apple silicon).
#
#   docker build -f app/linux.Dockerfile -t obeya-linux-app app
#   docker run --rm -v "$PWD":/src:ro -v obeya-cargo:/root/.cargo/registry -v obeya-target:/work/app/target \
#     -v "$PWD/dist/linux-app":/out obeya-linux-app
#
# The run copies the checkout into /work (without its node_modules, which are another platform's),
# builds with scripts/build-app.ts, puts the bundles into /out, installs the .deb and checks both
# with scripts/check-app.ts in a virtual display, with a PulseAudio null sink's monitor as microphone.
# Ubuntu 22.04: an AppImage runs on systems with the glibc it was built with or newer.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl wget file git unzip ca-certificates rsync xz-utils patchelf \
    libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav gstreamer1.0-pulseaudio \
    xvfb xauth pulseaudio dbus-x11 ffmpeg x11-apps imagemagick \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash -s bun-v1.3.12 && ln -s /root/.bun/bin/bun /usr/local/bin/bun
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/root/.cargo/bin:$PATH
COPY linux-run.sh /usr/local/bin/obeya-linux-run
CMD ["obeya-linux-run"]
