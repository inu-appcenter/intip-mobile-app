const RAW = process.env.EXPO_PUBLIC_API_BASE_URL;

if (!RAW && __DEV__) {
  console.warn('[env] EXPO_PUBLIC_API_BASE_URL is not set; falling back to dev API host.');
}

/** Backend API origin (no trailing slash). Dev builds/local runs use the dev
 * host via `.env`; release builds pick up `.env.production` at bundle time. */
export const API_BASE_URL = (RAW ?? 'https://portal-dev.inuappcenter.kr').replace(/\/$/, '');
