import type { ReactNode } from 'react';
import { AdminSideNav } from '@/components/admin/side-nav';

/**
 * Admin Insight Mode shell — side-nav on the left (or right under RTL), main
 * content area on the right. Auth gating is added in C10.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full gap-6">
      <AdminSideNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
