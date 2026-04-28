import type { ReactNode } from 'react';

/**
 * Agent Execution Mode shell.
 *
 * C4 ships only the surface. The PWA-installable WhatsApp Inbox + bottom tab
 * navigation (Inbox / My Day / Performance / Profile) lands in Phase 1.5.
 */
export default function AgentLayout({ children }: { children: ReactNode }) {
  return <div className="w-full">{children}</div>;
}
