import type {
  InstallChannel,
  InstallDoctorCheck,
  InstallDoctorCheckStatus,
  InstallDoctorStatus,
  InstallSource,
  InstallStateSource,
  InstallStatus,
} from '../types';

export type {
  InstallChannel,
  InstallDoctorCheck,
  InstallDoctorCheckStatus,
  InstallDoctorStatus,
  InstallSource,
  InstallStateSource,
  InstallStatus,
};

export interface InstallStatusResponse extends InstallStatus {}
export interface InstallDoctorStatusResponse extends InstallDoctorStatus {}
export interface WelcomeCompleteResponse {
  ok: true;
  install: InstallStatus;
}
