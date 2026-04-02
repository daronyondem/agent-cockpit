import dotenv from 'dotenv';
import type { AppConfig } from '../types';

dotenv.config();

const config: AppConfig = {
  PORT: Number(process.env.PORT) || 3334,
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL || '',
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  GITHUB_CALLBACK_URL: process.env.GITHUB_CALLBACK_URL,
  ALLOWED_EMAIL: process.env.ALLOWED_EMAIL || '',
  DEFAULT_WORKSPACE: process.env.DEFAULT_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`,
  BASE_PATH: process.env.BASE_PATH || '',
};

export default config;
