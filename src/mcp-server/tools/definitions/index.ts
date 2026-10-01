/**
 * @fileoverview Every tool definition the server registers, collected for `createApp()`.
 * @module mcp-server/tools/definitions
 */

import { findNeighbourhoodTool } from './find-neighbourhood.tool.js';
import { getCrimeOutcomesTool } from './get-crime-outcomes.tool.js';
import { listReferenceTool } from './list-reference.tool.js';
import { searchCrimesTool } from './search-crimes.tool.js';
import { searchOutcomesTool } from './search-outcomes.tool.js';
import { searchStopsTool } from './search-stops.tool.js';

/** Passed to `createApp({ tools })` in the design's MCP Surface order; a definition missing here is never registered. */
export const allToolDefinitions = [
  listReferenceTool,
  searchCrimesTool,
  searchOutcomesTool,
  getCrimeOutcomesTool,
  searchStopsTool,
  findNeighbourhoodTool,
];
