#!/usr/bin/env bun
import { execute } from '@oclif/core';

await execute({ development: false, dir: import.meta.url });