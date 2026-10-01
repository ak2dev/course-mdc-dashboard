'use strict';

// Vercel serverless entry point. vercel.json rewrites every /api/* request here.
const { handleApi } = require('../lib/app');

module.exports = handleApi;
