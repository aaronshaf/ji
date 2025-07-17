import { describe, expect, it } from 'bun:test';
import { formatSmartDate } from './date-formatter';

describe('formatSmartDate', () => {
  it('should format time for dates within last 24 hours', () => {
    // Use a date that's definitely within 24 hours
    const now = new Date();
    const recentDate = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
    const result = formatSmartDate(recentDate);
    expect(result).toMatch(/^\d{1,2}:\d{2}\s(AM|PM)$/);
  });

  it('should format day and time for dates within last week', () => {
    // Use a date that's definitely within the last week but not last 24 hours
    const now = new Date();
    const lastWeekDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
    const result = formatSmartDate(lastWeekDate);
    expect(result).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat).+\d{1,2}:\d{2}\s(AM|PM)$/);
  });

  it('should format full date for older dates', () => {
    // Use a date that's definitely older than a week
    const now = new Date();
    const oldDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const result = formatSmartDate(oldDate);
    expect(result).toMatch(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2},\s\d{4}$/);
  });

  it('should handle string dates', () => {
    const now = new Date();
    const dateString = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
    const result = formatSmartDate(dateString);
    expect(result).toMatch(/^\d{1,2}:\d{2}\s(AM|PM)$/);
  });

  it('should handle timestamp numbers', () => {
    const now = new Date();
    const timestamp = now.getTime() - 1 * 60 * 60 * 1000; // 1 hour ago
    const result = formatSmartDate(timestamp);
    expect(result).toMatch(/^\d{1,2}:\d{2}\s(AM|PM)$/);
  });
});
