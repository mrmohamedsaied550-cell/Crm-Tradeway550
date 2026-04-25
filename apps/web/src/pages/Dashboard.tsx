import { useQuery } from '@tanstack/react-query';
import { Users, CheckCircle2, TrendingUp, Activity, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { api } from '@/lib/api';

export function DashboardPage() {
  const kpis = useQuery({
    queryKey: ['dashboard', 'kpis'],
    queryFn: async () => (await api.get('/dashboard/kpis')).data,
  });
  const sources = useQuery({
    queryKey: ['dashboard', 'by-source'],
    queryFn: async () => (await api.get('/dashboard/by-source')).data,
  });

  const chartColors = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">لوحة التحكم</h1>
        <p className="text-muted-foreground text-sm mt-1">نظرة عامة على أداء العمل</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard
          icon={Users}
          label="إجمالي الليدز"
          value={kpis.data?.total ?? 0}
          color="bg-blue-500/10 text-blue-600"
        />
        <KpiCard
          icon={Activity}
          label="نشط"
          value={kpis.data?.active ?? 0}
          color="bg-emerald-500/10 text-emerald-600"
        />
        <KpiCard
          icon={CheckCircle2}
          label="مكتمل"
          value={kpis.data?.completed ?? 0}
          color="bg-primary/10 text-primary"
        />
        <KpiCard
          icon={Clock}
          label="DFTs"
          value={kpis.data?.firstTrips ?? 0}
          color="bg-amber-500/10 text-amber-600"
        />
        <KpiCard
          icon={TrendingUp}
          label="نسبة التحويل"
          value={`${kpis.data?.conversionRate ?? 0}%`}
          color="bg-violet-500/10 text-violet-600"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>مصادر الليدز</CardTitle>
          </CardHeader>
          <CardContent>
            {sources.data?.items?.length ? (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={sources.data.items}
                    dataKey="count"
                    nameKey="source"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    label
                  >
                    {sources.data.items.map((_: unknown, i: number) => (
                      <Cell key={i} fill={chartColors[i % chartColors.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>الأداء الأسبوعي</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={mockWeekly()}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="day" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="leads" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="dft" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: typeof Users;
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-2">{value}</p>
          </div>
          <div className={`size-10 rounded-lg ${color} flex items-center justify-center`}>
            <Icon className="size-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyChart() {
  return (
    <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">
      لا توجد بيانات بعد
    </div>
  );
}

function mockWeekly() {
  return [
    { day: 'سبت', leads: 12, dft: 3 },
    { day: 'أحد', leads: 18, dft: 5 },
    { day: 'اثنين', leads: 22, dft: 7 },
    { day: 'ثلاثاء', leads: 15, dft: 4 },
    { day: 'أربعاء', leads: 28, dft: 8 },
    { day: 'خميس', leads: 24, dft: 6 },
    { day: 'جمعة', leads: 9, dft: 2 },
  ];
}
