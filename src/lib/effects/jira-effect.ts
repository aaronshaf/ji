import { Effect, pipe } from 'effect';
import type { Issue, JiraClient } from '../jira-client';
import { JiraError, NotFoundError } from './errors';

export class JiraEffectClient {
  constructor(private client: JiraClient) {}

  getIssueEffect(key: string): Effect.Effect<Issue, JiraError | NotFoundError> {
    return pipe(
      Effect.tryPromise({
        try: () => this.client.getIssue(key),
        catch: (error) => new JiraError(`Failed to get issue ${key}`, error),
      }),
      Effect.filterOrFail(
        (issue): issue is Issue => issue !== null,
        () => new NotFoundError(`Issue ${key} not found`),
      ),
    );
  }

  searchIssuesEffect(jql: string): Effect.Effect<Issue[], JiraError> {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.client.searchIssues(jql);
        return result.issues;
      },
      catch: (error) => new JiraError(`Search failed: ${jql}`, error),
    });
  }
}
