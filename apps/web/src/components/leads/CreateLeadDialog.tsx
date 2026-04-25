import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateLeadDialog({ open, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    fullName: '',
    phone: '',
    city: '',
    countryCode: 'EG',
    companyCountryId: '',
  });

  const ccs = useQuery({
    queryKey: ['company-countries'],
    queryFn: async () => (await api.get('/companies/company-countries')).data,
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      return api.post('/leads', {
        contact: {
          fullName: form.fullName,
          phone: form.phone,
          city: form.city || undefined,
          countryCode: form.countryCode,
        },
        enrollment: {
          companyCountryId: form.companyCountryId,
        },
        allowExistingContact: true,
      });
    },
    onSuccess: () => {
      toast.success('تم إنشاء الليد');
      setForm({ fullName: '', phone: '', city: '', countryCode: 'EG', companyCountryId: '' });
      onCreated();
    },
    onError: (err: { response?: { data?: { message?: string } } }) => {
      toast.error(err.response?.data?.message ?? 'فشل إنشاء الليد');
    },
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent side="left" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>إضافة ليد جديد</SheetTitle>
        </SheetHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="px-6 pb-6 space-y-4"
        >
          <div className="space-y-2">
            <Label>الاسم الكامل</Label>
            <Input
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>الهاتف</Label>
            <Input
              dir="ltr"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              required
              placeholder="01000000000"
            />
          </div>
          <div className="space-y-2">
            <Label>المدينة</Label>
            <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>الدولة</Label>
            <Select value={form.countryCode} onValueChange={(v) => setForm({ ...form, countryCode: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="EG">🇪🇬 مصر</SelectItem>
                <SelectItem value="SA">🇸🇦 السعودية</SelectItem>
                <SelectItem value="MA">🇲🇦 المغرب</SelectItem>
                <SelectItem value="DZ">🇩🇿 الجزائر</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>الشركة - الدولة</Label>
            <Select
              value={form.companyCountryId}
              onValueChange={(v) => setForm({ ...form, companyCountryId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="اختر..." />
              </SelectTrigger>
              <SelectContent>
                {ccs.data?.items?.map((cc: CcRow) => (
                  <SelectItem key={cc.id} value={cc.id}>
                    {cc.company.nameAr} — {cc.country.nameAr}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={mutation.isPending || !form.companyCountryId} className="w-full">
            إضافة
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

interface CcRow {
  id: string;
  company: { nameAr: string };
  country: { nameAr: string };
}
