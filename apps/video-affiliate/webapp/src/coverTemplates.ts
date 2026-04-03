export type CoverTemplateId =
  | 'template-1'
  | 'template-2'
  | 'template-3'
  | 'template-4'
  | 'template-5'
  | 'template-6'
  | 'template-7'
  | 'template-8'
  | 'template-9'

export interface CoverTemplateDefinition {
  id: CoverTemplateId
  name: string
  description: string
  accent: string
  accentAlt: string
  textColor: string
  cardTone: string
}

export const DEFAULT_COVER_TEMPLATE_ID: CoverTemplateId = 'template-1'

export const COVER_TEMPLATE_OPTIONS: CoverTemplateDefinition[] = [
  {
    id: 'template-1',
    name: 'Template 1',
    description: 'แถบแดงเต็มกว้าง',
    accent: '#E53935',
    accentAlt: '#D32F2F',
    textColor: '#FFFFFF',
    cardTone: 'full',
  },
  {
    id: 'template-2',
    name: 'Template 2',
    description: 'การ์ดกระจกนุ่ม',
    accent: '#14B8A6',
    accentAlt: '#0F766E',
    textColor: '#0F172A',
    cardTone: 'light',
  },
  {
    id: 'template-3',
    name: 'Template 3',
    description: 'ตัวอักษรเด่นกลางภาพ',
    accent: '#F97316',
    accentAlt: '#EA580C',
    textColor: '#FFFFFF',
    cardTone: 'clear',
  },
  {
    id: 'template-4',
    name: 'Template 4',
    description: 'ป้ายโค้งด้านบน',
    accent: '#8B5CF6',
    accentAlt: '#6D28D9',
    textColor: '#FFFFFF',
    cardTone: 'solid',
  },
  {
    id: 'template-5',
    name: 'Template 5',
    description: 'แถบข้าง + กล่องข้อความ',
    accent: '#EF4444',
    accentAlt: '#B91C1C',
    textColor: '#FFFFFF',
    cardTone: 'dark',
  },
  {
    id: 'template-6',
    name: 'Template 6',
    description: 'การ์ดแมกกาซีน',
    accent: '#F59E0B',
    accentAlt: '#D97706',
    textColor: '#111827',
    cardTone: 'light',
  },
  {
    id: 'template-7',
    name: 'Template 7',
    description: 'ริบบิ้นเรียบคม',
    accent: '#10B981',
    accentAlt: '#047857',
    textColor: '#FFFFFF',
    cardTone: 'solid',
  },
  {
    id: 'template-8',
    name: 'Template 8',
    description: 'กรอบขาวตัดเข้ม',
    accent: '#0F172A',
    accentAlt: '#334155',
    textColor: '#FFFFFF',
    cardTone: 'outline',
  },
  {
    id: 'template-9',
    name: 'Template 9',
    description: 'แถบเต็มกว้าง',
    accent: '#EC4899',
    accentAlt: '#BE185D',
    textColor: '#FFFFFF',
    cardTone: 'full',
  },
]

const COVER_TEMPLATE_ID_SET = new Set<CoverTemplateId>(COVER_TEMPLATE_OPTIONS.map((template) => template.id))

export function normalizeCoverTemplateId(value: string | null | undefined): CoverTemplateId {
  const normalized = String(value || '').trim().toLowerCase() as CoverTemplateId
  return COVER_TEMPLATE_ID_SET.has(normalized) ? normalized : DEFAULT_COVER_TEMPLATE_ID
}

export function getCoverTemplateById(value: string | null | undefined): CoverTemplateDefinition {
  const id = normalizeCoverTemplateId(value)
  return COVER_TEMPLATE_OPTIONS.find((template) => template.id === id) || COVER_TEMPLATE_OPTIONS[0]
}
