module.exports = {
  apps: [
    {
      name: 'launcher',
      script: 'launcher-server.js',
      cwd: 'C:\\BrowserSaving',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'token-service',
      script: 'token-service.js',
      cwd: 'C:\\BrowserSaving',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'vite-dev',
      script: 'npx',
      args: 'vite --host 0.0.0.0 --port 5173',
      cwd: 'C:\\BrowserSaving\\apps\\browsersaving',
      interpreter: 'none',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
}
