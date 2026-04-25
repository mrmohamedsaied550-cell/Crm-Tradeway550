import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Megaphone,
  Settings,
  LogOut,
  Search,
  Bell,
  ChevronsUpDown,
  Briefcase,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuthStore } from '@/stores/auth';
import { initials } from '@/lib/utils';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'لوحة التحكم', icon: LayoutDashboard, end: true },
  { to: '/leads', label: 'الليدز', icon: Users },
  { to: '/campaigns', label: 'الحملات', icon: Megaphone },
  { to: '/team', label: 'الفريق', icon: Briefcase },
  { to: '/settings', label: 'الإعدادات', icon: Settings },
];

export function DashboardLayout() {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();

  return (
    <div className="flex h-screen bg-background" dir="rtl">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-lg bg-primary flex items-center justify-center font-bold text-primary-foreground">
              T
            </div>
            <div>
              <div className="font-bold text-base leading-none">Trade Way</div>
              <div className="text-xs text-sidebar-foreground/60 mt-1">CRM</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <Separator className="bg-sidebar-border" />

        <div className="p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-sidebar-accent/50 transition-colors">
                <Avatar className="size-8">
                  <AvatarFallback className="bg-primary/20 text-primary">
                    {user ? initials(user.name) : '؟'}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 text-start min-w-0">
                  <div className="text-sm font-medium truncate">{user?.name ?? 'Guest'}</div>
                  <div className="text-xs text-sidebar-foreground/60 truncate">{user?.email}</div>
                </div>
                <ChevronsUpDown className="size-3.5 text-sidebar-foreground/60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>{roleLabel(user?.role)}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  clear();
                  navigate('/login');
                }}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="size-4" />
                تسجيل الخروج
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b bg-background flex items-center px-6 gap-4 shrink-0">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute end-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input placeholder="بحث سريع..." className="ps-3 pe-9" />
          </div>
          <Button variant="ghost" size="icon">
            <Bell className="size-4" />
          </Button>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function roleLabel(role?: string | null) {
  switch (role) {
    case 'super_admin':
      return 'مدير عام';
    case 'manager':
      return 'مدير';
    case 'team_leader':
      return 'قائد فريق';
    case 'sales_agent':
      return 'موظف مبيعات';
    default:
      return '';
  }
}
