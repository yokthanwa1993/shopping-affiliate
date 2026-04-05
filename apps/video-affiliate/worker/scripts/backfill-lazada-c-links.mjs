#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WORKDIR = process.cwd()
const DB_NAME = 'video-affiliate-db'
const R2_BUCKET = 'video-affiliate-videos'
const NS_SETTING_AFFILIATE_SHORTLINK_ACCOUNT = 'affiliate_shortlink_account_v1'
const NS_SETTING_LAZADA_SHORTLINK_BASE_URL = 'lazada_shortlink_base_url_v1'
const NS_SETTING_LAZADA_EXPECTED_MEMBER_ID = 'lazada_expected_member_id_v1'
const ADMIN_NAMESPACE_ID = '1774858894802785816'
const ADMIN_SHORTLINK_ACCOUNT = 'CHEARB'

function run(args, options = {}) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: WORKDIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

function d1Json(sql) {
  const out = run(['d1', 'execute', DB_NAME, '--remote', '--json', '--command', sql])
  return JSON.parse(out)
}

function d1Exec(sql) {
  return run(['d1', 'execute', DB_NAME, '--remote', '--command', sql])
}

function escapeSql(value) {
  return String(value ?? '').replace(/'/g, "''")
}

function normalizeAccount(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '').slice(0, 64)
}

function deriveSub1(namespaceId) {
  const normalized = String(namespaceId || '').trim().toLowerCase()
  const fromEmail = normalized.includes('@') ? normalized.split('@')[0] : normalized
  const safe = fromEmail.replace(/[^a-z0-9]+/g, '').slice(0, 32)
  return safe || 'workspace'
}

function extractAccountFromBaseUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  try {
    const url = new URL(value)
    return normalizeAccount(url.searchParams.get('account') || '')
  } catch {
    return ''
  }
}

function canonicalizeResolvedLazadaLink(rawLink) {
  const value = String(rawLink || '').trim()
  if (!value) return ''
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()
    if (host.includes('lazada.') && pathname.endsWith('.html')) {
      return `${parsed.origin}${parsed.pathname}`
    }
    if (host.includes('lazada.')) {
      return `${parsed.origin}${parsed.pathname}`
    }
    return parsed.toString()
  } catch {
    return value
  }
}

function extractLazadaMemberIdFromLink(link) {
  const rawLink = String(link || '').trim()
  if (!rawLink) return ''
  const matchMemberId = (value) => {
    const decoded = (() => {
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    })()
    const exact = decoded.match(/mm_(\d+)_/i)
    if (exact) return String(exact[1] || '').trim()
    const direct = decoded.match(/[?&]member_id=(\d+)/i)
    if (direct) return String(direct[1] || '').trim()
    return ''
  }
  const direct = matchMemberId(rawLink)
  if (direct) return direct
  try {
    const parsed = new URL(rawLink)
    for (const key of ['exlaz', 'laz_trackid', 'utm_source', 'member_id', 'sub_aff_id', 'aff_trace_key']) {
      const hit = matchMemberId(String(parsed.searchParams.get(key) || ''))
      if (hit) return hit
    }
  } catch {}
  return ''
}

async function resolveRedirect(url) {
  const resp = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  })
  return String(resp.url || '').trim() || url
}

async function convertLazada(namespaceId, inputUrl, account, expectedMemberId) {
  const resolved = await resolveRedirect(inputUrl)
  const canonical = canonicalizeResolvedLazadaLink(resolved || inputUrl)
  const requestUrl = new URL('https://short.wwoom.com/')
  requestUrl.searchParams.set('account', account)
  requestUrl.searchParams.set('url', canonical)
  requestUrl.searchParams.set('sub1', deriveSub1(namespaceId))
  const resp = await fetch(requestUrl, { redirect: 'follow' })
  if (!resp.ok) {
    throw new Error(`shortlink_http_${resp.status}`)
  }
  const data = await resp.json()
  const shortLink = String(
    data.shortLink || data.shortlink || data.short_link || data.promotionLink || data.promotionUrl || data.url || ''
  ).trim()
  const memberId = String(data.member_id || data.memberId || data.id || '').trim() || extractLazadaMemberIdFromLink(shortLink)
  if (!shortLink) throw new Error('missing_shortlink')
  if (!memberId) throw new Error('missing_member_id')
  if (expectedMemberId && memberId !== expectedMemberId) {
    throw new Error(`member_mismatch:${memberId}:${expectedMemberId}`)
  }
  return { canonical, shortLink, memberId }
}

