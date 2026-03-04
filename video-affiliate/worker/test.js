const { execSync } = require('child_process');
try {
  const result = execSync('npx wrangler d1 execute video-affiliate-db --remote --command "SELECT * FROM users WHERE telegram_id = ?;" --json', { encoding: 'utf-8' });
  console.log(result);
} catch (e) { console.log(e.stdout) }
