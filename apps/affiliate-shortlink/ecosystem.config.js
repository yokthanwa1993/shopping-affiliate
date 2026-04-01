module.exports = {
  apps: [
    {
      name: 'affiliate-shortlink',
      cwd: '/Users/yok-macmini/Developer/shopping-affiliate/apps/affiliate-shortlink',
      script: 'node_modules/electron/cli.js',
      args: '.',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'cloudflared-tunnel',
      script: '/opt/homebrew/bin/cloudflared',
      args: 'tunnel --config /Users/yok-macmini/Developer/shopping-affiliate/apps/affiliate-shortlink/cloudflared/config.yml run',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
