#!/usr/bin/env bash
set -euo pipefail

REPO="daronyondem/agent-cockpit"
CHANNEL="production"
VERSION=""
PORT="3334"
INSTALL_DIR="${HOME}/Library/Application Support/Agent Cockpit"
DEV_DIR="${HOME}/agent-cockpit"
INSTALL_NODE="auto"
OPEN_BROWSER="true"
NODE_MAJOR="22"
NODE_BIN_DIR=""
NODE_RUNTIME_PATH=""
NODE_RUNTIME_SOURCE=""
NODE_RUNTIME_VERSION=""
NODE_RUNTIME_NPM_VERSION=""
NODE_RUNTIME_DIR=""
export NPM_CONFIG_AUDIT=false
export NPM_CONFIG_FUND=false
export NPM_CONFIG_UPDATE_NOTIFIER=false

usage() {
  cat <<'USAGE'
Usage: scripts/install-macos.sh [options]

Options:
  --channel production|dev   Install from GitHub Releases or main. Default: production.
  --version <version>        Production release version to install. Defaults to latest.
  --repo <owner/name>        GitHub repository. Default: daronyondem/agent-cockpit.
  --install-dir <path>       Install root. Default: ~/Library/Application Support/Agent Cockpit.
  --dev-dir <path>           Dev checkout path. Default: ~/agent-cockpit.
  --port <port>              Local HTTP port. Default: 3334.
  --install-node             Install a private Node.js runtime when Node 22+ is missing. Default.
  --no-install-node          Fail instead of installing a private Node.js runtime.
  --skip-open                Do not open the browser after PM2 starts.
  -h, --help                 Show this help.

Examples:
  scripts/install-macos.sh --channel production
  scripts/install-macos.sh --channel dev --dev-dir ~/github/agent-cockpit
USAGE
}

log() {
  printf '[agent-cockpit] %s\n' "$*"
}

fail() {
  printf '[agent-cockpit] ERROR: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      CHANNEL="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      VERSION="${VERSION#v}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --dev-dir)
      DEV_DIR="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --install-node)
      INSTALL_NODE="auto"
      shift
      ;;
    --no-install-node)
      INSTALL_NODE="false"
      shift
      ;;
    --skip-open)
      OPEN_BROWSER="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

if [[ "$CHANNEL" != "production" && "$CHANNEL" != "dev" ]]; then
  fail "--channel must be production or dev"
fi

if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
  fail "--port must be numeric"
fi

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "$command_name is required. $install_hint"
  fi
}

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail "This installer currently supports macOS only."
  fi

  local arch
  arch="$(uname -m)"
  case "$arch" in
    arm64|x86_64)
      log "Detected macOS ${arch}."
      ;;
    *)
      fail "Unsupported Mac CPU architecture: ${arch}"
      ;;
  esac
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "$major" =~ ^[0-9]+$ && "$major" -ge 22 ]] && command -v npm >/dev/null 2>&1; then
      log "Found Node.js $(node -v) and npm $(npm -v)."
      NODE_RUNTIME_SOURCE="system"
      NODE_RUNTIME_VERSION="$(node -p "process.versions.node")"
      NODE_RUNTIME_NPM_VERSION="$(npm -v)"
      NODE_BIN_DIR="$(dirname "$(command -v node)")"
      return
    fi
  fi

  if [[ "$INSTALL_NODE" != "false" ]]; then
    install_private_node
    return
  fi

  fail "Node.js 22+ and npm are required. Re-run without --no-install-node to let the installer install a private Node runtime, or install Node from https://nodejs.org."
}