function getR2Json(key) {
  const tempPath = path.join(os.tmpdir(), `r2-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  try {
    run(['r2', 'object', 'get', `${R2_BUCKET}/${key}`, '--remote', '--file', tempPath])
    return JSON.parse(fs.readFileSync(tempPath, 'utf8'))
  } catch {
    return null
  } finally {
    try { fs.unlinkSync(tempPath) } catch {}
  }
}

function putR2Json(key, value) {
  const tempPath = path.join(os.tmpdir(), `r2-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2))
    run(['r2', 'object', 'put', `${R2_BUCKET}/${key}`, '--remote', '--file', tempPath, '--content-type', 'application/json', '--force'])
  } finally {
    try { fs.unlinkSync(tempPath) } catch {}
  }
}

async function main() {
  const candidatesRes = d1Json(`
    WITH candidate_rows AS (
      SELECT namespace_id, video_id, lazada_link, lazada_original_link
      FROM namespace_video_state
      WHERE lazada_link LIKE 'https://c.lazada.%' OR lazada_original_link LIKE 'https://c.lazada.%'
      UNION ALL
      SELECT namespace_id, video_id, lazada_link, lazada_original_link
      FROM gallery_index
      WHERE lazada_link LIKE 'https://c.lazada.%' OR lazada_original_link LIKE 'https://c.lazada.%'
    )
    SELECT namespace_id, video_id,
           MAX(CASE WHEN lazada_original_link LIKE 'https://c.lazada.%' THEN lazada_original_link ELSE '' END) AS c_original,
           MAX(CASE WHEN lazada_link LIKE 'https://c.lazada.%' THEN lazada_link ELSE '' END) AS c_current
    FROM candidate_rows
    GROUP BY namespace_id, video_id
    ORDER BY namespace_id, video_id;
  `)
  const candidates = candidatesRes[0]?.results || []
  if (!candidates.length) {
    console.log('No c.lazada rows found.')
    return
  }

  const namespaces = [...new Set(candidates.map((row) => String(row.namespace_id || '').trim()).filter(Boolean))]
  const nsSql = namespaces.map((ns) => `'${escapeSql(ns)}'`).join(', ')
  const settingsRes = d1Json(`
    SELECT namespace_id, key, value
    FROM namespace_settings
    WHERE namespace_id IN (${nsSql})
      AND key IN ('${NS_SETTING_AFFILIATE_SHORTLINK_ACCOUNT}', '${NS_SETTING_LAZADA_SHORTLINK_BASE_URL}', '${NS_SETTING_LAZADA_EXPECTED_MEMBER_ID}')
  `)
  const settingsRows = settingsRes[0]?.results || []
  const nsConfig = new Map()
  for (const ns of namespaces) nsConfig.set(ns, { account: '', baseUrl: '', expectedMemberId: '' })
  for (const row of settingsRows) {
    const ns = String(row.namespace_id || '').trim()
    const key = String(row.key || '').trim()
    const value = String(row.value || '').trim()
    const config = nsConfig.get(ns) || { account: '', baseUrl: '', expectedMemberId: '' }
    if (key === NS_SETTING_AFFILIATE_SHORTLINK_ACCOUNT) config.account = normalizeAccount(value)
    if (key === NS_SETTING_LAZADA_SHORTLINK_BASE_URL) config.baseUrl = value
    if (key === NS_SETTING_LAZADA_EXPECTED_MEMBER_ID) config.expectedMemberId = value
    nsConfig.set(ns, config)
  }

  const results = []

  for (const row of candidates) {
    const namespaceId = String(row.namespace_id || '').trim()
    const videoId = String(row.video_id || '').trim()
    const source = String(row.c_original || row.c_current || '').trim()
    if (!namespaceId || !videoId || !source) continue

    const config = nsConfig.get(namespaceId) || { account: '', baseUrl: '', expectedMemberId: '' }
    let account = normalizeAccount(config.account)
    if (!account) account = extractAccountFromBaseUrl(config.baseUrl)
    if (!account && namespaceId === ADMIN_NAMESPACE_ID) account = ADMIN_SHORTLINK_ACCOUNT
    const expectedMemberId = String(config.expectedMemberId || '').trim()
    if (!account) {
      results.push({ namespaceId, videoId, status: 'skipped', reason: 'missing_account' })
      continue
    }

    try {
      console.log(`[${namespaceId}/${videoId}] converting ${source}`)
      const converted = await convertLazada(namespaceId, source, account, expectedMemberId)
      const nowIso = new Date().toISOString()
      d1Exec(`
        UPDATE namespace_video_state
           SET lazada_link='${escapeSql(converted.shortLink)}',
               lazada_original_link='${escapeSql(converted.canonical)}',
               lazada_converted_at=CASE WHEN TRIM(COALESCE(lazada_converted_at,''))='' THEN '${escapeSql(nowIso)}' ELSE lazada_converted_at END,
               lazada_member_id='${escapeSql(converted.memberId)}'
         WHERE namespace_id='${escapeSql(namespaceId)}'
           AND video_id='${escapeSql(videoId)}'
           AND (lazada_link LIKE 'https://c.lazada.%' OR lazada_original_link LIKE 'https://c.lazada.%');
        UPDATE gallery_index
           SET lazada_link='${escapeSql(converted.shortLink)}',
               lazada_original_link='${escapeSql(converted.canonical)}',
               lazada_converted_at=CASE WHEN TRIM(COALESCE(lazada_converted_at,''))='' THEN '${escapeSql(nowIso)}' ELSE lazada_converted_at END,
               lazada_member_id='${escapeSql(converted.memberId)}'
         WHERE namespace_id='${escapeSql(namespaceId)}'
           AND video_id='${escapeSql(videoId)}'
           AND (lazada_link LIKE 'https://c.lazada.%' OR lazada_original_link LIKE 'https://c.lazada.%');
        UPDATE post_history
           SET lazada_link='${escapeSql(converted.shortLink)}',
               lazada_member_id='${escapeSql(converted.memberId)}'
         WHERE bot_id='${escapeSql(namespaceId)}'
           AND video_id='${escapeSql(videoId)}'
           AND lazada_link LIKE 'https://c.lazada.%';
      `)

      for (const key of [
        `${namespaceId}/videos/${videoId}.json`,
        `${namespaceId}/_inbox/${videoId}.json`,
        `${namespaceId}/_queue/${videoId}.json`,
        `${namespaceId}/_processing/${videoId}.json`,
        `${namespaceId}/_link_context/${videoId}.json`,
      ]) {
        const obj = getR2Json(key)
        if (!obj || typeof obj !== 'object') continue
        let changed = false
        for (const field of ['lazadaLink', 'lazada_link']) {
          if (String(obj[field] || '').startsWith('https://c.lazada.')) {
            obj[field] = converted.shortLink
            changed = true
          }
        }
        for (const field of ['lazadaOriginalLink', 'lazada_original_link']) {
          if (String(obj[field] || '').startsWith('https://c.lazada.')) {
            obj[field] = converted.canonical
            changed = true
          }
        }
        if ('lazadaMemberId' in obj || 'lazada_member_id' in obj) {
          obj.lazadaMemberId = converted.memberId
          delete obj.lazada_member_id
          changed = true
        }
        if ('lazadaConvertedAt' in obj || 'lazada_converted_at' in obj) {
          obj.lazadaConvertedAt = String(obj.lazadaConvertedAt || obj.lazada_converted_at || nowIso).trim() || nowIso
          delete obj.lazada_converted_at
          changed = true
        }
        if (changed) {
          console.log(`[${namespaceId}/${videoId}] update ${key}`)
          obj.updatedAt = nowIso
          putR2Json(key, obj)
        }
      }

      results.push({ namespaceId, videoId, status: 'updated', shortLink: converted.shortLink, memberId: converted.memberId })
      console.log(`[${namespaceId}/${videoId}] updated -> ${converted.shortLink}`)
    } catch (error) {
      results.push({ namespaceId, videoId, status: 'failed', reason: error instanceof Error ? error.message : String(error) })
      console.log(`[${namespaceId}/${videoId}] failed -> ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const updated = results.filter((item) => item.status === 'updated')
  const failed = results.filter((item) => item.status === 'failed')
  const skipped = results.filter((item) => item.status === 'skipped')

  console.log(JSON.stringify({
    totalCandidates: candidates.length,
    updated: updated.length,
    failed: failed.length,
    skipped: skipped.length,
    failedItems: failed,
    skippedItems: skipped,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
