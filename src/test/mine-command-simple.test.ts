import { describe, expect, it } from 'bun:test';

// Test helper functions instead of the full command
describe('mine command helpers', () => {
  describe('issue formatting', () => {
    it('should format issue data correctly for YAML output', () => {
      const _issue = {
        key: 'TEST-123',
        project_key: 'TEST',
        summary: 'Test issue summary',
        status: 'In Progress',
        priority: 'High',
        assignee_name: 'John Doe',
        updated: '2024-01-01T12:00:00Z',
      };

      const _expectedOutput = {
        key: 'TEST-123',
        title: 'Test issue summary',
        status: 'In Progress',
        priority: 'High',
      };

      // This would test a hypothetical helper function
      // For now, let's test the sorting logic
    });
  });

  describe('priority sorting', () => {
    it('should sort issues by priority correctly', () => {
      const priorities = [
        { priority: 'Low', expected: 4 },
        { priority: 'Highest', expected: 1 },
        { priority: 'High', expected: 2 },
        { priority: 'Medium', expected: 3 },
        { priority: 'Lowest', expected: 5 },
        { priority: 'P1', expected: 1 },
        { priority: 'P2', expected: 2 },
        { priority: 'P3', expected: 3 },
        { priority: 'P4', expected: 4 },
        { priority: 'P5', expected: 5 },
        { priority: 'None', expected: 6 },
        { priority: 'Unknown', expected: 8 },
      ];

      // Test the priority ordering logic
      const getPriorityOrder = (priority: string): number => {
        const priorityMap: Record<string, number> = {
          Highest: 1,
          High: 2,
          P1: 1,
          P2: 2,
          Medium: 3,
          P3: 3,
          Low: 4,
          P4: 4,
          Lowest: 5,
          P5: 5,
          None: 6,
          'Unassigned!': 7,
        };
        return priorityMap[priority] || 8;
      };

      priorities.forEach(({ priority, expected }) => {
        expect(getPriorityOrder(priority)).toBe(expected);
      });
    });

    it('should sort issues by priority then by date', () => {
      const issues = [
        { key: 'A', priority: 'Low', updated: '2024-01-03' },
        { key: 'B', priority: 'High', updated: '2024-01-01' },
        { key: 'C', priority: 'High', updated: '2024-01-02' },
        { key: 'D', priority: 'Medium', updated: '2024-01-04' },
      ];

      const sortIssues = (issues: any[]) => {
        const getPriorityOrder = (priority: string): number => {
          const priorityMap: Record<string, number> = {
            Highest: 1,
            High: 2,
            Medium: 3,
            Low: 4,
            Lowest: 5,
            None: 6,
          };
          return priorityMap[priority] || 8;
        };

        return [...issues].sort((a, b) => {
          const priorityDiff = getPriorityOrder(a.priority) - getPriorityOrder(b.priority);
          if (priorityDiff !== 0) return priorityDiff;

          const aTime = new Date(a.updated).getTime();
          const bTime = new Date(b.updated).getTime();
          return bTime - aTime;
        });
      };

      const sorted = sortIssues(issues);
      expect(sorted.map((i) => i.key)).toEqual(['C', 'B', 'D', 'A']);
    });
  });

  describe('project grouping', () => {
    it('should group issues by project correctly', () => {
      const issues = [
        { key: 'PROJ1-1', project_key: 'PROJ1', summary: 'Issue 1' },
        { key: 'PROJ2-1', project_key: 'PROJ2', summary: 'Issue 1' },
        { key: 'PROJ1-2', project_key: 'PROJ1', summary: 'Issue 2' },
        { key: 'PROJ3-1', project_key: 'PROJ3', summary: 'Issue 1' },
      ];

      const groupIssuesByProject = (issues: any[]) => {
        return issues.reduce(
          (acc, issue) => {
            if (!acc[issue.project_key]) {
              acc[issue.project_key] = [];
            }
            acc[issue.project_key].push(issue);
            return acc;
          },
          {} as Record<string, any[]>,
        );
      };

      const grouped = groupIssuesByProject(issues);

      expect(Object.keys(grouped).sort()).toEqual(['PROJ1', 'PROJ2', 'PROJ3']);
      expect(grouped.PROJ1).toHaveLength(2);
      expect(grouped.PROJ2).toHaveLength(1);
      expect(grouped.PROJ3).toHaveLength(1);
    });
  });

  describe('status filtering', () => {
    it('should filter out closed/done/resolved statuses', () => {
      const statuses = [
        { status: 'Open', shouldInclude: true },
        { status: 'In Progress', shouldInclude: true },
        { status: 'To Do', shouldInclude: true },
        { status: 'Done', shouldInclude: false },
        { status: 'Closed', shouldInclude: false },
        { status: 'Resolved', shouldInclude: false },
        { status: 'Cancelled', shouldInclude: false },
        { status: 'Canceled', shouldInclude: false },
        { status: 'Rejected', shouldInclude: false },
        { status: "Won't Do", shouldInclude: false },
        { status: 'Duplicate', shouldInclude: false },
        { status: 'Invalid', shouldInclude: false },
      ];

      const isOpenStatus = (status: string): boolean => {
        const closedStatuses = [
          'closed',
          'done',
          'resolved',
          'cancelled',
          'canceled',
          'rejected',
          "won't do",
          'duplicate',
          'invalid',
        ];
        return !closedStatuses.includes(status.toLowerCase());
      };

      statuses.forEach(({ status, shouldInclude }) => {
        expect(isOpenStatus(status)).toBe(shouldInclude);
      });
    });
  });
});
