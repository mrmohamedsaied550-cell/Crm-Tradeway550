import { redirect } from 'next/navigation';

/**
 * Sprint 19 (D19) — legacy /admin/pipeline retirement.
 *
 * The Kanban surface that used to live here was removed from the
 * sidebar a while back (the Pipeline Builder at /admin/pipeline-builder
 * is the active replacement). The page was still reachable by direct
 * URL — operators with bookmarks would land on a screen that the
 * primary nav no longer recognises.
 *
 * Sprint 19 turns this route into a permanent redirect so stale
 * bookmarks resolve cleanly. No destructive delete: the file stays
 * as a thin forwarder so the route doesn't 404, and the rest of
 * the codebase (which doesn't reference `/admin/pipeline` anywhere)
 * is unaffected.
 *
 * If a future sprint deletes the route file entirely, Next.js
 * will surface a 404 — operators by then will have migrated their
 * bookmarks via this redirect.
 */
export default function LegacyPipelinePage(): never {
  redirect('/admin/pipeline-builder');
}
