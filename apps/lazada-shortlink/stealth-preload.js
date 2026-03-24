try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
} catch {}

try {
    const brands = [
        { brand: 'Chromium', version: '134' },
        { brand: 'Not:A-Brand', version: '24' },
        { brand: 'Google Chrome', version: '134' },
    ];

    Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
            brands,
            mobile: false,
            platform: 'Windows',
            getHighEntropyValues: async () => ({
                brands,
                mobile: false,
                platform: 'Windows',
                platformVersion: '10.0.0',
                architecture: 'x86',
                bitness: '64',
                model: '',
                uaFullVersion: '134.0.0.0',
                fullVersionList: brands,
            }),
            toJSON: () => ({ brands, mobile: false, platform: 'Windows' }),
        }),
    });
} catch {}

try {
    Object.defineProperty(navigator, 'languages', {
        get: () => ['th-TH', 'th', 'en-US', 'en'],
    });
    Object.defineProperty(navigator, 'language', { get: () => 'th-TH' });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
} catch {}

try {
    const fakePlugins = {
        0: { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        1: { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        2: { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        3: { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        4: { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        length: 5,
        item(i) { return this[i] || null; },
        namedItem(name) {
            for (let i = 0; i < this.length; i += 1) {
                if (this[i].name === name) return this[i];
            }
            return null;
        },
        refresh() {},
    };

    Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });
    Object.defineProperty(navigator, 'mimeTypes', {
        get: () => ({
            0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: fakePlugins[0] },
            1: { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: fakePlugins[0] },
            length: 2,
            item(i) { return this[i] || null; },
            namedItem(name) {
                for (let i = 0; i < this.length; i += 1) {
                    if (this[i].type === name) return this[i];
                }
                return null;
            },
        }),
    });
} catch {}

try {
    window.chrome = window.chrome || {};
    window.chrome.app = window.chrome.app || {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    };
    window.chrome.runtime = window.chrome.runtime || {
        connect() {},
        sendMessage() {},
        id: undefined,
    };
    window.chrome.csi = window.chrome.csi || (() => ({}));
    window.chrome.loadTimes = window.chrome.loadTimes || (() => ({
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
    }));
} catch {}

try {
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
        window.navigator.permissions.query = function query(parameters) {
            if (parameters && parameters.name === 'notifications') {
                return Promise.resolve({ state: Notification.permission, onchange: null });
            }
            return originalQuery.call(this, parameters);
        };
    }
} catch {}
