import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Search, Plus, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatPhone, initials } from '@/lib/utils';
import { LeadDetailsSheet } from '@/components/leads/LeadDetailsSheet';
import { CreateLeadDialog } from '@/components/leads/CreateLeadDialog';

export function LeadsPage() {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['leads', { search }],
    queryFn: async () => {
      const { data } = await api.get('/leads', { params: { search } });
      return data;
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إدارة الليدز</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {data?.total ?? 0} ليد {search && `(فلترة: "${search}")`}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          إضافة ليد
        </Button>
      </div>

      <Card className="p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute end-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="بحث بالاسم، الهاتف، أو البريد..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pe-9"
            />
          </div>
          <Button variant="outline">
            <Filter className="size-4" />
            فلترة
          </Button>
        </div>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow className="cursor-default">
              <TableHead>الاسم</TableHead>
              <TableHead>الهاتف</TableHead>
              <TableHead>المدينة</TableHead>
              <TableHead>الحالة</TableHead>
              <TableHead>المسؤول</TableHead>
              <TableHead>المصدر</TableHead>
              <TableHead>تاريخ الإضافة</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow className="cursor-default">
                <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                  جاري التحميل...
                </TableCell>
              </TableRow>
            ) : data?.items?.length ? (
              data.items.map((lead: LeadRow) => (
                <TableRow key={lead.id} onClick={() => setSelectedId(lead.id)}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="size-8">
                        <AvatarFallback>{initials(lead.contact.fullName)}</AvatarFallback>
                      </Avatar>
                      <div className="font-medium">{lead.contact.fullName}</div>
                    </div>
                  </TableCell>
                  <TableCell dir="ltr" className="text-start">
                    {formatPhone(lead.contact.phone)}
                  </TableCell>
                  <TableCell>{lead.contact.city ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={subStatusVariant(lead.subStatus)}>
                      {subStatusLabel(lead.subStatus)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {lead.assignedUserId ? (
                      <Avatar className="size-7">
                        <AvatarFallback className="text-xs">{lead.assignedUserId.slice(0, 2)}</AvatarFallback>
                      </Avatar>
                    ) : (
                      <span className="text-muted-foreground text-xs">غير مخصص</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs">{lead.source ?? 'manual'}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {format(new Date(lead.createdAt), 'yyyy-MM-dd')}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow className="cursor-default">
                <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                  لا توجد ليدز
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <LeadDetailsSheet leadId={selectedId} onClose={() => setSelectedId(null)} />
      <CreateLeadDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          refetch();
        }}
      />
    </div>
  );
}

interface LeadRow {
  id: string;
  contact: { fullName: string; phone: string; city: string | null };
  subStatus: string;
  assignedUserId: string | null;
  source: string | null;
  createdAt: string;
}

function subStatusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (s === 'completed') return 'default';
  if (s === 'dropped') return 'destructive';
  if (s === 'cold' || s === 'paused') return 'secondary';
  return 'outline';
}

function subStatusLabel(s: string): string {
  const map: Record<string, string> = {
    active: 'نشط',
    waiting_approval: 'بانتظار موافقة',
    waiting_customer: 'بانتظار العميل',
    cold: 'بارد',
    paused: 'موقوف',
    completed: 'مكتمل',
    dropped: 'ساقط',
  };
  return map[s] ?? s;
}