install_private_node() {
  local arch
  local node_arch
  arch="$(uname -m)"
  case "$arch" in
    arm64)
      node_arch="arm64"
      ;;
    x86_64)
      node_arch="x64"
      ;;
    *)
      fail "Unsupported Mac CPU architecture for Node.js: ${arch}"
      ;;
  esac

  local runtime_root="${INSTALL_DIR}/runtime"
  local current_link="${runtime_root}/node"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  local checksums_path="${tmp_dir}/SHASUMS256.txt"
  local shasums_url="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt"

  log "Node.js ${NODE_MAJOR}+ and npm were not found. Installing a private Node.js runtime."
  download_file "$shasums_url" "$checksums_path"

  local tarball_name
  tarball_name="$(awk -v arch="$node_arch" '$2 ~ "^node-v[0-9]+[.][0-9]+[.][0-9]+-darwin-" arch "[.]tar[.]gz$" { print $2; exit }' "$checksums_path")"
  if [[ -z "$tarball_name" ]]; then
    fail "Could not find a macOS ${node_arch} Node.js ${NODE_MAJOR} tarball in SHASUMS256.txt"
  fi

  local node_version="${tarball_name#node-v}"
  node_version="${node_version%-darwin-${node_arch}.tar.gz}"
  local tarball_path="${tmp_dir}/${tarball_name}"
  download_file "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${tarball_name}" "$tarball_path"
  verify_checksum "$tarball_path" "$tarball_name" "$checksums_path"

  mkdir -p "$runtime_root"
  local extracted_dir="${runtime_root}/node-v${node_version}-darwin-${node_arch}"
  local final_dir="${runtime_root}/node-v${node_version}"
  rm -rf "$extracted_dir" "$final_dir"
  tar -xzf "$tarball_path" -C "$runtime_root"
  mv "$extracted_dir" "$final_dir"

  if [[ -e "$current_link" && ! -L "$current_link" ]]; then
    fail "${current_link} exists and is not a symlink"
  fi
  rm -f "$current_link"
  ln -s "$final_dir" "$current_link"
  rm -rf "$tmp_dir"

  NODE_BIN_DIR="${current_link}/bin"
  export PATH="${NODE_BIN_DIR}:${PATH}"
  NODE_RUNTIME_PATH="$PATH"
  NODE_RUNTIME_SOURCE="private"
  NODE_RUNTIME_VERSION="$node_version"
  NODE_RUNTIME_NPM_VERSION="$("${NODE_BIN_DIR}/npm" -v)"
  NODE_RUNTIME_DIR="$current_link"
  log "Using private Node.js $("${NODE_BIN_DIR}/node" -v) and npm $("${NODE_BIN_DIR}/npm" -v)."
}

random_hex() {
  node -e "process.stdout.write(require('crypto').randomBytes(Number(process.argv[1])).toString('hex'))" "$1"
}

json_string() {
  node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$1"
}

json_read() {
  local file="$1"
  local expression="$2"
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const value=(${expression}); if (value === undefined || value === null) process.exit(2); process.stdout.write(String(value));" "$file"
}

download_file() {
  local url="$1"
  local dest="$2"
  log "Downloading ${url}"
  curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$dest"
}

verify_checksum() {
  local file_path="$1"
  local file_name="$2"
  local checksums_path="$3"
  local expected
  expected="$(awk -v name="$file_name" '$2 == name { print $1 }' "$checksums_path")"
  if [[ -z "$expected" ]]; then
    fail "No checksum found for ${file_name}"
  fi

  local actual
  actual="$(shasum -a 256 "$file_path" | awk '{ print $1 }')"
  if [[ "$actual" != "$expected" ]]; then
    fail "Checksum mismatch for ${file_name}"
  fi
  log "Verified SHA256 for ${file_name}."
}

write_env_file() {
  local app_dir="$1"
  local data_dir="$2"
  local session_secret="$3"
  local setup_token="$4"
  local runtime_path="$5"

  cat > "${app_dir}/.env" <<ENV
PORT=${PORT}
SESSION_SECRET=${session_secret}
AUTH_SETUP_TOKEN=${setup_token}
AGENT_COCKPIT_DATA_DIR="${data_dir}"
WEB_BUILD_MODE=auto
AUTH_ENABLE_LEGACY_OAUTH=false
ENV
  if [[ -n "$runtime_path" ]]; then
    cat >> "${app_dir}/.env" <<ENV
PATH="${runtime_path}"
ENV
  fi
}

write_ecosystem_config() {
  local app_dir="$1"
  local data_dir="$2"
  local session_secret="$3"
  local setup_token="$4"
  local runtime_path="$5"
  local app_dir_json
  local data_dir_json
  local session_secret_json
  local setup_token_json
  local runtime_path_line=""

  app_dir_json="$(json_string "$app_dir")"
  data_dir_json="$(json_string "$data_dir")"
  session_secret_json="$(json_string "$session_secret")"
  setup_token_json="$(json_string "$setup_token")"
  if [[ -n "$runtime_path" ]]; then
    local runtime_path_json
    runtime_path_json="$(json_string "$runtime_path")"
    runtime_path_line="      PATH: ${runtime_path_json},"
  fi

  cat > "${app_dir}/ecosystem.config.js" <<CONFIG
module.exports = {
  apps: [{
    name: 'agent-cockpit',
    script: 'server.ts',
    interpreter: './node_modules/.bin/tsx',
    cwd: ${app_dir_json},
    env: {
      PORT: ${PORT},
      SESSION_SECRET: ${session_secret_json},
      AUTH_SETUP_TOKEN: ${setup_token_json},
      AGENT_COCKPIT_DATA_DIR: ${data_dir_json},
      WEB_BUILD_MODE: 'auto',
      AUTH_ENABLE_LEGACY_OAUTH: 'false',
${runtime_path_line}
    },
  }],
};
CONFIG
}

