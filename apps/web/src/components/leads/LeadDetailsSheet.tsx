import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Phone, MessageSquare, Mail, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api';
import { formatPhone, initials } from '@/lib/utils';

interface Props {
  leadId: string | null;
  onClose: () => void;
}

export function LeadDetailsSheet({ leadId, onClose }: Props) {
  const qc = useQueryClient();
  const open = !!leadId;

  const lead = useQuery({
    queryKey: ['lead', leadId],
    queryFn: async () => (await api.get(`/leads/${leadId}`)).data,
    enabled: !!leadId,
  });

  const timeline = useQuery({
    queryKey: ['lead', leadId, 'timeline'],
    queryFn: async () => (await api.get(`/leads/${leadId}/timeline`)).data,
    enabled: !!leadId,
  });

  const [note, setNote] = useState('');
  const noteMut = useMutation({
    mutationFn: async () => api.post(`/leads/${leadId}/notes`, { body: note }),
    onSuccess: () => {
      setNote('');
      toast.success('تمت إضافة الملاحظة');
      qc.invalidateQueries({ queryKey: ['lead', leadId, 'timeline'] });
    },
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent side="left" className="overflow-y-auto p-0">
        {lead.data && (
          <>
            <SheetHeader className="border-b">
              <div className="flex items-center gap-4">
                <Avatar className="size-14">
                  <AvatarFallback className="text-lg">
                    {initials(lead.data.contact.fullName)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <SheetTitle className="text-xl">{lead.data.contact.fullName}</SheetTitle>
                  <SheetDescription dir="ltr" className="text-start">
                    {formatPhone(lead.data.contact.phone)}
                  </SheetDescription>
                  <div className="flex items-center gap-2 mt-2">
                    <Badge variant="outline">{lead.data.subStatus}</Badge>
                    {lead.data.contact.city && (
                      <Badge variant="secondary">{lead.data.contact.city}</Badge>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 mt-4">
                <Button size="sm" variant="outline" className="flex-1">
                  <Phone className="size-4" />
                  اتصال
                </Button>
                <Button size="sm" variant="outline" className="flex-1">
                  <MessageSquare className="size-4" />
                  واتساب
                </Button>
                <Button size="sm" variant="outline" className="flex-1">
                  <Mail className="size-4" />
                  بريد
                </Button>
              </div>
            </SheetHeader>

            <div className="p-6">
              <Tabs defaultValue="timeline">
                <TabsList className="w-full grid grid-cols-4">
                  <TabsTrigger value="timeline">الأحداث</TabsTrigger>
                  <TabsTrigger value="info">البيانات</TabsTrigger>
                  <TabsTrigger value="docs">المستندات</TabsTrigger>
                  <TabsTrigger value="other">شركات أخرى</TabsTrigger>
                </TabsList>

                <TabsContent value="timeline" className="space-y-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="أضف ملاحظة..."
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && note.trim()) noteMut.mutate();
                      }}
                    />
                    <Button onClick={() => noteMut.mutate()} disabled={!note.trim() || noteMut.isPending}>
                      <Send className="size-4" />
                    </Button>
                  </div>
                  <Separator />
                  <div className="space-y-3">
                    {timeline.data?.items?.length ? (
                      timeline.data.items.map((a: TimelineItem) => (
                        <div key={a.id} className="flex gap-3 text-sm">
                          <div className="size-8 shrink-0 rounded-full bg-muted flex items-center justify-center">
                            <span className="text-xs">{typeIcon(a.type)}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="font-medium">{typeLabel(a.type)}</span>
                              <span className="text-xs text-muted-foreground">
                                {format(new Date(a.createdAt), 'yyyy-MM-dd HH:mm')}
                              </span>
                            </div>
                            {a.summary && (
                              <p className="text-muted-foreground mt-0.5 break-words">{a.summary}</p>
                            )}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center text-sm text-muted-foreground py-8">
                        لا توجد أحداث بعد
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="info">
                  <dl className="space-y-3 text-sm">
                    <Field label="الاسم" value={lead.data.contact.fullName} />
                    <Field label="الهاتف" value={formatPhone(lead.data.contact.phone)} ltr />
                    <Field label="الواتساب" value={lead.data.contact.whatsapp ?? '—'} ltr />
                    <Field label="البريد" value={lead.data.contact.email ?? '—'} ltr />
                    <Field label="المدينة" value={lead.data.contact.city ?? '—'} />
                    <Field label="نوع المركبة" value={lead.data.contact.vehicleType ?? '—'} />
                    <Field label="الدولة" value={lead.data.contact.countryCode} />
                    <Field label="المصدر" value={lead.data.source ?? 'manual'} />
                    <Field label="تاريخ الإضافة" value={format(new Date(lead.data.createdAt), 'yyyy-MM-dd HH:mm')} />
                  </dl>
                </TabsContent>

                <TabsContent value="docs">
                  <div className="text-center text-sm text-muted-foreground py-8">
                    رفع المستندات قريبًا
                  </div>
                </TabsContent>

                <TabsContent value="other">
                  <div className="text-center text-sm text-muted-foreground py-8">
                    سيظهر هنا تسجيلاته في باقي الشركات
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

interface TimelineItem {
  id: string;
  type: string;
  summary: string | null;
  createdAt: string;
}

function Field({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="grid grid-cols-3 items-baseline gap-2 py-1.5 border-b last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2 font-medium" dir={ltr ? 'ltr' : undefined}>
        {value}
      </dd>
    </div>
  );
}

function typeIcon(type: string): string {
  const map: Record<string, string> = {
    call: '📞',
    note: '📝',
    sms: '✉️',
    whatsapp: '💬',
    email: '📧',
    stage_change: '🔄',
    status_change: '🏷',
    assignment_change: '👤',
    document_upload: '📎',
    created: '✨',
    system_event: '⚙️',
  };
  return map[type] ?? '•';
}

function typeLabel(type: string): string {
  const map: Record<string, string> = {
    call: 'مكالمة',
    note: 'ملاحظة',
    sms: 'SMS',
    whatsapp: 'واتساب',
    email: 'بريد',
    stage_change: 'تغيير المرحلة',
    status_change: 'تغيير الحالة',
    assignment_change: 'تغيير المسؤول',
    document_upload: 'رفع مستند',
    created: 'تم الإنشاء',
    system_event: 'حدث نظام',
  };
  return map[type] ?? type;
}
