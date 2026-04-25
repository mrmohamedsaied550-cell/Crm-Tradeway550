import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { api } from '@/lib/api';
import { initials } from '@/lib/utils';

export function TeamPage() {
  const { data } = useQuery({
    queryKey: ['team', 'users'],
    queryFn: async () => (await api.get('/users')).data,
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">الفريق</h1>
        <p className="text-muted-foreground text-sm mt-1">{data?.items?.length ?? 0} عضو</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>الأعضاء</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {data?.items?.map((u: TeamMember) => (
              <div key={u.id} className="flex items-center gap-3 p-3 border rounded-lg">
                <Avatar className="size-10">
                  <AvatarFallback>{initials(u.name)}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{u.name}</div>
                  <div className="text-xs text-muted-foreground truncate" dir="ltr">
                    {u.email}
                  </div>
                </div>
                <Badge variant="secondary">{roleLabel(u.role)}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: string;
}

function roleLabel(role: string): string {
  const map: Record<string, string> = {
    super_admin: 'مدير عام',
    manager: 'مدير',
    team_leader: 'قائد فريق',
    sales_agent: 'مبيعات',
  };
  return map[role] ?? role;
}