write_install_manifest() {
  local data_dir="$1"
  local channel="$2"
  local source="$3"
  local version="$4"
  local branch="$5"
  local install_dir="$6"
  local app_dir="$7"
  local node_runtime_source="$8"
  local node_runtime_version="$9"
  local node_runtime_npm_version="${10}"
  local node_runtime_bin_dir="${11}"
  local node_runtime_dir="${12}"

  mkdir -p "$data_dir"
  node - "$data_dir/install.json" "$channel" "$source" "$REPO" "$version" "$branch" "$install_dir" "$app_dir" "$data_dir" "$node_runtime_source" "$node_runtime_version" "$node_runtime_npm_version" "$node_runtime_bin_dir" "$node_runtime_dir" "$NODE_MAJOR" <<'NODE'
const fs = require('fs');
const [
  manifestPath,
  channel,
  source,
  repo,
  version,
  branch,
  installDir,
  appDir,
  dataDir,
  nodeRuntimeSource,
  nodeRuntimeVersion,
  nodeRuntimeNpmVersion,
  nodeRuntimeBinDir,
  nodeRuntimeDir,
  nodeRuntimeRequiredMajor,
] = process.argv.slice(2);

const manifest = {
  schemaVersion: 1,
  channel,
  source,
  repo,
  version,
  branch: branch || null,
  installDir,
  appDir,
  dataDir,
  installedAt: new Date().toISOString(),
  welcomeCompletedAt: null,
  nodeRuntime: nodeRuntimeSource ? {
    source: nodeRuntimeSource,
    version: nodeRuntimeVersion || null,
    npmVersion: nodeRuntimeNpmVersion || null,
    binDir: nodeRuntimeBinDir || null,
    runtimeDir: nodeRuntimeDir || null,
    requiredMajor: Number(nodeRuntimeRequiredMajor) || null,
    updatedAt: new Date().toISOString(),
  } : null,
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

install_dependencies() {
  local app_dir="$1"
  log "Installing root dependencies."
  (cd "$app_dir" && npm ci --no-audit --no-fund)
  log "Installing mobile PWA dependencies."
  (cd "$app_dir" && npm --prefix mobile/AgentCockpitPWA ci --no-audit --no-fund)
}

ensure_built_assets() {
  local app_dir="$1"
  local force_build="$2"
  if [[ "$force_build" == "true" || ! -f "${app_dir}/public/v2-built/index.html" ]]; then
    log "Building desktop web assets."
    (cd "$app_dir" && npm run web:build)
  fi
  if [[ "$force_build" == "true" || ! -f "${app_dir}/public/mobile-built/index.html" ]]; then
    log "Building mobile PWA assets."
    (cd "$app_dir" && npm run mobile:build)
  fi
}

start_pm2() {
  local app_dir="$1"
  log "Starting Agent Cockpit with local PM2."
  (cd "$app_dir" && npx pm2 startOrRestart ecosystem.config.js --update-env)
  (cd "$app_dir" && npx pm2 save)
}

wait_for_server() {
  local app_dir="$1"
  local setup_url="http://127.0.0.1:${PORT}/auth/setup"
  log "Waiting for Agent Cockpit to answer at ${setup_url}."
  for _attempt in {1..90}; do
    if curl -fsS --max-time 2 -o /dev/null "$setup_url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Agent Cockpit did not answer at ${setup_url}. Check logs with: cd \"${app_dir}\" && npx pm2 logs agent-cockpit --lines 100"
}

open_setup() {
  local setup_url="http://localhost:${PORT}/auth/setup"
  log "Agent Cockpit is ready at ${setup_url}"
  if [[ "$OPEN_BROWSER" == "true" ]]; then
    open "$setup_url"
  fi
}

install_production() {
  local releases_dir="${INSTALL_DIR}/releases"
  local current_link="${INSTALL_DIR}/current"
  local data_dir="${INSTALL_DIR}/data"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  local release_download_base
  if [[ -n "$VERSION" ]]; then
    release_download_base="https://github.com/${REPO}/releases/download/v${VERSION}"
  else
    release_download_base="https://github.com/${REPO}/releases/latest/download"
  fi

  local manifest_path="${tmp_dir}/release-manifest.json"
  local checksums_path="${tmp_dir}/SHA256SUMS"
  download_file "${release_download_base}/release-manifest.json" "$manifest_path"
  download_file "${release_download_base}/SHA256SUMS" "$checksums_path"
  verify_checksum "$manifest_path" "release-manifest.json" "$checksums_path"

  local release_version
  local package_root
  local tarball_name
  release_version="$(json_read "$manifest_path" "data.version")"
  package_root="$(json_read "$manifest_path" "data.packageRoot")"
  tarball_name="$(json_read "$manifest_path" "data.artifacts.find((artifact) => artifact.role === 'app-tarball').name")"
  local tarball_path="${tmp_dir}/${tarball_name}"
  download_file "${release_download_base}/${tarball_name}" "$tarball_path"
  verify_checksum "$tarball_path" "$tarball_name" "$checksums_path"

  mkdir -p "$releases_dir" "$data_dir"
  rm -rf "${releases_dir:?}/${package_root}"
  tar -xzf "$tarball_path" -C "$releases_dir"

  local versioned_app_dir="${releases_dir}/${package_root}"
  if [[ ! -f "${versioned_app_dir}/server.ts" ]]; then
    fail "Extracted release is missing server.ts"
  fi

  if [[ -e "$current_link" && ! -L "$current_link" ]]; then
    fail "${current_link} exists and is not a symlink"
  fi
  rm -f "$current_link"
  ln -s "$versioned_app_dir" "$current_link"

  local session_secret
  local setup_token
  session_secret="$(random_hex 48)"
  setup_token="$(random_hex 32)"

  install_dependencies "$current_link"
  ensure_built_assets "$current_link" "false"
  write_env_file "$current_link" "$data_dir" "$session_secret" "$setup_token" "$NODE_RUNTIME_PATH"
  write_ecosystem_config "$current_link" "$data_dir" "$session_secret" "$setup_token" "$NODE_RUNTIME_PATH"
  write_install_manifest "$data_dir" "production" "github-release" "$release_version" "" "$INSTALL_DIR" "$current_link" "$NODE_RUNTIME_SOURCE" "$NODE_RUNTIME_VERSION" "$NODE_RUNTIME_NPM_VERSION" "$NODE_BIN_DIR" "$NODE_RUNTIME_DIR"
  start_pm2 "$current_link"
  wait_for_server "$current_link"

  log "First-run setup token: ${setup_token}"
  open_setup
}

install_dev() {
  local data_dir="${INSTALL_DIR}/data"
  mkdir -p "$INSTALL_DIR" "$data_dir"

  require_command git "Install Xcode Command Line Tools with: xcode-select --install"
  if [[ ! -d "${DEV_DIR}/.git" ]]; then
    log "Cloning ${REPO} into ${DEV_DIR}."
    git clone "https://github.com/${REPO}.git" "$DEV_DIR"
  else
    log "Updating existing dev checkout at ${DEV_DIR}."
    git -C "$DEV_DIR" fetch origin main
    git -C "$DEV_DIR" checkout main
    git -C "$DEV_DIR" pull --ff-only origin main
  fi

  local dev_version
  dev_version="$(node -e "process.stdout.write(require(process.argv[1]).version)" "${DEV_DIR}/package.json")"
  local session_secret
  local setup_token
  session_secret="$(random_hex 48)"
  setup_token="$(random_hex 32)"

  install_dependencies "$DEV_DIR"
  ensure_built_assets "$DEV_DIR" "true"
  write_env_file "$DEV_DIR" "$data_dir" "$session_secret" "$setup_token" "$NODE_RUNTIME_PATH"
  write_ecosystem_config "$DEV_DIR" "$data_dir" "$session_secret" "$setup_token" "$NODE_RUNTIME_PATH"
  write_install_manifest "$data_dir" "dev" "git-main" "$dev_version" "main" "$INSTALL_DIR" "$DEV_DIR" "$NODE_RUNTIME_SOURCE" "$NODE_RUNTIME_VERSION" "$NODE_RUNTIME_NPM_VERSION" "$NODE_BIN_DIR" "$NODE_RUNTIME_DIR"
  start_pm2 "$DEV_DIR"
  wait_for_server "$DEV_DIR"

  log "First-run setup token: ${setup_token}"
  open_setup
}

require_macos
require_command curl "Install curl through Xcode Command Line Tools or Homebrew."
require_command tar "Install tar through Xcode Command Line Tools."
require_command shasum "Install Perl shasum through Xcode Command Line Tools."
ensure_node

if [[ "$CHANNEL" == "production" ]]; then
  install_production
else
  install_dev
fi
