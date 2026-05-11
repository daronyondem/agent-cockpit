import path from 'path';
import {
  WebBuildService,
  type WebBuildServiceOptions,
  type WebBuildStatus,
} from './webBuildService';

export type MobileBuildStatus = WebBuildStatus;

export interface MobileBuildServiceOptions extends Omit<WebBuildServiceOptions, 'webRoot' | 'buildLabel' | 'buildScript' | 'stagingPrefix'> {
  mobileRoot?: string;
  buildDir?: string;
}

export class MobileBuildService {
  private readonly delegate: WebBuildService;

  constructor(appRoot: string, opts: MobileBuildServiceOptions = {}) {
    this.delegate = new WebBuildService(appRoot, {
      ...opts,
      webRoot: opts.mobileRoot || path.join(appRoot, 'mobile', 'AgentCockpitPWA'),
      buildDir: opts.buildDir || path.join(appRoot, 'public', 'mobile-built'),
      buildLabel: 'Mobile PWA',
      buildScript: 'mobile:build',
      buildCommand: opts.buildCommand || ((stagingDir: string) => ({
        cmd: 'npm',
        args: ['--prefix', 'mobile/AgentCockpitPWA', 'run', 'build', '--', '--outDir', stagingDir],
        cwd: appRoot,
        timeout: 120_000,
      })),
      stagingPrefix: 'mobile-built',
    });
  }

  getBuildDir(): string {
    return this.delegate.getBuildDir();
  }

  getMarkerPath(): string {
    return this.delegate.getMarkerPath();
  }

  ensureBuilt(opts: { force?: boolean } = {}): Promise<MobileBuildStatus> {
    return this.delegate.ensureBuilt(opts);
  }
}
