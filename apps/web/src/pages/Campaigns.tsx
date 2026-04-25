import { useQuery } from '@tanstack/react-query';
import { Megaphone } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

export function CampaignsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: async () => (await api.get('/campaigns')).data,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">الحملات</h1>
          <p className="text-muted-foreground text-sm mt-1">{data?.items?.length ?? 0} حملة نشطة</p>
        </div>
        <Button>إضافة حملة</Button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">جاري التحميل...</div>
      ) : data?.items?.length ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.items.map((c: CampaignRow) => (
            <Card key={c.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <CardTitle className="text-base">{c.name}</CardTitle>
                  <Badge variant="outline">{c.platform}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">الكود</span>
                  <code className="font-mono text-xs">{c.code}</code>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">التوزيع</span>
                  <Badge variant="secondary">{c.routingMode}</Badge>
                </div>
                {c.budget && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">الميزانية</span>
                    <span className="font-medium">
                      {c.budget} {c.currency}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Megaphone className="size-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">لا توجد حملات بعد</p>
            <Button className="mt-4">إضافة أول حملة</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface CampaignRow {
  id: string;
  name: string;
  code: string;
  platform: string;
  routingMode: string;
  budget: string | null;
  currency: string | null;
}
