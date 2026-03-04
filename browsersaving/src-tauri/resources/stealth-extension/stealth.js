// Hide webdriver
Object.defineProperty(navigator, 'webdriver', {
  get: () => undefined,
  configurable: true
});

// Hide automation
delete navigator.__proto__.webdriver;

// Fix permissions
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
  parameters.name === 'notifications' ?
    Promise.resolve({ state: Notification.permission }) :
    originalQuery(parameters)
);

// Hide plugins length
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const plugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ];
    plugins.item = (i) => plugins[i];
    plugins.namedItem = (name) => plugins.find(p => p.name === name);
    plugins.refresh = () => {};
    return plugins;
  }
});

// Hide languages
Object.defineProperty(navigator, 'languages', {
  get: () => ['en-US', 'en', 'th']
});

// Fix chrome runtime
window.chrome = {
  runtime: {},
  loadTimes: function() {},
  csi: function() {},
  app: {}
};

// Hide automation in user agent
if (navigator.userAgent.includes('HeadlessChrome')) {
  Object.defineProperty(navigator, 'userAgent', {
    get: () => navigator.userAgent.replace('HeadlessChrome', 'Chrome')
  });
}

// Prevent detection via iframe
try {
  if (window.self !== window.top) {
    Object.defineProperty(window, 'self', { get: () => window.top });
  }
} catch (e) {}

// Fix WebGL vendor/renderer
const getParameterProxyHandler = {
  apply: function(target, thisArg, args) {
    const param = args[0];
    const gl = thisArg;
    // UNMASKED_VENDOR_WEBGL
    if (param === 37445) {
      return 'Intel Inc.';
    }
    // UNMASKED_RENDERER_WEBGL
    if (param === 37446) {
      return 'Intel Iris OpenGL Engine';
    }
    return Reflect.apply(target, thisArg, args);
  }
};

try {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (gl) {
    const getParameter = gl.getParameter.bind(gl);
    gl.getParameter = new Proxy(getParameter, getParameterProxyHandler);
  }
  const gl2 = canvas.getContext('webgl2');
  if (gl2) {
    const getParameter2 = gl2.getParameter.bind(gl2);
    gl2.getParameter = new Proxy(getParameter2, getParameterProxyHandler);
  }
} catch (e) {}

// Randomize canvas fingerprint slightly
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(type) {
  if (type === 'image/png' && this.width > 16 && this.height > 16) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const imageData = ctx.getImageData(0, 0, this.width, this.height);
      for (let i = 0; i < imageData.data.length; i += 4) {
        // Add tiny random noise to one pixel
        if (Math.random() < 0.0001) {
          imageData.data[i] = imageData.data[i] ^ 1;
        }
      }
      ctx.putImageData(imageData, 0, 0);
    }
  }
  return originalToDataURL.apply(this, arguments);
};

// Console log for debugging
console.log('[Stealth] Anti-detection active');
