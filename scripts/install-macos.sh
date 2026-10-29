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
AUTO_START="true"
NODE_MAJOR="22"
NODE_BIN_DIR=""
NODE_RUNTIME_PATH=""
NODE_RUNTIME_SOURCE=""
NODE_RUNTIME_VERSION=""
NODE_RUNTIME_NPM_VERSION=""
NODE_RUNTIME_DIR=""
INSTALL_LOG=""
WORK_DIR=""
PREVIOUS_APP_DIR=""
ACTIVATED="false"
STARTUP_CHANGED="false"
CANDIDATE_DIR=""
CANDIDATE_APP_DIR=""
PORT_EXPLICIT="false"
LAUNCH_AGENT_LABEL="com.agent-cockpit.server"
export NPM_CONFIG_AUDIT=false
export NPM_CONFIG_FUND=false
export NPM_CONFIG_LOGLEVEL=error
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
  --no-auto-start            Do not register Agent Cockpit to start at user login.
  --skip-open                Do not open the browser after PM2 starts.
  -h, --help                 Show this help.

Examples:
  scripts/install-macos.sh --channel production
  scripts/install-macos.sh --channel dev --dev-dir ~/github/agent-cockpit
USAGE
}

log() {
  printf '[agent-cockpit] %s\n' "$*"
  if [[ -n "$INSTALL_LOG" ]]; then
    printf '[agent-cockpit] %s\n' "$*" >> "$INSTALL_LOG"
  fi
}

fail() {
  printf '[agent-cockpit] ERROR: %s\n' "$*" >&2
  if [[ -n "$INSTALL_LOG" ]]; then
    printf '[agent-cockpit] ERROR: %s\n' "$*" >> "$INSTALL_LOG"
  fi
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
      PORT_EXPLICIT="true"
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
    --no-auto-start)
      AUTO_START="false"
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

