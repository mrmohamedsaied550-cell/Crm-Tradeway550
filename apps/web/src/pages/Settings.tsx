import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export function SettingsPage() {
  return (
    <div className="grid grid-cols-12 gap-6">
      <aside className="col-span-3">
        <nav className="space-y-1">
          <SettingsNav to="/settings/companies" label="الشركات والأسواق" />
          <SettingsNav to="/settings/stages" label="المراحل" />
          <SettingsNav to="/settings/statuses" label="الحالات" />
          <SettingsNav to="/settings/reasons" label="أسباب الرفض" />
          <SettingsNav to="/settings/users" label="المستخدمين" />
        </nav>
      </aside>
      <div className="col-span-9">
        <Routes>
          <Route index element={<Navigate to="companies" replace />} />
          <Route path="companies" element={<CompaniesSettings />} />
          <Route path="stages" element={<StagesSettings />} />
          <Route path="statuses" element={<StatusesSettings />} />
          <Route path="reasons" element={<ReasonsSettings />} />
          <Route path="users" element={<UsersSettings />} />
        </Routes>
      </div>
    </div>
  );
}

function SettingsNav({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'block px-3 py-2 rounded-md text-sm font-medium transition-colors',
          isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted',
        )
      }
    >
      {label}
    </NavLink>
  );
}

function CompaniesSettings() {
  const { data } = useQuery({
    queryKey: ['settings', 'companies'],
    queryFn: async () => (await api.get('/companies')).data,
  });
  const ccs = useQuery({
    queryKey: ['settings', 'company-countries'],
    queryFn: async () => (await api.get('/companies/company-countries')).data,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>الشركات</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {data?.items?.map((c: { id: string; nameAr: string; nameEn: string; code: string }) => (
              <div key={c.id} className="border rounded-lg p-3">
                <div className="font-semibold">{c.nameAr}</div>
                <div className="text-xs text-muted-foreground mt-1">{c.nameEn}</div>
                <Badge variant="outline" className="mt-2">
                  {c.code}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>الأسواق (شركة × دولة)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {ccs.data?.items?.map((cc: { id: string; company: { nameAr: string }; country: { nameAr: string; flagEmoji?: string } }) => (
              <div key={cc.id} className="flex items-center gap-3 px-3 py-2 border rounded-md">
                <span className="text-lg">{cc.country.flagEmoji}</span>
                <span className="font-medium">{cc.company.nameAr}</span>
                <span className="text-muted-foreground">—</span>
                <span>{cc.country.nameAr}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StagesSettings() {
  const { data } = useQuery({
    queryKey: ['settings', 'stages'],
    queryFn: async () => (await api.get('/pipeline/stages')).data,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>المراحل (Stages)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data?.items?.map((s: StageRow) => (
          <div key={s.id} className="flex items-center gap-3 px-3 py-2 border rounded-md">
            <span className="size-3 rounded-full" style={{ background: s.color }} />
            <span className="font-medium flex-1">{s.nameAr}</span>
            <Badge variant="secondary">{s.teamType}</Badge>
            {s.slaMinutes && <Badge variant="outline">SLA: {s.slaMinutes} د</Badge>}
            {s.approvalRequired !== 'none' && <Badge variant="outline">يحتاج موافقة</Badge>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

interface StageRow {
  id: string;
  nameAr: string;
  color: string;
  teamType: string;
  slaMinutes: number | null;
  approvalRequired: string;
}

function StatusesSettings() {
  const { data } = useQuery({
    queryKey: ['settings', 'statuses'],
    queryFn: async () => (await api.get('/pipeline/statuses')).data,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>حالات الليدز</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data?.items?.map((s: { id: string; nameAr: string; color: string; isTerminal: boolean }) => (
          <div key={s.id} className="flex items-center gap-3 px-3 py-2 border rounded-md">
            <span className="size-3 rounded-full" style={{ background: s.color }} />
            <span className="font-medium flex-1">{s.nameAr}</span>
            {s.isTerminal && <Badge variant="destructive">نهائية</Badge>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ReasonsSettings() {
  const { data } = useQuery({
    queryKey: ['settings', 'reasons'],
    queryFn: async () => (await api.get('/pipeline/reject-reasons')).data,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>أسباب الرفض</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data?.items?.map((r: { id: string; nameAr: string; category: string | null }) => (
          <div key={r.id} className="flex items-center gap-3 px-3 py-2 border rounded-md">
            <span className="font-medium flex-1">{r.nameAr}</span>
            {r.category && <Badge variant="outline">{r.category}</Badge>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function UsersSettings() {
  const { data } = useQuery({
    queryKey: ['settings', 'users'],
    queryFn: async () => (await api.get('/users')).data,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>المستخدمين</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data?.items?.map((u: { id: string; name: string; email: string; role: string; countryCode: string | null }) => (
          <div key={u.id} className="flex items-center gap-3 px-3 py-2 border rounded-md">
            <div className="flex-1">
              <div className="font-medium">{u.name}</div>
              <div className="text-xs text-muted-foreground" dir="ltr">{u.email}</div>
            </div>
            <Badge variant="secondary">{u.role}</Badge>
            {u.countryCode && <Badge variant="outline">{u.countryCode}</Badge>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
