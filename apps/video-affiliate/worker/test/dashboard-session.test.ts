import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DASHBOARD_SESSION_COOKIE_NAME,
    DASHBOARD_SESSION_HEADER_NAME,
    DASHBOARD_SETUP_MODE_HEADER_NAME,
    extractDashboardSessionId,
    resolveDashboardSessionId,
    dashboardSessionAuthorizes,
    dashboardSetupModeAuthorizes,
    type DashboardSessionRow,
} from '../src/dashboard-session'

const NS = '1774858894802785816'
const OTHER_NS = '9999999999999999999'

function row(overrides: Partial<DashboardSessionRow> = {}): DashboardSessionRow {
    return {
        session_id: 'sid-abc',
        user_id: 'user-1',
        namespace_id: NS,
        expires_at: '2999-01-01T00:00:00.000Z',
        ...overrides,
    }
}

test('cookie name is the dashboard passkey session cookie', () => {
    assert.equal(DASHBOARD_SESSION_COOKIE_NAME, 'pubilo_dashboard_session')
})

test('extractDashboardSessionId: reads the session cookie among others', () => {
    const header = `theme=dark; ${DASHBOARD_SESSION_COOKIE_NAME}=sid-xyz; other=1`
    assert.equal(extractDashboardSessionId(header), 'sid-xyz')
})

test('extractDashboardSessionId: tolerates surrounding whitespace and quotes', () => {
    assert.equal(extractDashboardSessionId(`  ${DASHBOARD_SESSION_COOKIE_NAME} = sid-1 `), 'sid-1')
    assert.equal(extractDashboardSessionId(`${DASHBOARD_SESSION_COOKIE_NAME}="sid-2"`), 'sid-2')
})

test('extractDashboardSessionId: returns empty when absent or malformed', () => {
    assert.equal(extractDashboardSessionId(''), '')
    assert.equal(extractDashboardSessionId(null), '')
    assert.equal(extractDashboardSessionId(undefined), '')
    assert.equal(extractDashboardSessionId('chearb_sess=sess_abc; foo=bar'), '')
    // A bare cookie name with no value must not be treated as a session id.
    assert.equal(extractDashboardSessionId(`${DASHBOARD_SESSION_COOKIE_NAME}`), '')
})

test('extractDashboardSessionId: does not confuse a different cookie that ends with the name', () => {
    assert.equal(extractDashboardSessionId('x_pubilo_dashboard_session=nope'), '')
})

test('header name is the proxy-injected dashboard session header', () => {
    assert.equal(DASHBOARD_SESSION_HEADER_NAME, 'x-dashboard-session-id')
})

test('resolveDashboardSessionId: prefers the proxy header over the cookie', () => {
    const cookie = `${DASHBOARD_SESSION_COOKIE_NAME}=from-cookie`
    assert.equal(resolveDashboardSessionId('from-header', cookie), 'from-header')
})

test('resolveDashboardSessionId: ignores a blank header and falls back to the cookie', () => {
    const cookie = `${DASHBOARD_SESSION_COOKIE_NAME}=from-cookie`
    assert.equal(resolveDashboardSessionId('', cookie), 'from-cookie')
    assert.equal(resolveDashboardSessionId('   ', cookie), 'from-cookie')
    assert.equal(resolveDashboardSessionId(null, cookie), 'from-cookie')
    assert.equal(resolveDashboardSessionId(undefined, cookie), 'from-cookie')
})

test('resolveDashboardSessionId: trims a header value', () => {
    assert.equal(resolveDashboardSessionId('  sid-h  ', null), 'sid-h')
})

test('resolveDashboardSessionId: returns empty when neither carries a value', () => {
    assert.equal(resolveDashboardSessionId('', ''), '')
    assert.equal(resolveDashboardSessionId(null, null), '')
    assert.equal(resolveDashboardSessionId(undefined, 'foo=bar'), '')
})

test('authorizes when namespace matches the resolved botId', () => {
    assert.equal(dashboardSessionAuthorizes({ session: row(), requestBotId: NS }), true)
})

test('rejects when namespace does not match the resolved botId', () => {
    assert.equal(dashboardSessionAuthorizes({ session: row(), requestBotId: OTHER_NS }), false)
})

test('rejects when no botId is resolved (blank botId never authorizes)', () => {
    assert.equal(dashboardSessionAuthorizes({ session: row(), requestBotId: '' }), false)
    assert.equal(dashboardSessionAuthorizes({ session: row(), requestBotId: '   ' }), false)
    assert.equal(dashboardSessionAuthorizes({ session: row(), requestBotId: null }), false)
    assert.equal(dashboardSessionAuthorizes({ session: row(), requestBotId: undefined }), false)
})

test('rejects a null/empty session outright', () => {
    assert.equal(dashboardSessionAuthorizes({ session: null, requestBotId: NS }), false)
    assert.equal(dashboardSessionAuthorizes({ session: undefined, requestBotId: NS }), false)
    assert.equal(dashboardSessionAuthorizes({ session: row({ namespace_id: '' }), requestBotId: NS }), false)
})

test('namespace comparison ignores surrounding whitespace on the botId', () => {
    assert.equal(dashboardSessionAuthorizes({ session: row(), requestBotId: `  ${NS}  ` }), true)
})

// ── Setup-mode (passkey bootstrap) fallback ──────────────────────────────────

test('setup-mode header name is the proxy-injected setup header', () => {
    assert.equal(DASHBOARD_SETUP_MODE_HEADER_NAME, 'x-dashboard-setup-mode')
})

test('setup mode authorizes only when header=1, botId non-empty, and credential count is 0', () => {
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: '1', requestBotId: NS, credentialCount: 0 }),
        true,
    )
})

test('setup mode rejects when credential count is not 0', () => {
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: '1', requestBotId: NS, credentialCount: 1 }),
        false,
    )
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: '1', requestBotId: NS, credentialCount: 5 }),
        false,
    )
})

test('setup mode rejects an unconfirmed (null/undefined) credential count — header never trusted alone', () => {
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: '1', requestBotId: NS, credentialCount: null }),
        false,
    )
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: '1', requestBotId: NS, credentialCount: undefined }),
        false,
    )
})

test('setup mode rejects a blank/absent botId even with 0 credentials', () => {
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: '1', requestBotId: '', credentialCount: 0 }),
        false,
    )
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: '1', requestBotId: '   ', credentialCount: 0 }),
        false,
    )
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: '1', requestBotId: null, credentialCount: 0 }),
        false,
    )
})

test('setup mode rejects when the header is missing or not exactly "1"', () => {
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: '', requestBotId: NS, credentialCount: 0 }),
        false,
    )
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: '0', requestBotId: NS, credentialCount: 0 }),
        false,
    )
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: 'true', requestBotId: NS, credentialCount: 0 }),
        false,
    )
    assert.equal(
        dashboardSetupModeAuthorizes({ setupModeHeader: null, requestBotId: NS, credentialCount: 0 }),
        false,
    )
})
