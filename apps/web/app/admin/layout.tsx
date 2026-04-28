import type { ReactNode } from 'react';
import { AdminSideNav } from '@/components/admin/side-nav';
import { AuthBar } from '@/components/admin/auth-bar';

/**
 * Admin shell — side-nav on the left (right under RTL), main content on the
 * right. The auth bar at the top of the content area surfaces who's signed
 * in (and tries to refresh `/auth/me` on mount), or prompts a sign-in when
 * no token is in localStorage.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full gap-6">
      <AdminSideNav />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <AuthBar />
        {children}
      </div>
    </div>
  );
}
