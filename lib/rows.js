// Row selection and credential masking shared by the CLI, the host tools and
// the browser panel. ONE implementation only: a drifting copy of the mask
// would leak credentials into the browser.
import { SECRET_KEY_RE } from './rules.js';

/**
 * True for rows that configure an MCP client.
 * Historical predicate from the CLI: a row with no name, or a name mentioning
 * dsh-mcp-client, or any row carrying a transport.
 */
export function isMcpClientRow(entry) {
  return !entry.name || entry.name.includes('dsh-mcp-client') || Boolean(entry.config?.transport);
}

/** Deep-clone one entry with every credential-looking value replaced by B*****. */
export function maskEntry(entry) {
  const clone = JSON.parse(JSON.stringify(entry));
  for (const dict of ['env', 'headers']) {
    const d = clone.config?.[dict];
    if (d && typeof d === 'object') {
      for (const [k, v] of Object.entries(d)) {
        if (SECRET_KEY_RE.test(k)) d[k] = 'B*****';
        else if (typeof v === 'object' && v?.__jsExpr) d[k] = 'B*****';
      }
    }
  }
  return clone;
}
