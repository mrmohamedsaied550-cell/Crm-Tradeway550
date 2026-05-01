import type { ReactNode } from 'react';
import { AdminSideNav } from '@/components/admin/side-nav';
import { AuthBar } from '@/components/admin/auth-bar';
import { AdminAuthGuard } from '@/components/admin/auth-guard';

/**
 * Admin shell — side-nav on the left (right under RTL), main content on the
 * right. The auth bar at the top of the content area surfaces who's signed
 * in (and tries to refresh `/auth/me` on mount), or prompts a sign-in when
 * no token is in localStorage.
 *
 * `AdminAuthGuard` redirects unauthenticated visitors to `/login` before
 * any child page fires its mount-time API calls — without it, deep-linking
 * into /admin/* without a session triggers 401s with "Missing or
 * malformed Authorization header" instead of cleanly bouncing to login.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full gap-6">
      <AdminSideNav />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <AuthBar />
        <AdminAuthGuard>{children}</AdminAuthGuard>
      </div>
    </div>
  );
}
