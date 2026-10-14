#!/usr/bin/env bash
# Builds the release package for deployment on servers without access to this build machine:
#   release/<version>/
#     README.md                                  handover guide (docs/handover.md)
#     images/officier-<version>.tar.gz           document server image (docker load -i …)
#     images/officier-qms-gateway-<version>.tar.gz
#     officier-source-<version>.tar.gz           exact sources of both images (also served by the image)
#     deploy/compose.yaml, .env.example, nginx-officier.conf
#     docs/                                      integration API and container notes
#     SHA256SUMS
# The build needs Docker with BuildKit and internet access (base images, npm, apt).
# Usage: bash scripts/package-release.sh 0.2.0
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: bash scripts/package-release.sh <version, e.g. 0.2.0>" >&2
  exit 2
fi
out="release/$version"
# Host networking avoids MTU trouble of nested bridges (WSL, VPN) during npm and apt downloads.
network="${DOCKER_BUILD_NETWORK:-host}"
compress() { if command -v pigz >/dev/null; then pigz -6; else gzip -6; fi; }

rm -rf "$out"
mkdir -p "$out/images" "$out/deploy" "$out/docs"

# 1. Sources of this release: everything needed to rebuild it, without dependencies, outputs and
#    local data. Fixed order and timestamps: the same files give the same archive and revision.
echo "== source archive"
archive=docker/source/officier-source.tar.gz
tmp="$(mktemp)"
tar --sort=name --mtime='2026-01-01 00:00Z' --owner=0 --group=0 --numeric-owner \
  --exclude='./.git' --exclude='*/.git' --exclude='node_modules' --exclude='__pycache__' --exclude='*.log' \
  --exclude='./release' --exclude='./.env' --exclude='./demo/data' --exclude="./$archive" \
  --exclude='./docker/smoke/*.png' --exclude='./docker/smoke/*.pdf' --exclude='./docker/smoke/saved*.docx' \
  --exclude='./docker/smoke/approved*.docx' --exclude='./docker/smoke/document.docx' \
  -cf - . | gzip -9n > "$tmp"
mv "$tmp" "$archive"
chmod 644 "$archive"
# The image records the archive's SHA-1 as its source revision (the build accepts 40 hex digits).
revision="$(sha1sum "$archive" | cut -c1-40)"
echo "source revision $revision ($(du -h "$archive" | cut -f1))"

# 2. Images. Unit tests of the server patches, branding, configuration and the gateway run inside.
echo "== document server image"
docker build --network="$network" --platform linux/amd64 --target officier \
  --build-arg SOURCE_REVISION="$revision" \
  --build-arg OFFICIER_VERSION="$version" \
  --build-arg OFFICIER_SOURCE_URL=/welcome/officier-source.tar.gz \
  -t "officier:$version" .
echo "== QMS gateway image"
docker build --network="$network" --platform linux/amd64 -t "officier-qms-gateway:$version" gateway

# 3. The image must serve exactly the archive it was built from.
embedded="$(docker run --rm --entrypoint sha1sum "officier:$version" /var/www/onlyoffice/documentserver-example/welcome/officier-source.tar.gz | cut -c1-40)"
if [[ "$embedded" != "$revision" ]]; then
  echo "Embedded source archive $embedded does not match $revision" >&2
  exit 1
fi

# 4. Package.
echo "== saving images"
docker save "officier:$version" | compress > "$out/images/officier-$version.tar.gz"
docker save "officier-qms-gateway:$version" | compress > "$out/images/officier-qms-gateway-$version.tar.gz"
cp "$archive" "$out/officier-source-$version.tar.gz"
cp deploy/compose.yaml deploy/nginx-officier.conf "$out/deploy/"
cp .env.example "$out/deploy/.env.example"
cp docs/handover.md "$out/README.md"
cp docs/qms-integration.md docs/container.md "$out/docs/"
(cd "$out" && find . -type f ! -name SHA256SUMS -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum > SHA256SUMS)

echo "== release $version"
echo "source revision: $revision"
(cd "$out" && du -h --max-depth=1 . && cat SHA256SUMS)
