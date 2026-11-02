import { QueryClient, useQuery } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { User } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  form?: FormData;
}

export async function api<T>(path: string, { method, body, form }: Options = {}): Promise<T> {
  const init: RequestInit = {
    method: method ?? (body !== undefined || form ? 'POST' : 'GET'),
    credentials: 'same-origin',
  };
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(`/api${path}`, init);
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    // Session expired or signed out elsewhere: fall back to the login screen.
    if (res.status === 401 && !path.startsWith('/auth/')) queryClient.setQueryData(['me'], null);
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api<{ user: User }>('/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
  });
}

export interface AppConfig {
  maxUploadMb: number;
  /** False on Vercel, where alerts run from a fixed daily cron instead of the chosen time. */
  scheduledAlerts: boolean;
  /** True when the server has an Anthropic API key for the assistant. */
  assistant: boolean;
  /** The CRM's time zone (Settings), e.g. America/New_York. */
  timezone: string;
  /** Changes when the agency logo does; null when none is uploaded. */
  logoVersion: string | null;
}

/** The agency logo's address, or null when none is uploaded. */
export const logoUrl = (version: string | null | undefined) => (version ? `/api/logo?v=${encodeURIComponent(version)}` : null);

const useConfigQuery = () => useQuery({ queryKey: ['config'], queryFn: () => api<AppConfig>('/config'), staleTime: Infinity });

/** Server settings the UI depends on, such as the upload size limit. */
export function useAppConfig(): AppConfig {
  return useConfigQuery().data ?? { maxUploadMb: 4, scheduledAlerts: true, assistant: false, timezone: 'America/New_York', logoVersion: null };
}

/** True once the server settings (including the CRM time zone that times are shown in) have loaded or failed to. */
export function useAppConfigReady(): boolean {
  const { data, isError } = useConfigQuery();
  return Boolean(data) || isError;
}

export function notifyError(err: unknown) {
  notifications.show({ color: 'red', title: 'Something went wrong', message: (err as Error).message });
}

export function notifySuccess(message: string) {
  notifications.show({ message });
}
