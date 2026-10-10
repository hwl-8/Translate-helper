'use strict';

const path = require('node:path');

// Data and private configuration stay beside the original HTML entry point.
// Never derive the project root from the terminal's current working directory.
const PROJECT_ROOT = path.resolve(__dirname, '..');

module.exports = {PROJECT_ROOT};
