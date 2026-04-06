import './index.css'

import type { ReactNode } from 'react'
import { Links, Meta, Outlet, Scripts, ScrollRestoration, type LinksFunction, type MetaFunction } from 'react-router'

export const meta: MetaFunction = () => {
  return [
    { title: 'เฉียบ AI' },
    {
      name: 'viewport',
      content: 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
    },
  ]
}

export const links: LinksFunction = () => ([
  {
    rel: 'icon',
    href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎬</text></svg>",
  },
  { rel: 'preconnect', href: 'https://static.line-scdn.net', crossOrigin: 'anonymous' },
  { rel: 'preconnect', href: 'https://api.oomnn.com', crossOrigin: 'anonymous' },
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Kanit:wght@300;400;500;600;700&family=Prompt:wght@700&family=Sarabun:wght@700&family=Bai+Jamjuree:wght@700&family=Mitr:wght@700&family=Krub:wght@700&family=Chakra+Petch:wght@700&family=IBM+Plex+Sans+Thai:wght@700&display=swap',
  },
])

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
        <meta httpEquiv="Pragma" content="no-cache" />
        <meta httpEquiv="Expires" content="0" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <script charSet="utf-8" src="https://static.line-scdn.net/liff/edge/2/sdk.js" />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export function HydrateFallback() {
  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'system-ui, sans-serif',
        color: '#0f172a',
        background: '#f8fafc',
      }}
    >
      กำลังโหลด...
    </div>
  )
}

export default function Root() {
  return <Outlet />
}
