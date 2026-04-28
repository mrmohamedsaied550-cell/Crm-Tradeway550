import { redirect } from 'next/navigation';

/**
 * Root path redirects to /login.
 *
 * The real authenticated landing (My Day for agents, Admin Console for
 * admins) is wired in C10 once auth is in place. C4 only ships the shells.
 */
export default function HomePage(): never {
  redirect('/login');
}
