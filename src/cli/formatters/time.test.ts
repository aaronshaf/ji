import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { formatTimeAgo } from './time';

describe('formatTimeAgo', () => {
  let mockNow: number;
  let originalNow: typeof Date.now;

  beforeEach(() => {
    // Save original Date.now
    originalNow = Date.now;
    // Mock Date.now() to return a fixed timestamp
    mockNow = new Date('2024-01-15T14:30:00Z').getTime();
    Date.now = () => mockNow;
  });

  afterEach(() => {
    // Restore Date.now to original behavior
    Date.now = originalNow;
  });

  it('should return "unknown" for undefined timestamp', () => {
    expect(formatTimeAgo(undefined)).toBe('unknown');
  });

  it('should return "just now" for very recent timestamps', () => {
    const timestamp = mockNow - 30 * 1000; // 30 seconds ago
    expect(formatTimeAgo(timestamp)).toBe('just now');
  });

  it('should format minutes ago', () => {
    const timestamp = mockNow - 5 * 60 * 1000; // 5 minutes ago
    expect(formatTimeAgo(timestamp)).toBe('5 minutes ago');
  });

  it('should format singular minute', () => {
    const timestamp = mockNow - 1 * 60 * 1000; // 1 minute ago
    expect(formatTimeAgo(timestamp)).toBe('1 minute ago');
  });

  it('should format hours ago', () => {
    const timestamp = mockNow - 3 * 60 * 60 * 1000; // 3 hours ago
    expect(formatTimeAgo(timestamp)).toBe('3 hours ago');
  });

  it('should format singular hour', () => {
    const timestamp = mockNow - 1 * 60 * 60 * 1000; // 1 hour ago
    expect(formatTimeAgo(timestamp)).toBe('1 hour ago');
  });

  it('should format days ago', () => {
    const timestamp = mockNow - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    expect(formatTimeAgo(timestamp)).toBe('5 days ago');
  });

  it('should format singular day', () => {
    const timestamp = mockNow - 1 * 24 * 60 * 60 * 1000; // 1 day ago
    expect(formatTimeAgo(timestamp)).toBe('1 day ago');
  });

  it('should format months ago', () => {
    const timestamp = mockNow - 45 * 24 * 60 * 60 * 1000; // 45 days ago
    expect(formatTimeAgo(timestamp)).toBe('1 month ago');
  });

  it('should format multiple months', () => {
    const timestamp = mockNow - 90 * 24 * 60 * 60 * 1000; // 90 days ago
    expect(formatTimeAgo(timestamp)).toBe('3 months ago');
  });

  it('should format years ago', () => {
    const timestamp = mockNow - 400 * 24 * 60 * 60 * 1000; // 400 days ago
    expect(formatTimeAgo(timestamp)).toBe('1 year ago');
  });

  it('should format multiple years', () => {
    const timestamp = mockNow - 800 * 24 * 60 * 60 * 1000; // 800 days ago
    expect(formatTimeAgo(timestamp)).toBe('2 years ago');
  });
});
