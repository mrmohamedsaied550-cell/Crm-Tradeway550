export type Role = 'super_admin' | 'manager' | 'team_leader' | 'sales_agent';

export type SubStatus =
  | 'active'
  | 'waiting_approval'
  | 'waiting_customer'
  | 'cold'
  | 'paused'
  | 'completed'
  | 'dropped';

export type TeamType = 'sales' | 'activation' | 'driving' | 'none';

export type Platform = 'meta' | 'tiktok' | 'google' | 'referral' | 'manual' | 'sheet' | 'other';

export type RoutingMode =
  | 'round_robin'
  | 'percentage'
  | 'capacity'
  | 'performance'
  | 'manual'
  | 'hybrid';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  countryCode: string | null;
  teamId: string | null;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
