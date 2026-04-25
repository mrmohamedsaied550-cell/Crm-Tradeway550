import axios, { AxiosError } from 'axios';
import { useAuthStore } from '@/stores/auth';

export const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let refreshing: Promise<string | null> | null = null;

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config!;
    const status = error.response?.status;
    const url = original.url ?? '';

    if (status === 401 && !url.includes('/auth/refresh') && !url.includes('/auth/login')) {
      refreshing ??= refreshTokens();
      const newToken = await refreshing;
      refreshing = null;
      if (newToken && original.headers) {
        original.headers.Authorization = `Bearer ${newToken}`;
        return api.request(original);
      }
      useAuthStore.getState().clear();
      window.location.href = '/login';
    }

    return Promise.reject(error);
  },
);

async function refreshTokens(): Promise<string | null> {
  const { refreshToken } = useAuthStore.getState();
  if (!refreshToken) return null;
  try {
    const { data } = await axios.post('/api/v1/auth/refresh', { refreshToken });
    useAuthStore.getState().setTokens(data.accessToken, data.refreshToken);
    return data.accessToken;
  } catch {
    return null;
  }
}
