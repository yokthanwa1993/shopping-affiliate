'use strict';

function detectPlatform(url) {
  const value = String(url || '').toLowerCase();
  if (!value) return '';
  if (value.includes('shopee')) return 'shopee';
  if (value.includes('lazada') || value.includes('s.lazada')) return 'lazada';
  return '';
}

module.exports = { detectPlatform };
