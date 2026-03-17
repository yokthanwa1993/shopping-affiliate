process.env.SHORTLINK_HTTP_PORT ||= '3001';
process.env.SHORTLINK_ACCOUNT_EMAIL ||= 'affiliate@neezs.com';
process.env.SHORTLINK_ACCOUNT_KEY ||= 'neezs';
process.env.SHORTLINK_WORKER_URL ||= 'https://shortlink.yokthanwa1993-bc9.workers.dev/?account=neezs';
process.env.SHORTLINK_DISPLAY_NAME ||= 'NEEZS';
process.env.SHORTLINK_APP_NAME ||= 'NEEZS';
process.env.SHORTLINK_LOCALHOST_LABEL ||= 'Open localhost:3001';

module.exports = require('./main.js');
