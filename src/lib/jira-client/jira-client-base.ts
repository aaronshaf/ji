import type { Config } from '../config.js';

export class JiraClientBase {
  protected config: Config;

  constructor(config: Config) {
    // Prevent real API calls in test environment unless explicitly allowed
    if (process.env.NODE_ENV === 'test' && !process.env.ALLOW_REAL_API_CALLS) {
      throw new Error(
        'Real API calls detected in test environment! ' +
          'Tests must use mocks to avoid making real Jira API calls. ' +
          'If you really need to make real calls, set ALLOW_REAL_API_CALLS=true',
      );
    }
    this.config = config;
  }

  protected getHeaders() {
    const token = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
    return {
      Authorization: `Basic ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }
}
