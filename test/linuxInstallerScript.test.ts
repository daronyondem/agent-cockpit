import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const scriptPath = path.join(process.cwd(), 'scripts/install-linux.sh');

describe('Linux installer script', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  test('has a safe shell entrypoint and help output', () => {
    expect(source).toContain('#!/usr/bin/env bash');
    expect(source).toContain('set -euo pipefail');

    const help = execFileSync(scriptPath, ['--help'], { encoding: 'utf8' });
    expect(help).toContain('--channel production|dev');
    expect(help).toContain('--install-node');
    expect(help).toContain('--no-install-node');
    expect(help).toContain('--no-auto-start');
    expect(help).toContain('--skip-open');
  });

  test('guards platform and prerequisite installation', () => {
    expect(source).toContain('uname -s');
    expect(source).toContain('This installer currently supports Linux only.');
    expect(source).toContain('grep -qi musl');
    expect(source).toContain('Alpine/musl Linux is not supported by this installer.');
    expect(source).toContain('x86_64');
    expect(source).toContain('Ubuntu 24.04 LTS x64 is the validated Linux target.');
    expect(source).toContain('process.versions.node.split');
    expect(source).toContain('-gt 22');
    expect(source).toContain('-ge 12');
    expect(source).toContain('install_private_node');
    expect(source).toContain('latest-v${NODE_MAJOR}.x/SHASUMS256.txt');
    expect(source).toContain('node-v${node_version}');
    expect(source).toContain('node_arch="x64"');
    expect(source).toContain('linux-${node_arch}.tar.xz');
    expect(source).toContain('tar -xJf');
    expect(source).toContain('NODE_RUNTIME_PATH="$PATH"');
    expect(source).toContain('runtime_path_with_user_cli_bins');
    expect(source).toContain('${HOME}/.local/bin');
    expect(source).toContain('NODE_RUNTIME_PATH="$(runtime_path_with_user_cli_bins "$PATH")"');
    expect(source).toContain('INSTALL_NODE" != "false"');
  });

  test('uses GitHub Release assets for production installs', () => {
    expect(source).toContain('/releases/latest/download');
    expect(source).toContain('/releases/download/v${VERSION}');
    expect(source).toContain('release-manifest.json');
    expect(source).toContain('SHA256SUMS');
    expect(source).toContain('json_read_required');
    expect(source).toContain("item.platform === 'linux' && item.format === 'tar.gz'");
    expect(source).toContain('Release manifest does not include a Linux app tarball artifact.');
    expect(source).toContain('sha256sum');
    expect(source).toContain('tar -xzf');
  });

  test('supports dev installs from main', () => {
    expect(source).toContain('git clone "https://github.com/${REPO}.git" "$DEV_DIR"');
    expect(source).toContain('git -C "$DEV_DIR" fetch origin main');
    expect(source).toContain('git -C "$DEV_DIR" checkout main');
    expect(source).toContain('git -C "$DEV_DIR" pull --ff-only origin main');
    expect(source).toContain('"dev" "git-main"');
  });

  test('generates runtime config, install manifest, and local PM2 startup', () => {
    expect(source).toContain('SESSION_SECRET=${session_secret}');
    expect(source).toContain('AUTH_SETUP_TOKEN=${setup_token}');
    expect(source).toContain('AGENT_COCKPIT_DATA_DIR="${data_dir}"');
    expect(source).toContain('WEB_BUILD_MODE=auto');
    expect(source).toContain('PATH="${runtime_path}"');
    expect(source).toContain('ecosystem.config.js');
    expect(source).toContain('interpreter: \'./node_modules/.bin/tsx\'');
    expect(source).toContain('PATH: ${runtime_path_json}');
    expect(source).toContain('schemaVersion: 1');
    expect(source).toContain('nodeRuntime: nodeRuntimeSource ?');
    expect(source).toContain('npmVersion: nodeRuntimeNpmVersion || null');
    expect(source).toContain('NPM_CONFIG_UPDATE_NOTIFIER=false');
    expect(source).toContain('NPM_CONFIG_AUDIT=false');
    expect(source).toContain('NPM_CONFIG_FUND=false');
    expect(source).toContain('NPM_CONFIG_LOGLEVEL=error');
    expect(source).toContain('npm ci --no-audit --no-fund --loglevel=error');
    expect(source).toContain('npm --prefix mobile/AgentCockpitPWA ci --no-audit --no-fund --loglevel=error');
    expect(source).toContain('repair_restart_script_permissions()');
    expect(source).toContain('chmod 755 "$restart_script"');
    expect(source).toContain('repair_restart_script_permissions "$data_dir"');
    expect(source).toContain('SYSTEMD_SERVICE_NAME="agent-cockpit.service"');
    expect(source).toContain('startup_kind()');
    expect(source).toContain("printf 'systemd-user'");
    expect(source).toContain('write_helper_scripts "$current_link" "$NODE_RUNTIME_PATH"');
    expect(source).toContain('write_helper_scripts "$DEV_DIR" "$NODE_RUNTIME_PATH"');
    expect(source).toContain('start-agent-cockpit.sh');
    expect(source).toContain('stop-agent-cockpit.sh');
    expect(source).toContain('${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user');
    expect(source).toContain('WantedBy=default.target');
    expect(source).toContain('systemctl --user enable "$SYSTEMD_SERVICE_NAME"');
    expect(source).toContain('register_user_startup');
    expect(source).toContain('npx pm2 startOrRestart ecosystem.config.js --update-env');
    expect(source).toContain('npx pm2 save');
    expect(source).toContain('wait_for_server "$current_link"');
    expect(source).toContain('wait_for_server "$DEV_DIR"');
    expect(source).toContain('curl -fsS --max-time 2 -o /dev/null "$setup_url"');
    expect(source).toContain('pm2_logs_command()');
    expect(source).toContain('PATH="%s:$PATH" "%s/npx" pm2 logs agent-cockpit --lines 100');
    expect(source).toContain('xdg-open "$setup_url"');
    expect(source).toContain('Open ${setup_url} in your browser to continue setup.');
    expect(source).toContain('http://localhost:${PORT}/auth/setup');
  });

  test('materializes an isolated user unit and executes its PM2 helpers with spaced paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit linux helper ' "));
    try {
      const app = path.join(root, 'app folder'), config = path.join(root, 'config folder'), tools = path.join(root, 'tool bin');
      for (const dir of [app, config, tools]) fs.mkdirSync(dir);
      const capture = path.join(root, 'calls.txt'), systemctl = path.join(root, 'systemctl.txt');
      fs.writeFileSync(path.join(tools, 'npx'), '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$@" >> "$C52_CAPTURE"\n', { mode: 0o700 });
      const boundary = source.lastIndexOf('\nrequire_linux\n'); expect(boundary).toBeGreaterThan(0);
      const prepare = path.join(root, 'prepare.sh');
      fs.writeFileSync(prepare, source.slice(0, boundary) + `
INSTALL_DIR="$C52_ROOT"
SYSTEMD_SERVICE_NAME="agent-cockpit-cortex-fixture.service"
XDG_CONFIG_HOME="$C52_CONFIG"
systemctl() { printf '%s\\n' "$@" >> "$C52_SYSTEMCTL"; }
write_helper_scripts "$C52_APP" "$C52_PATH"
register_user_startup
`);
      const env = { ...process.env, C52_ROOT: root, C52_CONFIG: config, C52_APP: app, C52_PATH: `${tools}:${process.env.PATH}`,
        C52_CAPTURE: capture, C52_SYSTEMCTL: systemctl };
      execFileSync('/bin/bash', [prepare], { env });
      const unit = fs.readFileSync(path.join(config, 'systemd/user/agent-cockpit-cortex-fixture.service'), 'utf8');
      expect(unit).toContain(`ExecStart="${root}/bin/start-agent-cockpit.sh"`);
      expect(unit).toContain(`ExecStop="${root}/bin/stop-agent-cockpit.sh"`);
      expect(unit).toContain('WantedBy=default.target');
      expect(fs.existsSync(path.join(config, 'systemd/user/agent-cockpit.service'))).toBe(false);
      expect(fs.readFileSync(systemctl, 'utf8')).toBe('--user\ndaemon-reload\n--user\nenable\nagent-cockpit-cortex-fixture.service\n');
      execFileSync(path.join(root, 'bin/start-agent-cockpit.sh'), [], { env });
      execFileSync(path.join(root, 'bin/stop-agent-cockpit.sh'), [], { env });
      expect(fs.readFileSync(capture, 'utf8').split('\n')).toEqual([
        app, 'pm2', 'startOrRestart', 'ecosystem.config.js', '--update-env', app, 'pm2', 'save',
        app, 'pm2', 'delete', 'agent-cockpit', app, 'pm2', 'save', '',
      ]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
