/**
 * Smart date formatting utility
 * - If date is within last 24 hours: show time (e.g., "2:30 PM")
 * - If date is within last week: show day and time (e.g., "Mon 2:30 PM")
 * - Otherwise: show date (e.g., "Jan 15, 2024")
 */
export function formatSmartDate(date: string | number | Date): string {
  const dateObj = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - dateObj.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  // Within last 24 hours: show time only
  if (diffHours < 24) {
    return dateObj.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  // Within last week: show day and time
  if (diffDays < 7) {
    return dateObj.toLocaleDateString('en-US', {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  // Older: show date
  return dateObj.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
