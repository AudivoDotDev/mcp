#!/usr/bin/env node
import { main } from './cli.js';

const code = main();
if (code !== 0) process.exit(code);
