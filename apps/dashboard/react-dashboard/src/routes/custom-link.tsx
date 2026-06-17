import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import {
  customLinkRequestSchema,
  shortenCustomLink,
  type CustomLinkRequest,
} from '@/api/customLink'
import { useWorkspace } from '@/contexts/workspace'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export function CustomLinkPage() {
  const [copied, setCopied] = useState(false)
  const { workspace, affiliate } = useWorkspace()

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<CustomLinkRequest>({
    resolver: zodResolver(customLinkRequestSchema),
    defaultValues: {
      url: '',
      id: affiliate.id,
      account: '',
      sub1: '',
      sub2: '',
      sub3: '',
      sub4: '',
      sub5: '',
    },
  })

  const mutation = useMutation({
    mutationFn: (values: CustomLinkRequest) => shortenCustomLink(values),
  })

  // The selected topnav workspace is the single source of truth for the
  // affiliate id. Keep the form id locked to it so the user can never end up in
  // workspace NEEZS while the form still carries the CHEARB id (or vice versa).
  // Changing workspace also clears any stale shorten result / copied state.
  useEffect(() => {
    setValue('id', affiliate.id, { shouldValidate: true })
    setCopied(false)
    mutation.reset()
    // mutation.reset is stable across renders; re-run only when the id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [affiliate.id, setValue])

  const result = mutation.data
  const ready = result?.status === 'ok' && !!result.shortLink

  // Never forward the display-only account email/label upstream for the built-in
  // ids — the worker maps the numeric id to the right Shopee account on its own,
  // and forwarding an account triggers shopee_affiliate_account_conflict. Submit
  // the id only and let the worker resolve the account.
  const onSubmit = handleSubmit((values) => {
    setCopied(false)
    mutation.mutate({ ...values, id: affiliate.id, account: '' })
  })

  async function copyShortLink() {
    if (!result?.shortLink) return
    try {
      await navigator.clipboard.writeText(result.shortLink)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">คัสตอมลิงก์</h1>
        <p className="text-sm text-muted-foreground">ย่อลิงก์ Shopee พร้อมแนบ sub_id ของเพจ</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">สร้างลิงก์</CardTitle>
          <CardDescription>วางลิงก์สินค้า Shopee แล้วกดสร้างลิงก์ย่อ</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="cl-url">ลิงก์สินค้า Shopee</Label>
              <Input id="cl-url" placeholder="https://shopee.co.th/..." {...register('url')} />
              {errors.url ? <p className="text-xs text-destructive">{errors.url.message}</p> : null}
            </div>

            <div className="space-y-1">
              <Label>Affiliate preset</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{workspace}</Badge>
                <span className="text-sm text-muted-foreground">{affiliate.accountEmail}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                ผูกกับ workspace ที่เลือกด้านบนขวา — เปลี่ยน workspace เพื่อเปลี่ยนบัญชี affiliate
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="cl-id">Affiliate ID</Label>
                <Input id="cl-id" readOnly aria-readonly {...register('id')} />
                {errors.id ? <p className="text-xs text-destructive">{errors.id.message}</p> : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="cl-sub1">sub1 (campaign)</Label>
                <Input id="cl-sub1" placeholder="เช่น 1JUN26FBSPCAD" {...register('sub1')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cl-sub2">sub2 (post/reel id)</Label>
                <Input id="cl-sub2" {...register('sub2')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cl-sub3">sub3 (page id)</Label>
                <Input id="cl-sub3" {...register('sub3')} />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'กำลังย่อลิงก์…' : 'ย่อลิงก์'}
              </Button>
              {mutation.isError ? (
                <span className="text-sm text-destructive">
                  {mutation.error instanceof Error ? mutation.error.message : 'เกิดข้อผิดพลาด'}
                </span>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">ผลลัพธ์</CardTitle>
            <Badge variant={ready ? 'success' : 'destructive'}>{result.status ?? 'unknown'}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {ready ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={result.shortLink}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all font-medium text-primary hover:underline"
                  >
                    {result.shortLink}
                  </a>
                  <Button type="button" size="sm" variant="outline" onClick={copyShortLink}>
                    {copied ? 'คัดลอกแล้ว ✓' : 'คัดลอก'}
                  </Button>
                </div>
                {result.original ? (
                  <p className="break-all text-xs text-muted-foreground">ต้นทาง: {result.original}</p>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {result.error || result.status === 'manual_login_required'
                  ? result.error ?? 'ต้องล็อกอิน customlink ใหม่ (manual_login_required)'
                  : 'ไม่ได้รับ shortLink จาก worker'}
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
