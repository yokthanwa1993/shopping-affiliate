'use strict';

// Loads the static single-page console once at startup. The HTML is fully static
// (no server-side interpolation of account data), so the served page never
// contains any account value or secret — those are fetched client-side from the
// redacted JSON endpoints.

const fs = require('fs');
const path = require('path');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');

module.exports = { INDEX_HTML };
