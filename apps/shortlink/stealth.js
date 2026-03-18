// stealth.js - Anti-fingerprint injection script
// Run via executeJavaScript before page loads

const STEALTH_SCRIPT = `
// --- navigator.webdriver ---
Object.defineProperty(navigator, 'webdriver', { get: () => false });

// --- navigator.userAgentData (Chrome branding) ---
if (navigator.userAgentData) {
    const brands = [
        { brand: 'Chromium', version: '134' },
        { brand: 'Not:A-Brand', version: '24' },
        { brand: 'Google Chrome', version: '134' },
    ];
    Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
            brands: brands,
            mobile: false,
            platform: 'Windows',
            getHighEntropyValues: function(hints) {
                return Promise.resolve({
                    brands: brands,
                    mobile: false,
                    platform: 'Windows',
                    platformVersion: '10.0.0',
                    architecture: 'x86',
                    bitness: '64',
                    model: '',
                    uaFullVersion: '134.0.0.0',
                    fullVersionList: brands,
                });
            },
            toJSON: function() {
                return { brands: brands, mobile: false, platform: 'Windows' };
            },
        }),
    });
}

// --- navigator.languages ---
Object.defineProperty(navigator, 'languages', {
    get: () => ['th-TH', 'th', 'en-US', 'en'],
});
Object.defineProperty(navigator, 'language', { get: () => 'th-TH' });

// --- navigator.plugins (mimic real Chrome) ---
const fakePlugins = {
    0: { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    1: { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    2: { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    3: { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    4: { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    length: 5,
    item: function(i) { return this[i] || null; },
    namedItem: function(name) {
        for (let i = 0; i < this.length; i++) {
            if (this[i].name === name) return this[i];
        }
        return null;
    },
    refresh: function() {},
    [Symbol.iterator]: function*() {
        for (let i = 0; i < this.length; i++) yield this[i];
    },
};
Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });

// --- navigator.mimeTypes ---
const fakeMimeTypes = {
    0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: fakePlugins[0] },
    1: { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: fakePlugins[0] },
    length: 2,
    item: function(i) { return this[i] || null; },
    namedItem: function(name) {
        for (let i = 0; i < this.length; i++) {
            if (this[i].type === name) return this[i];
        }
        return null;
    },
    [Symbol.iterator]: function*() {
        for (let i = 0; i < this.length; i++) yield this[i];
    },
};
Object.defineProperty(navigator, 'mimeTypes', { get: () => fakeMimeTypes });

// --- navigator.hardwareConcurrency ---
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });

// --- navigator.deviceMemory ---
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

// --- navigator.platform ---
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

// --- navigator.maxTouchPoints ---
Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

// --- navigator.connection ---
Object.defineProperty(navigator, 'connection', {
    get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
    }),
});

// --- screen properties ---
Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

// --- window.chrome ---
window.chrome = {
    app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    },
    runtime: {
        OnInstalledReason: {
            CHROME_UPDATE: 'chrome_update',
            INSTALL: 'install',
            SHARED_MODULE_UPDATE: 'shared_module_update',
            UPDATE: 'update',
        },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
        connect: function() {},
        sendMessage: function() {},
        id: undefined,
    },
    csi: function() { return {}; },
    loadTimes: function() {
        return {
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000,
            commitLoadTime: Date.now() / 1000,
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: false,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false,
            connectionInfo: 'h2',
        };
    },
};

// --- WebGL vendor/renderer spoofing ---
const origGetParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(param) {
    // UNMASKED_VENDOR_WEBGL
    if (param === 37445) return 'Google Inc. (Intel)';
    // UNMASKED_RENDERER_WEBGL
    if (param === 37446) return 'ANGLE (Intel, Intel(R) HD Graphics 4600 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    return origGetParameter.call(this, param);
};

if (typeof WebGL2RenderingContext !== 'undefined') {
    const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Google Inc. (Intel)';
        if (param === 37446) return 'ANGLE (Intel, Intel(R) HD Graphics 4600 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return origGetParameter2.call(this, param);
    };
}

// --- Permissions API ---
const origQuery = Permissions.prototype.query;
Permissions.prototype.query = function(params) {
    if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
    }
    return origQuery.call(this, params);
};

// --- Notification ---
Object.defineProperty(Notification, 'permission', { get: () => 'default' });

// --- iframe contentWindow ---
// Prevent detection via iframe.contentWindow checks
`;

module.exports = STEALTH_SCRIPT;
