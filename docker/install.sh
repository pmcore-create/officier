#!/usr/bin/env bash
set -euo pipefail
root=/var/www/onlyoffice/documentserver

write_launcher() {
  local executable="$1" source="$2"
  cat > "$root/server/$executable" <<EOF
#!/bin/sh
export NODE_CONFIG_DIR="\${NODE_CONFIG_DIR:-/etc/onlyoffice/documentserver}"
exec /usr/local/bin/officier-node "$root/server/$source" "\$@"
EOF
  chmod 755 "$root/server/$executable"
}
write_launcher DocService/gc DocService/sources/gc.js
write_launcher DocService/prepare4shutdown DocService/sources/shutdown.js
write_launcher FileConverter/converter FileConverter/sources/convertermaster.js
write_launcher Metrics/metrics Metrics/node_modules/statsd/bin/statsd

# The Community runtime keeps every open document in DocService memory, and its memory guard opens
# new documents view-only once the heap is planned out. Size the heap to the RAM the container may
# use (60%, the rest is for x2t conversions and nginx); DOCSERVICE_MAX_HEAP_MB overrides it.
cat > "$root/server/DocService/docservice" <<EOF
#!/bin/sh
export NODE_CONFIG_DIR="\${NODE_CONFIG_DIR:-/etc/onlyoffice/documentserver}"
heap="\${DOCSERVICE_MAX_HEAP_MB:-}"
if [ -z "\$heap" ]; then
  total_kb=\$(awk '/^MemTotal:/ {print \$2}' /proc/meminfo)
  limit=\$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo max)
  case "\$limit" in ''|max) limit_kb=\$total_kb ;; *) limit_kb=\$((limit / 1024)) ;; esac
  [ "\$limit_kb" -gt "\$total_kb" ] && limit_kb=\$total_kb
  heap=\$((limit_kb / 1024 * 60 / 100))
  [ "\$heap" -lt 1024 ] && heap=1024
fi
exec /usr/local/bin/officier-node --max-old-space-size="\$heap" "$root/server/DocService/sources/server.js" "\$@"
EOF
chmod 755 "$root/server/DocService/docservice"

# Server tuning (session idle timeout off, smaller per-document memory budget, larger documents);
# local-production-linux.json is read after local.json, which the start script rewrites.
cp /tmp/officier-config/local-production-linux.json /etc/onlyoffice/documentserver/local-production-linux.json

welcome=/var/www/onlyoffice/documentserver-example/welcome
test -d "$welcome"
cp /tmp/officier-welcome.html "$welcome/officier.html"
cp /tmp/officier-welcome.html "$welcome/docker.html"
cp /usr/share/officier/LICENSE "$welcome/officier-license.txt"
cp /usr/share/officier/build.json "$welcome/officier-build.json"

# A release embeds the exact sources of this image (scripts/package-release.sh); the legal page links
# to them, so the AGPL source offer does not depend on an external repository.
if [ -s /tmp/officier-source/officier-source.tar.gz ]; then
  cp /tmp/officier-source/officier-source.tar.gz "$welcome/officier-source.tar.gz"
  export OFFICIER_SOURCE_URL=officier-source.tar.gz
fi

# Hide ONLYOFFICE branding; the modification/source notice stays reachable from File > About
# in every editor (customization.customer in api.js) and on /welcome/officier.html.
/usr/local/bin/officier-node /tmp/officier-branding/apply.js

# QMS review panel: every tracked change and comment with its author, enabled per user by the
# QMS gateway (qms-review on the right, qms-review-left for modes without the right panel).
cp -r /tmp/officier-plugins/qms-review /tmp/officier-plugins/qms-review-left /var/www/onlyoffice/documentserver/sdkjs-plugins/
test -f /var/www/onlyoffice/documentserver/sdkjs-plugins/qms-review/config.json
test -f /var/www/onlyoffice/documentserver/sdkjs-plugins/qms-review-left/config.json

# Font lists, theme previews and the converter's JS cache are built into the image. Upstream
# regenerates them minutes after the container is up and then restarts DocService, which drops every
# open session with its unsaved changes; the image sets GENERATE_FONTS=false instead, and the
# entrypoint regenerates before the server starts when custom fonts change (officier-fonts).
# The argument "true" skips the restart. The script does not stop on errors, so check its output.
documentserver-generate-allfonts.sh true
for generated in sdkjs/common/AllFonts.js server/FileConverter/bin/AllFonts.js server/FileConverter/bin/font_selection.bin \
  sdkjs/word/sdk-all.cache sdkjs/cell/sdk-all.cache sdkjs/slide/sdk-all.cache; do
  test -s "$root/$generated"
done
/usr/local/bin/officier-fonts stamp
test -s /usr/share/officier/custom-fonts.sha256
