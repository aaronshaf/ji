/**
 * Parse time expressions for the --since parameter
 * Supports:
 * - Relative times: 24h, 7d, 1w, 1m, 3h, etc.
 * - Keywords: yesterday, today, week, month
 * - Absolute dates: 2024-01-15, 2024-01-15T10:00:00
 * - Unix timestamps: 1704412800
 *
 * @returns Unix timestamp in milliseconds
 */
export function parseSinceExpression(since: string): number {
  const now = Date.now();
  const trimmed = since.trim().toLowerCase();

  // Handle keywords
  const keywords: Record<string, number> = {
    now: now,
    today: new Date().setHours(0, 0, 0, 0),
    yesterday: new Date().setHours(0, 0, 0, 0) - 86400000,
    week: now - 7 * 86400000,
    month: now - 30 * 86400000,
  };

  if (keywords[trimmed]) {
    return keywords[trimmed];
  }

  // Handle relative time expressions (e.g., 24h, 7d, 1w, 2m)
  const relativeMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*([hdwm])$/);
  if (relativeMatch) {
    const [, valueStr, unit] = relativeMatch;
    const value = parseFloat(valueStr);

    const multipliers: Record<string, number> = {
      h: 3600000, // hours to ms
      d: 86400000, // days to ms
      w: 604800000, // weeks to ms
      m: 2592000000, // months to ms (30 days)
    };

    const multiplier = multipliers[unit];
    if (multiplier) {
      return now - Math.floor(value * multiplier);
    }
  }

  // Handle Unix timestamp (if it's a number)
  if (/^\d+$/.test(trimmed)) {
    const timestamp = parseInt(trimmed, 10);
    // Check if it's likely a Unix timestamp (after year 2000 and before year 2100)
    if (timestamp > 946684800 && timestamp < 4102444800) {
      // If it's in seconds (10 digits), convert to milliseconds
      if (timestamp < 10000000000) {
        return timestamp * 1000;
      }
      return timestamp;
    }
  }

  // Handle ISO date formats and other date strings
  const parsedDate = Date.parse(since);
  if (!Number.isNaN(parsedDate)) {
    return parsedDate;
  }

  // If we can't parse it, throw an error
  throw new Error(
    `Invalid time expression: "${since}". Use formats like: 24h, 7d, 1w, yesterday, 2024-01-15, or Unix timestamp`,
  );
}

/**
 * Parse status filter expressions
 * Handles special keywords and comma-separated lists
 */
export function parseStatusFilter(status: string | undefined): string[] | undefined {
  if (!status) return undefined;

  const trimmed = status.trim().toLowerCase();

  // Special keywords
  if (trimmed === 'all') return []; // Empty array means no filter
  if (trimmed === 'open') return ['open']; // Special handling needed in SQL
  if (trimmed === 'closed') return ['closed', 'done', 'resolved'];

  // Parse comma-separated list
  return status
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Format timestamp for display
 */
export function formatSinceTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  } else if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  } else if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
  } else {
    return new Date(timestamp).toLocaleDateString();
  }
}