if [[ ! "$PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 )); then
  fail "--port must be a number from 1 to 65535"
fi
PORT="$((10#$PORT))"

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
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
    if [[ "$major" =~ ^[0-9]+$ && "$major" -ge 22 ]] && npm -v >/dev/null 2>&1 && npx -v >/dev/null 2>&1; then
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
  local existing_bin="${INSTALL_DIR}/runtime/node/bin"
  if [[ -x "${existing_bin}/node" ]] &&
    "${existing_bin}/node" -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" &&
    PATH="${existing_bin}:$PATH" "${existing_bin}/npm" -v >/dev/null 2>&1 &&
    PATH="${existing_bin}:$PATH" "${existing_bin}/npx" -v >/dev/null 2>&1; then
    NODE_BIN_DIR="$existing_bin"
    export PATH="${NODE_BIN_DIR}:$PATH"
    NODE_RUNTIME_SOURCE="private"
    NODE_RUNTIME_VERSION="$(node -p "process.versions.node")"
    NODE_RUNTIME_NPM_VERSION="$(npm -v)"
    NODE_RUNTIME_DIR="${INSTALL_DIR}/runtime/node"
    log "Reusing private Node.js ${NODE_RUNTIME_VERSION}."
    return
  fi
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
  local extracted_dir="${tmp_dir}/node-v${node_version}-darwin-${node_arch}"
  local final_dir="${runtime_root}/node-v${node_version}"
  [[ ! -e "$final_dir" ]] || final_dir="${final_dir}-repair-${RANDOM}${RANDOM}"
  tar -xzf "$tarball_path" -C "$tmp_dir"
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

path_contains_dir() {
  local path_value="$1"
  local dir="$2"
  [[ ":${path_value}:" == *":${dir}:"* ]]
}

runtime_path_with_user_cli_bins() {
  local base_path="$1"
  local result="$base_path"
  local node_prefix=""
  if [[ -n "${NODE_BIN_DIR:-}" && "$result" == "${NODE_BIN_DIR}:"* ]]; then
    node_prefix="${NODE_BIN_DIR}:"
    result="${result#${NODE_BIN_DIR}:}"
  fi

  local dirs=(
    "${HOME}/.local/bin"
    "${HOME}/.npm-global/bin"
    "${HOME}/.npm/bin"
    "${HOME}/.bun/bin"
    "${HOME}/.yarn/bin"
    "/opt/homebrew/bin"
  )
  local i
  for (( i=${#dirs[@]}-1; i>=0; i-- )); do
    local dir="${dirs[$i]}"
    if ! path_contains_dir "${node_prefix}${result}" "$dir"; then
      result="${dir}:${result}"
    fi
  done
  printf '%s%s' "$node_prefix" "$result"
}

random_hex() {
  node -e "process.stdout.write(require('crypto').randomBytes(Number(process.argv[1])).toString('hex'))" "$1"
}

json_string() {
  node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$1"
}

shell_quote() {
  node -e "process.stdout.write(\"'\" + process.argv[1].replace(/'/g, \"'\\\\''\") + \"'\")" "$1"
}

xml_escape() {
  node -e "process.stdout.write(process.argv[1].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&apos;'))" "$1"
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
  if [[ -n "${AGENT_COCKPIT_INSTALL_TEST_RELEASE_DIR:-}" && "$url" == https://github.com/*/releases/* ]]; then
    cp "${AGENT_COCKPIT_INSTALL_TEST_RELEASE_DIR}/${url##*/}" "$dest"
    return
  fi
  curl -fsSL --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 --retry-max-time 600 "$url" -o "$dest"
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

  local preserved=""
  if [[ -f "${app_dir}/.env" ]]; then
    preserved="$(grep -Ev '^(PORT|SESSION_SECRET|AUTH_SETUP_TOKEN|AGENT_COCKPIT_DATA_DIR|WEB_BUILD_MODE|AUTH_ENABLE_LEGACY_OAUTH|PATH|PM2_HOME)=' "${app_dir}/.env" || true)"
  fi
  printf '%s\n' "$preserved" > "${app_dir}/.env"
  cat >> "${app_dir}/.env" <<ENV
PORT=${PORT}
SESSION_SECRET=${session_secret}
AUTH_SETUP_TOKEN=${setup_token}
AGENT_COCKPIT_DATA_DIR="${data_dir}"
WEB_BUILD_MODE=auto
AUTH_ENABLE_LEGACY_OAUTH=false
PM2_HOME=$(json_string "${PM2_HOME:-${HOME}/.pm2}")
ENV
  if [[ -n "$runtime_path" ]]; then
    cat >> "${app_dir}/.env" <<ENV
PATH="${runtime_path}"
ENV
  fi
  chmod 600 "${app_dir}/.env"
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
      PM2_HOME: $(json_string "${PM2_HOME:-${HOME}/.pm2}"),
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
  local startup_kind="${13}"
  local startup_name="${14}"

  mkdir -p "$data_dir"
  node - "$data_dir/install.json" "$channel" "$source" "$REPO" "$version" "$branch" "$install_dir" "$app_dir" "$data_dir" "$node_runtime_source" "$node_runtime_version" "$node_runtime_npm_version" "$node_runtime_bin_dir" "$node_runtime_dir" "$NODE_MAJOR" "$startup_kind" "$startup_name" <<'NODE'
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
  startupKind,
  startupName,
] = process.argv.slice(2);

let previous = {};
try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
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
  installedAt: previous.installedAt || new Date().toISOString(),
  welcomeCompletedAt: previous.welcomeCompletedAt || null,
  nodeRuntime: nodeRuntimeSource ? {
    source: nodeRuntimeSource,
    version: nodeRuntimeVersion || null,
    npmVersion: nodeRuntimeNpmVersion || null,
    binDir: nodeRuntimeBinDir || null,
    runtimeDir: nodeRuntimeDir || null,
    requiredMajor: Number(nodeRuntimeRequiredMajor) || null,
    updatedAt: new Date().toISOString(),
  } : null,
  startup: startupKind ? {
    kind: startupKind,
    name: startupName || null,
    scope: 'current-user',
  } : null,
};

fs.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
fs.renameSync(`${manifestPath}.tmp`, manifestPath);
NODE
}

install_dependencies() {
  local app_dir="$1"
  log "Installing root dependencies."
  (cd "$app_dir" && npm ci --no-audit --no-fund --loglevel=error)
  if [[ "$CHANNEL" == "dev" || ! -f "${app_dir}/public/mobile-built/index.html" ]]; then
    log "Installing mobile PWA dependencies."
    (cd "$app_dir" && npm --prefix mobile/AgentCockpitPWA ci --no-audit --no-fund --loglevel=error)
  fi
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
  (cd "$app_dir" && npx pm2 delete agent-cockpit >/dev/null 2>&1 || true)
  (cd "$app_dir" && npx pm2 startOrRestart ecosystem.config.js --update-env) || return $?
  (cd "$app_dir" && npx pm2 save)
}

repair_restart_script_permissions() {
  local data_dir="$1"
  local restart_script="${data_dir}/restart.sh"
  if [[ -f "$restart_script" ]]; then
    chmod 755 "$restart_script" || log "Warning: unable to repair self-update restart script permissions at ${restart_script}."
  fi
}

startup_kind() {
  if [[ "$AUTO_START" == "true" ]]; then
    printf 'launch-agent'
  else
    printf 'manual'
  fi
}

startup_name() {
  if [[ "$AUTO_START" == "true" ]]; then
    printf '%s' "$LAUNCH_AGENT_LABEL"
  fi
}

write_helper_scripts() {
  local app_dir="$1"
  local runtime_path="$2"
  local bin_dir="${INSTALL_DIR}/bin"
  local log_dir="${INSTALL_DIR}/pm2/logs"
  local app_dir_q
  local runtime_path_q
  local pm2_home_q
  app_dir_q="$(shell_quote "$app_dir")"
  runtime_path_q="$(shell_quote "$runtime_path")"
  pm2_home_q="$(shell_quote "${PM2_HOME:-${HOME}/.pm2}")"
  mkdir -p "$bin_dir" "$log_dir"

  cat > "${bin_dir}/start-agent-cockpit.sh" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
APP_DIR=${app_dir_q}
RUNTIME_PATH=${runtime_path_q}
export PM2_HOME=${pm2_home_q}
if [[ -n "\$RUNTIME_PATH" ]]; then
  export PATH="\$RUNTIME_PATH"
fi
cd "\$APP_DIR"
npx pm2 startOrRestart ecosystem.config.js --update-env
npx pm2 save
SCRIPT

  cat > "${bin_dir}/stop-agent-cockpit.sh" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
APP_DIR=${app_dir_q}
RUNTIME_PATH=${runtime_path_q}
export PM2_HOME=${pm2_home_q}
if [[ -n "\$RUNTIME_PATH" ]]; then
  export PATH="\$RUNTIME_PATH"
fi
cd "\$APP_DIR"
npx pm2 delete agent-cockpit >/dev/null 2>&1 || true
npx pm2 save >/dev/null 2>&1 || true
SCRIPT

  chmod 755 "${bin_dir}/start-agent-cockpit.sh" "${bin_dir}/stop-agent-cockpit.sh"
}

startup_is_owned() {
  local target
  target="$(plutil -extract ProgramArguments.0 raw -o - "$1" 2>/dev/null)" || return 1
  node - "$target" "${INSTALL_DIR}/bin/start-agent-cockpit.sh" <<'NODE'
const fs = require('fs'), path = require('path');
function canonical(value) {
  let current = path.resolve(value), missing = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
      missing.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}
try { process.exit(canonical(process.argv[2]) === canonical(process.argv[3]) ? 0 : 1); } catch { process.exit(1); }
NODE
}

register_login_startup() {
  local existing="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
  if [[ -f "$existing" ]] && ! startup_is_owned "$existing"; then
    if [[ "$AUTO_START" != "true" ]]; then
      log "Leaving the startup entry for a different installation unchanged."
      return
    fi
    fail "The existing startup entry belongs to another installation. It will not be replaced."
  fi
  if [[ "$AUTO_START" != "true" ]]; then
    if [[ -f "$existing" ]]; then
      STARTUP_CHANGED="true"
      launchctl unload "$existing" >/dev/null 2>&1 || true
      rm -f "$existing"
    fi
    log "Skipping login startup registration."
    return
  fi

  local launch_agents_dir="${HOME}/Library/LaunchAgents"
  local plist_path="${launch_agents_dir}/${LAUNCH_AGENT_LABEL}.plist"
  local start_script="${INSTALL_DIR}/bin/start-agent-cockpit.sh"
  local log_dir="${INSTALL_DIR}/pm2/logs"
  mkdir -p "$launch_agents_dir" "$log_dir"

  local label_xml
  local start_script_xml
  local stdout_xml
  local stderr_xml
  label_xml="$(xml_escape "$LAUNCH_AGENT_LABEL")"
  start_script_xml="$(xml_escape "$start_script")"
  stdout_xml="$(xml_escape "${log_dir}/autostart-out.log")"
  stderr_xml="$(xml_escape "${log_dir}/autostart-error.log")"

  STARTUP_CHANGED="true"
  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label_xml}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${start_script_xml}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${stdout_xml}</string>
  <key>StandardErrorPath</key>
  <string>${stderr_xml}</string>
</dict>
</plist>
PLIST

  launchctl unload "$plist_path" >/dev/null 2>&1 || true
  log "Registering macOS LaunchAgent ${LAUNCH_AGENT_LABEL}."
}

activate_login_startup() {
  if [[ "$AUTO_START" != "true" ]]; then return; fi
  local plist_path="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
  if ! startup_is_owned "$plist_path"; then fail "Cannot activate a startup entry owned by another installation."; fi
  if ! launchctl load -w "$plist_path"; then
    fail "Failed to register macOS LaunchAgent at ${plist_path}."
  fi
}

pm2_logs_command() {
  local app_dir="$1"
  if [[ -n "$NODE_BIN_DIR" ]]; then
    printf 'cd "%s" && PATH="%s:$PATH" "%s/npx" pm2 logs agent-cockpit --lines 100' "$app_dir" "$NODE_BIN_DIR" "$NODE_BIN_DIR"
    return
  fi
  printf 'cd "%s" && npx pm2 logs agent-cockpit --lines 100' "$app_dir"
}

wait_for_server() {
  local app_dir="$1"
  local expected_version="${2:-$(node -p "require(process.argv[1]).version" "${app_dir}/package.json")}"
  local attempts="${3:-90}"
  local setup_url="http://127.0.0.1:${PORT}/auth/setup"
  log "Waiting for Agent Cockpit to answer at ${setup_url}."
  for (( _attempt=0; _attempt<attempts; _attempt++ )); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/chat/version" 2>/dev/null |
      node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{process.exit(JSON.parse(s).version===process.argv[1]?0:1)}catch{process.exit(1)}})" "$expected_version" &&
      curl -fsS --max-time 2 -o /dev/null "$setup_url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  local logs_command
  logs_command="$(pm2_logs_command "$app_dir")"
  fail "Agent Cockpit did not answer at ${setup_url}. Check logs with: ${logs_command}"
}

open_setup() {
  local setup_url="http://localhost:${PORT}/auth/setup"
  log "Agent Cockpit is ready at ${setup_url}"
  if [[ "$OPEN_BROWSER" == "true" ]]; then
    open "$setup_url" || log "Warning: unable to open the browser. Open ${setup_url} manually."
  fi
}

env_value() {
  local name="$1"
  [[ -n "$PREVIOUS_APP_DIR" ]] || return 0
  node -e "const fs=require('fs');try{const s=fs.readFileSync(process.argv[1],'utf8');const m=s.match(new RegExp('^'+process.argv[2]+'=(.*)$','m'));if(m)process.stdout.write(m[1].trim().replace(/^['\"]|['\"]$/g,''))}catch{}" "${PREVIOUS_APP_DIR}/.env" "$name"
}

prepare_install() {
  mkdir -p "$INSTALL_DIR" || fail "Install directory is not writable: ${INSTALL_DIR}"
  INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
  mkdir -p "${INSTALL_DIR}/logs"
  INSTALL_LOG="${INSTALL_DIR}/logs/install.log"
  touch "$INSTALL_LOG"
  chmod 600 "$INSTALL_LOG"
  WORK_DIR="$(mktemp -d "${INSTALL_DIR}/.install-XXXXXX")"
  trap install_exit EXIT
  log "Stage 1/4: checking the installation. Diagnostic log: ${INSTALL_LOG}"
}

capture_existing_install() {
  PREVIOUS_APP_DIR="$(node - "$INSTALL_DIR" <<'NODE'
const fs = require('fs'), path = require('path'), root = process.argv[2];
try {
  const state = JSON.parse(fs.readFileSync(path.join(root, 'data/install.json'), 'utf8'));
  if (state.appDir && fs.existsSync(state.appDir)) { process.stdout.write(fs.realpathSync(state.appDir)); process.exit(); }
} catch {}
const current = path.join(root, 'current');
if (fs.existsSync(current)) process.stdout.write(fs.realpathSync(current));
NODE
)"
  if [[ "$CHANNEL" == "dev" && -z "$PREVIOUS_APP_DIR" && -f "${DEV_DIR}/.env" ]]; then
    PREVIOUS_APP_DIR="$DEV_DIR"
  fi
  if [[ "$PORT_EXPLICIT" != "true" ]]; then
    PORT="$(env_value PORT)"
    PORT="${PORT:-3334}"
  fi
  PORT="$(node -p 'Number(process.argv[1])' -- "$PORT")"
  if [[ -z "${PM2_HOME:-}" ]]; then PM2_HOME="$(env_value PM2_HOME)"; fi
  export PM2_HOME
  PM2_HOME="$(node -e "process.stdout.write(require('path').resolve(process.argv[1]))" "${PM2_HOME:-${HOME}/.pm2}")"
  node - "$PORT" "$INSTALL_DIR" "$PREVIOUS_APP_DIR" <<'NODE'
const net = require('net'), http = require('http'), fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const port = Number(process.argv[2]), root = process.argv[3], previous = process.argv[4];
function canonical(value) { try { return fs.realpathSync(value); } catch { return null; } }
function alive(pid) { try { if (!Number.isInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch { return false; } }
function owned() {
  try {
    if (!previous || !alive(Number(fs.readFileSync(path.join(process.env.PM2_HOME, 'pm2.pid'), 'utf8')))) return false;
    // The PM2 CLI starts a daemon when one is missing; ownership checks must not.
    const query = `
const path = require('path'), root = process.argv[1];
const socket = require(path.join(root, 'modules/pm2-axon')).socket('req');
const client = new (require(path.join(root, 'modules/pm2-axon-rpc')).Client)(socket);
let finished = false;
function finish(error, list) {
  if (finished) return;
  finished = true; socket.close();
  if (error) process.exit(1);
  process.stdout.write(JSON.stringify(list), () => process.exit(0));
}
socket.once('error', finish);
socket.once('reconnect attempt', () => finish(new Error('Daemon unavailable')));
socket.once('connect', () => client.call('getMonitorData', {}, finish));
socket.connect(require(path.join(root, 'constants.js')).DAEMON_RPC_PORT);
`;
    const output = execFileSync(process.execPath, ['-e', query, '--', path.join(previous, 'node_modules/pm2')], { timeout: 3000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(output.toString()).some(entry => {
      const env = entry.pm2_env || {};
      return entry.name === 'agent-cockpit' && env.status === 'online' && alive(entry.pid) &&
        Number(env.PORT ?? env.env?.PORT) === port && canonical(env.pm_cwd) === canonical(previous) &&
        canonical(env.AGENT_COCKPIT_DATA_DIR ?? env.env?.AGENT_COCKPIT_DATA_DIR) === canonical(path.join(root, 'data'));
    });
  } catch { return false; }
}
function rejectUnlessOwned() {
  if (owned()) process.exit(0);
  console.error(`Port ${port} is already used by another application`); process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('Port must be from 1 to 65535'); process.exit(1); }
const server = net.createServer();
server.once('error', () => {
  const req = http.get({host:'127.0.0.1', port, path:'/api/chat/install/status', timeout:2000}, res => {
    let s=''; res.on('data', c=>s+=c).on('end', () => {
      try { if (res.statusCode===200 && canonical(JSON.parse(s).installDir)===root) process.exit(0); } catch {}
      rejectUnlessOwned();
    });
  });
  req.on('timeout',()=>req.destroy()).on('error',rejectUnlessOwned);
});
server.listen(port, '127.0.0.1', () => server.close());
NODE
}

snapshot_activation() {
  [[ ! -f "${INSTALL_DIR}/data/install.json" ]] || cp "${INSTALL_DIR}/data/install.json" "${WORK_DIR}/install.json"
  [[ ! -d "${INSTALL_DIR}/bin" ]] || cp -R "${INSTALL_DIR}/bin" "${WORK_DIR}/bin"
  local startup="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
  if [[ -f "$startup" ]]; then
    if startup_is_owned "$startup"; then
      cp "$startup" "${WORK_DIR}/startup"
      if launchctl list "$LAUNCH_AGENT_LABEL" >/dev/null 2>&1; then touch "${WORK_DIR}/startup-enabled"; fi
    elif [[ "$AUTO_START" == "true" ]]; then
      fail "The existing startup entry belongs to another installation. It will not be replaced."
    fi
  fi
  ACTIVATED="true"
}

switch_current() {
  node - "${INSTALL_DIR}/current" "$1" <<'NODE'
const fs = require('fs'), [link, target] = process.argv.slice(2), temporary = `${link}.install-${process.pid}`;
try {
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, link);
} finally { fs.rmSync(temporary, { force: true }); }
NODE
}

install_exit() {
  local code=$?
  local candidate_stopped="false"
  trap - EXIT
  if [[ "$code" -ne 0 ]]; then
    log "Installation failed (exit ${code}). Diagnostic log: ${INSTALL_LOG}"
    if [[ "$ACTIVATED" == "true" ]]; then
      set +e
      log "Restoring the previous installation."
      if (cd "${INSTALL_DIR}/current" && npx pm2 delete agent-cockpit >/dev/null 2>&1); then candidate_stopped="true"; fi
      if [[ -n "$PREVIOUS_APP_DIR" ]]; then switch_current "$PREVIOUS_APP_DIR"; else rm -f "${INSTALL_DIR}/current"; fi
      if [[ -f "${WORK_DIR}/install.json" ]]; then cp "${WORK_DIR}/install.json" "${INSTALL_DIR}/data/install.json"; else rm -f "${INSTALL_DIR}/data/install.json"; fi
      if [[ -d "${WORK_DIR}/bin" ]]; then cp -R "${WORK_DIR}/bin/." "${INSTALL_DIR}/bin/"; else rm -f "${INSTALL_DIR}/bin/start-agent-cockpit.sh" "${INSTALL_DIR}/bin/stop-agent-cockpit.sh"; fi
      if [[ "$STARTUP_CHANGED" == "true" ]]; then
        local startup="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
        launchctl unload "$startup" >/dev/null 2>&1
        if [[ -f "${WORK_DIR}/startup" ]]; then
          cp "${WORK_DIR}/startup" "$startup"
          [[ ! -f "${WORK_DIR}/startup-enabled" ]] || launchctl load -w "$startup" >/dev/null 2>&1
        else rm -f "$startup"; fi
      fi
      if [[ -n "$PREVIOUS_APP_DIR" ]] && ! start_pm2 "$PREVIOUS_APP_DIR"; then
        log "Warning: the previous release could not restart. Use the saved helpers and diagnostic log."
      fi
    fi
  fi
  if [[ "$code" -ne 0 && -n "$CANDIDATE_DIR" && ( "$ACTIVATED" != "true" || "$candidate_stopped" == "true" ) ]]; then
    if ! node - "$CANDIDATE_DIR" "$CANDIDATE_APP_DIR" "$INSTALL_DIR" "$ACTIVATED" <<'NODE'
const fs = require('fs'), path = require('path');
const [candidate, app, root, activated] = process.argv.slice(2);
function resolve(value) {
  try { return fs.realpathSync(value); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      if (fs.lstatSync(value).isSymbolicLink()) return path.resolve(path.dirname(value), fs.readlinkSync(value));
    } catch (missing) { if (missing.code === 'ENOENT') return null; throw missing; }
    return path.resolve(value);
  }
}
try {
  if (path.dirname(candidate) !== path.join(root, 'releases')) process.exit(1);
  if (activated === 'true') {
    const identity = resolve(app);
    if (!identity) process.exit(1);
    if (resolve(path.join(root, 'current')) === identity) process.exit(0);
    let state = {};
    try { state = JSON.parse(fs.readFileSync(path.join(root, 'data/install.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state.appDir && resolve(state.appDir) === identity) process.exit(0);
  }
  fs.rmSync(candidate, { recursive: true, force: true });
} catch { process.exit(1); }
NODE
    then log "Warning: could not safely clean failed candidate ${CANDIDATE_DIR}."; fi
  fi
  [[ -z "$WORK_DIR" ]] || rm -rf "$WORK_DIR"
  exit "$code"
}

install_production() {
  local releases_dir="${INSTALL_DIR}/releases"
  local current_link="${INSTALL_DIR}/current"
  local data_dir="${INSTALL_DIR}/data"
  local tmp_dir
  tmp_dir="$WORK_DIR"

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
  [[ -z "$VERSION" || "$release_version" == "$VERSION" ]] || fail "Release version mismatch: expected ${VERSION}, received ${release_version}"
  package_root="$(json_read "$manifest_path" "data.packageRoot")"
  [[ "$package_root" =~ ^agent-cockpit-v[0-9A-Za-z.+-]+$ ]] || fail "Invalid release package root"
  if ! tarball_name="$(json_read "$manifest_path" "(() => { const artifact = data.artifacts.find((item) => item.role === 'app-tarball' && item.platform === 'darwin'); return artifact && artifact.name; })()")"; then
    fail "Release manifest does not include a macOS app tarball artifact."
  fi
  [[ "$tarball_name" != */* && "$tarball_name" == *.tar.gz ]] || fail "Invalid release archive name"
  local tarball_path="${tmp_dir}/${tarball_name}"
  download_file "${release_download_base}/${tarball_name}" "$tarball_path"
  verify_checksum "$tarball_path" "$tarball_name" "$checksums_path"

  mkdir -p "$releases_dir" "$data_dir"
  log "Stage 2/4: preparing release ${release_version}."
  local staging_dir
  CANDIDATE_DIR="$(mktemp -d "${releases_dir}/${package_root}-XXXXXX")"
  staging_dir="$CANDIDATE_DIR"
  CANDIDATE_APP_DIR="${staging_dir}/${package_root}"
  tar -xzf "$tarball_path" -C "$staging_dir"

  local versioned_app_dir="${staging_dir}/${package_root}"
  if [[ ! -f "${versioned_app_dir}/server.ts" ]]; then
    fail "Extracted release is missing server.ts"
  fi

  if [[ -e "$current_link" && ! -L "$current_link" ]]; then
    fail "${current_link} exists and is not a symlink"
  fi
  local session_secret
  local setup_token
  session_secret="$(env_value SESSION_SECRET)"
  setup_token="$(env_value AUTH_SETUP_TOKEN)"
  session_secret="${session_secret:-$(random_hex 48)}"
  setup_token="${setup_token:-$(random_hex 32)}"
  [[ ! -f "${PREVIOUS_APP_DIR}/.env" ]] || cp "${PREVIOUS_APP_DIR}/.env" "${versioned_app_dir}/.env"

  install_dependencies "$versioned_app_dir"
  ensure_built_assets "$versioned_app_dir" "false"
  write_env_file "$versioned_app_dir" "$data_dir" "$session_secret" "$setup_token" "$NODE_RUNTIME_PATH"
  snapshot_activation
  log "Stage 3/4: activating the prepared release."
  switch_current "$versioned_app_dir"
  write_ecosystem_config "$current_link" "$data_dir" "$session_secret" "$setup_token" "$NODE_RUNTIME_PATH"
  write_install_manifest "$data_dir" "production" "github-release" "$release_version" "" "$INSTALL_DIR" "$current_link" "$NODE_RUNTIME_SOURCE" "$NODE_RUNTIME_VERSION" "$NODE_RUNTIME_NPM_VERSION" "$NODE_BIN_DIR" "$NODE_RUNTIME_DIR" "$(startup_kind)" "$(startup_name)"
  repair_restart_script_permissions "$data_dir"
  write_helper_scripts "$current_link" "$NODE_RUNTIME_PATH"
  register_login_startup
  start_pm2 "$current_link"
  activate_login_startup
  wait_for_server "$current_link" "$release_version"

  log "Stage 4/4: release ${release_version} is ready."
  printf '[agent-cockpit] First-run setup token: %s\n' "$setup_token"
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
  session_secret="$(env_value SESSION_SECRET)"
  setup_token="$(env_value AUTH_SETUP_TOKEN)"
  session_secret="${session_secret:-$(random_hex 48)}"
  setup_token="${setup_token:-$(random_hex 32)}"

  install_dependencies "$DEV_DIR"
  ensure_built_assets "$DEV_DIR" "true"
  write_env_file "$DEV_DIR" "$data_dir" "$session_secret" "$setup_token" "$NODE_RUNTIME_PATH"
  write_ecosystem_config "$DEV_DIR" "$data_dir" "$session_secret" "$setup_token" "$NODE_RUNTIME_PATH"
  write_install_manifest "$data_dir" "dev" "git-main" "$dev_version" "main" "$INSTALL_DIR" "$DEV_DIR" "$NODE_RUNTIME_SOURCE" "$NODE_RUNTIME_VERSION" "$NODE_RUNTIME_NPM_VERSION" "$NODE_BIN_DIR" "$NODE_RUNTIME_DIR" "$(startup_kind)" "$(startup_name)"
  repair_restart_script_permissions "$data_dir"
  write_helper_scripts "$DEV_DIR" "$NODE_RUNTIME_PATH"
  register_login_startup
  start_pm2 "$DEV_DIR"
  activate_login_startup
  wait_for_server "$DEV_DIR"

  printf '[agent-cockpit] First-run setup token: %s\n' "$setup_token"
  open_setup
}

if [[ "${AGENT_COCKPIT_INSTALL_LIBRARY_ONLY:-}" == "1" ]]; then return 0 2>/dev/null || exit 0; fi
require_macos
require_command curl "Install curl through Xcode Command Line Tools or Homebrew."
require_command tar "Install tar through Xcode Command Line Tools."
require_command shasum "Install Perl shasum through Xcode Command Line Tools."
prepare_install
ensure_node
capture_existing_install
NODE_RUNTIME_PATH="$(runtime_path_with_user_cli_bins "$PATH")"
export PATH="$NODE_RUNTIME_PATH"

if [[ "$CHANNEL" == "production" ]]; then
  install_production
else
  install_dev
fi
