#!/bin/sh
# Keep the editors' font lists in step with custom fonts without restarting DocService.
#   stamp  - record the current custom font set (image build, right after the lists are generated);
#   ensure - before the server starts, regenerate the lists only if that set has changed.
# The generated lists live in the container layer, so the stamp does too (not in a volume).
set -eu
stamp=/usr/share/officier/custom-fonts.sha256

fingerprint() {
  for dir in /usr/share/fonts/truetype/custom /var/www/onlyoffice/Data/custom-fonts; do
    if [ -d "$dir" ]; then find "$dir" -type f -printf '%p %s %T@\n'; fi
  done | sort | sha256sum | cut -d' ' -f1
}

case "${1:-}" in
  stamp)
    fingerprint > "$stamp"
    ;;
  ensure)
    current=$(fingerprint)
    if [ "$current" != "$(cat "$stamp" 2>/dev/null || true)" ]; then
      echo "Custom fonts changed: regenerating font lists before the server starts"
      documentserver-generate-allfonts.sh true
      echo "$current" > "$stamp"
    fi
    ;;
  *)
    echo "usage: $0 stamp|ensure" >&2
    exit 2
    ;;
esac
